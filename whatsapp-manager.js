// whatsapp-manager.js — Multi-session WhatsApp manager
'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const { query }     = require('./database');
const { detectOTP, isOTPMessage } = require('./otp-detector');

// In-memory store: sessionName => { client, status, qrData, phone }
const sessions = new Map();

// Sessions directory (whatsapp-web.js LocalAuth stores data here)
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/**
 * Save / update session row in DB
 */
async function persistSession(sessionName, status, phoneNumber = null) {
  try {
    await query(
      `INSERT INTO whatsapp_sessions (session_name, status, phone_number)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), phone_number = COALESCE(VALUES(phone_number), phone_number)`,
      [sessionName, status, phoneNumber]
    );
  } catch (err) {
    console.error(`[WA] DB persist error for ${sessionName}:`, err.message);
  }
}

/**
 * Save OTP log to DB
 */
async function saveOTPLog(otpCode, message, senderNumber, sessionName) {
  try {
    await query(
      `INSERT INTO otp_logs (otp_code, message, sender_number, session_name)
       VALUES (?, ?, ?, ?)`,
      [otpCode, message, senderNumber, sessionName]
    );
    console.log(`[OTP] Saved — session: ${sessionName}, code: ${otpCode}, from: ${senderNumber}`);
  } catch (err) {
    console.error('[OTP] Save error:', err.message);
  }
}

/**
 * Create and start a new WhatsApp session
 * @param {string} sessionName  e.g. "wa1"
 * @returns {Promise<{qr: string}>}  resolves with base64 QR image once QR is ready
 */
function createSession(sessionName) {
  return new Promise(async (resolve, reject) => {
    if (sessions.has(sessionName)) {
      return reject(new Error(`Session "${sessionName}" already exists`));
    }

    const maxSessions = parseInt(process.env.MAX_SESSIONS || '10');
    if (sessions.size >= maxSessions) {
      return reject(new Error(`Maximum sessions (${maxSessions}) reached`));
    }

    console.log(`[WA] Creating session: ${sessionName}`);

    const sessionObj = {
      client:  null,
      status:  'initialising',
      qrData:  null,
      phone:   null,
    };
    sessions.set(sessionName, sessionObj);

    await persistSession(sessionName, 'disconnected');

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId:   sessionName,
        dataPath:   SESSIONS_DIR,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
        ],
      },
    });

    sessionObj.client = client;

    let qrResolved = false;

    // ── QR Code ──────────────────────────────────────────────────────────────
    client.on('qr', async (qr) => {
      console.log(`[WA] QR ready for ${sessionName}`);
      try {
        const qrImage = await qrcode.toDataURL(qr);
        sessionObj.qrData = qrImage;
        sessionObj.status = 'qr_pending';
        await persistSession(sessionName, 'qr_pending');

        if (!qrResolved) {
          qrResolved = true;
          resolve({ qr: qrImage });
        }
      } catch (err) {
        if (!qrResolved) { qrResolved = true; reject(err); }
      }
    });

    // ── Authenticated ─────────────────────────────────────────────────────────
    client.on('authenticated', () => {
      console.log(`[WA] Authenticated: ${sessionName}`);
      sessionObj.status = 'connected';
      persistSession(sessionName, 'connected');
    });

    // ── Ready ─────────────────────────────────────────────────────────────────
    client.on('ready', async () => {
      console.log(`[WA] Ready: ${sessionName}`);
      sessionObj.status = 'connected';
      sessionObj.qrData = null; // clear QR once connected

      try {
        const info = client.info;
        if (info && info.wid) {
          sessionObj.phone = info.wid.user;
          await persistSession(sessionName, 'connected', info.wid.user);
        }
      } catch (_) {}

      // Resolve here too (covers LocalAuth re-use without new QR)
      if (!qrResolved) { qrResolved = true; resolve({ qr: null }); }
    });

    // ── Incoming messages ─────────────────────────────────────────────────────
    client.on('message', async (msg) => {
      if (msg.from === 'status@broadcast') return;
      if (msg.type !== 'chat') return;

      const body = msg.body || '';
      if (!isOTPMessage(body)) return;

      const otp = detectOTP(body);
      if (!otp) return;

      const sender = msg.from.replace('@c.us', '');
      await saveOTPLog(otp, body, sender, sessionName);
    });

    // ── Disconnected ──────────────────────────────────────────────────────────
    client.on('disconnected', async (reason) => {
      console.warn(`[WA] Disconnected ${sessionName}: ${reason}`);
      sessionObj.status = 'disconnected';
      await persistSession(sessionName, 'disconnected');

      // Auto-reconnect after 10 s
      setTimeout(() => {
        console.log(`[WA] Auto-reconnecting ${sessionName}…`);
        client.initialize().catch(e => {
          console.error(`[WA] Reconnect failed ${sessionName}:`, e.message);
          sessionObj.status = 'error';
          persistSession(sessionName, 'error');
        });
      }, 10_000);
    });

    // ── Auth failure ──────────────────────────────────────────────────────────
    client.on('auth_failure', async (msg) => {
      console.error(`[WA] Auth failure ${sessionName}:`, msg);
      sessionObj.status = 'error';
      await persistSession(sessionName, 'error');
      if (!qrResolved) { qrResolved = true; reject(new Error('Auth failure: ' + msg)); }
    });

    // ── Start ─────────────────────────────────────────────────────────────────
    client.initialize().catch(err => {
      console.error(`[WA] Initialize error ${sessionName}:`, err.message);
      sessionObj.status = 'error';
      persistSession(sessionName, 'error');
      if (!qrResolved) { qrResolved = true; reject(err); }
    });
  });
}

