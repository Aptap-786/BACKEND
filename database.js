// database.js — MySQL Connection & Query Helpers
'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

let pool = null;

/**
 * Initialize the connection pool
 */
function initPool() {
  if (!pool) {
    pool = mysql.createPool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '3306'),
      user:     process.env.DB_USER     || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'whatsapp_otp_gateway',
      waitForConnections: true,
      connectionLimit:    10,
      queueLimit:         0,
      timezone:           '+00:00',
    });
    console.log('[DB] Connection pool initialised');
  }
  return pool;
}

/**
 * Execute a query with optional params
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Array>} rows
 */
async function query(sql, params = []) {
  const db = initPool();
  const [rows] = await db.execute(sql, params);
  return rows;
}

/**
 * Ensure all required tables exist (run once at startup)
 */
async function ensureSchema() {
  const db = initPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100)  NOT NULL UNIQUE,
      password_hash VARCHAR(255)  NOT NULL,
      role          ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
      created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      session_name VARCHAR(50)  NOT NULL UNIQUE,
      phone_number VARCHAR(30)  DEFAULT NULL,
      status       ENUM('disconnected','qr_pending','connected','error') NOT NULL DEFAULT 'disconnected',
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS otp_logs (
      id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      otp_code       VARCHAR(20)   NOT NULL,
      message        TEXT          NOT NULL,
      sender_number  VARCHAR(50)   NOT NULL,
      session_name   VARCHAR(50)   NOT NULL,
      created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created (created_at),
      INDEX idx_session (session_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      api_key      VARCHAR(255) NOT NULL,
      backend_url  VARCHAR(255) NOT NULL DEFAULT '',
      updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('[DB] Schema verified / created');
}

module.exports = { query, initPool, ensureSchema };
