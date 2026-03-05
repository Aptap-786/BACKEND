// api-routes.js — REST API Endpoints
'use strict';

const express = require('express');
const router  = express.Router();
const { query } = require('./database');
const {
  createSession,
  removeSession,
  getSessionsStatus,
  getQR,
} = require('./whatsapp-manager');

// ─── API Key Middleware ───────────────────────────────────────────────────────

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  const validKey = process.env.API_KEY;

  if (!validKey) {
    return res.status(500).json({ error: 'API_KEY not configured on server' });
  }

  if (!key || key !== validKey) {
    return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
  }

  next();
}

// Apply API key auth to every route in this router
router.use(requireApiKey);

// ─── Helper ───────────────────────────────────────────────────────────────────

function ok(res, data, extra = {}) {
  res.json({ success: true, ...extra, data });
}

function fail(res, message, status = 400) {
  res.status(status).json({ success: false, error: message });
}

// ─── GET /api/latest-otp ──────────────────────────────────────────────────────
// Returns the most recent OTP records (default 10)

router.get('/latest-otp', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10'), 50);
    const rows = await query(
      `SELECT id, otp_code, message, sender_number, session_name,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM otp_logs
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );
    ok(res, rows, { count: rows.length });
  } catch (err) {
    console.error('[API] /latest-otp error:', err.message);
    fail(res, 'Database error', 500);
  }
});

// ─── GET /api/history ─────────────────────────────────────────────────────────
// Returns last 50 OTP logs, optionally filtered by session

router.get('/history', async (req, res) => {
  try {
    const { session, limit: lim } = req.query;
    const limit = Math.min(parseInt(lim || '50'), 200);

    let sql = `
      SELECT id, otp_code, message, sender_number, session_name,
             DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM otp_logs
    `;
    const params = [];

    if (session) {
      sql += ' WHERE session_name = ?';
      params.push(session);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await query(sql, params);
    ok(res, rows, { count: rows.length });
  } catch (err) {
    console.error('[API] /history error:', err.message);
    fail(res, 'Database error', 500);
  }
});

// ─── GET /api/sessions ────────────────────────────────────────────────────────
// Returns all WhatsApp sessions with live status

router.get('/sessions', async (req, res) => {
  try {
    // Merge in-memory live status with DB records
    const dbRows = await query(
      `SELECT id, session_name, phone_number, status,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
       FROM whatsapp_sessions ORDER BY created_at ASC`
    );

    const liveMap = {};
    for (const s of getSessionsStatus()) {
      liveMap[s.name] = s;
    }

    const merged = dbRows.map(row => ({
      ...row,
      live_status: liveMap[row.session_name]?.status || row.status,
      phone:       liveMap[row.session_name]?.phone  || row.phone_number,
      has_qr:      liveMap[row.session_name]?.hasQr  || false,
    }));

    ok(res, merged, { count: merged.length });
  } catch (err) {
    console.error('[API] /sessions error:', err.message);
    fail(res, 'Database error', 500);
  }
});

// ─── GET /api/sessions/:name/qr ──────────────────────────────────────────────
// Returns the current QR code image for a session

router.get('/sessions/:name/qr', (req, res) => {
  const { name } = req.params;
  const qr = getQR(name);
  if (!qr) {
    return fail(res, 'No QR available for this session (already connected or not started)', 404);
  }
  ok(res, { qr });
});

// ─── POST /api/add-session ────────────────────────────────────────────────────
// Create a new WhatsApp session and return the QR code

router.post('/add-session', async (req, res) => {
  const { session_name } = req.body;

  if (!session_name || !/^[a-zA-Z0-9_-]{1,30}$/.test(session_name)) {
    return fail(res, 'Invalid session_name. Use 1–30 alphanumeric characters, underscores, or hyphens.');
  }

  try {
    const result = await createSession(session_name);
    ok(res, {
      session_name,
      qr: result.qr, // base64 data URL or null if already authenticated
      message: result.qr
        ? 'QR code generated. Scan with WhatsApp within 60 seconds.'
        : 'Session restored from saved auth (no QR needed).',
    });
  } catch (err) {
    console.error('[API] /add-session error:', err.message);
    fail(res, err.message);
  }
});

// ─── POST /api/remove-session ────────────────────────────────────────────────
// Remove a WhatsApp session

router.post('/remove-session', async (req, res) => {
  const { session_name } = req.body;

  if (!session_name) return fail(res, 'session_name is required');

  try {
    await removeSession(session_name);
    ok(res, { session_name, message: 'Session removed successfully.' });
  } catch (err) {
    console.error('[API] /remove-session error:', err.message);
    fail(res, err.message);
  }
});

// ─── POST /api/clear-otp ─────────────────────────────────────────────────────
// Delete OTP logs older than N days (default 7)

router.post('/clear-otp', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days || '7'));

  try {
    const result = await query(
      `DELETE FROM otp_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    ok(res, {
      deleted_rows: result.affectedRows,
      message: `Deleted OTP logs older than ${days} day(s).`,
    });
  } catch (err) {
    console.error('[API] /clear-otp error:', err.message);
    fail(res, 'Database error', 500);
  }
});

// ─── GET /api/stats ───────────────────────────────────────────────────────────
// Quick stats for the dashboard

router.get('/stats', async (req, res) => {
  try {
    const [[totalLogs]]     = await query('SELECT COUNT(*) AS n FROM otp_logs');
    const [[todayLogs]]     = await query(`SELECT COUNT(*) AS n FROM otp_logs WHERE DATE(created_at) = CURDATE()`);
    const [[totalSessions]] = await query('SELECT COUNT(*) AS n FROM whatsapp_sessions');
    const [[connected]]     = await query(`SELECT COUNT(*) AS n FROM whatsapp_sessions WHERE status = 'connected'`);

    ok(res, {
      total_otps:        totalLogs.n,
      today_otps:        todayLogs.n,
      total_sessions:    totalSessions.n,
      connected_sessions: connected.n,
    });
  } catch (err) {
    console.error('[API] /stats error:', err.message);
    fail(res, 'Database error', 500);
  }
});

// ─── GET /api/health ─────────────────────────────────────────────────────────
// Health check (no auth required — applied before this router)

module.exports = router;