/**
 * Remove (destroy) a session
 * @param {string} sessionName
 */
async function removeSession(sessionName) {
  const sessionObj = sessions.get(sessionName);
  if (!sessionObj) throw new Error(`Session "${sessionName}" not found`);

  try {
    if (sessionObj.client) {
      await sessionObj.client.destroy();
    }
  } catch (err) {
    console.warn(`[WA] Destroy warning ${sessionName}:`, err.message);
  }

  sessions.delete(sessionName);

  // Remove LocalAuth data folder
  const dataDir = path.join(SESSIONS_DIR, `session-${sessionName}`);
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  await query('DELETE FROM whatsapp_sessions WHERE session_name = ?', [sessionName]);
  console.log(`[WA] Session removed: ${sessionName}`);
}

/**
 * Return status snapshot of all sessions
 * @returns {Array<{name, status, phone, hasQr}>}
 */
function getSessionsStatus() {
  const list = [];
  for (const [name, obj] of sessions.entries()) {
    list.push({
      name,
      status:  obj.status,
      phone:   obj.phone,
      hasQr:   !!obj.qrData,
    });
  }
  return list;
}

/**
 * Return the current QR image (base64 data URL) for a session
 * @param {string} sessionName
 * @returns {string|null}
 */
function getQR(sessionName) {
  const obj = sessions.get(sessionName);
  return obj ? obj.qrData : null;
}

/**
 * Restore persisted sessions from DB on startup
 */
async function restoreSessionsFromDB() {
  try {
    const rows = await query(
      `SELECT session_name FROM whatsapp_sessions WHERE status IN ('connected','qr_pending')`
    );
    for (const row of rows) {
      console.log(`[WA] Restoring session: ${row.session_name}`);
      createSession(row.session_name).catch(err => {
        console.warn(`[WA] Restore failed for ${row.session_name}:`, err.message);
      });
    }
  } catch (err) {
    console.error('[WA] Restore error:', err.message);
  }
}

module.exports = {
  createSession,
  removeSession,
  getSessionsStatus,
  getQR,
  restoreSessionsFromDB,
};
