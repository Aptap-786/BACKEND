// server.js — WhatsApp OTP Gateway — Main Entry Point
'use strict';

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { ensureSchema } = require('./database');
const { restoreSessionsFromDB } = require('./whatsapp-manager');
const apiRoutes = require('./api-routes');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS — allow the frontend domain
const allowedOrigins = (process.env.FRONTEND_URL || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Render health checks, etc.)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));

// ─── Public routes ────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    service: 'WhatsApp OTP Gateway',
    version: '1.0.0',
    status:  'running',
    docs:    '/api/*',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API routes (auth enforced inside router) ─────────────────────────────────

app.use('/api', apiRoutes);

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error('[SERVER] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  try {
    // 1. Ensure DB schema
    await ensureSchema();

    // 2. Restore previously active sessions
    await restoreSessionsFromDB();

    // 3. Start HTTP server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n✅  WhatsApp OTP Gateway running on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(`   API:    http://localhost:${PORT}/api/\n`);
    });
  } catch (err) {
    console.error('[BOOTSTRAP] Fatal error:', err);
    process.exit(1);
  }
}

bootstrap();
