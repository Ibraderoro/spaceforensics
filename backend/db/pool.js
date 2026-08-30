'use strict';

// ---------------------------------------------------------------------------
// db/pool.js — Phase 8.2
//
// Shared PostgreSQL connection pool for the SpaceForensics backend.
//
// Usage:
//   const pool = require('./db/pool');
//   const { rows } = await pool.query('SELECT 1');
//
// Configuration (environment variables):
//   PG_HOST         — hostname or UNIX socket path  (default: localhost)
//   PG_PORT         — port                          (default: 5432)
//   PG_DATABASE     — database name                 (required)
//   PG_USER         — role                          (default: OS user)
//   PG_PASSWORD     — password                      (default: none)
//   PG_SSL          — 'true' to enable SSL          (default: false)
//   PG_MAX_CLIENTS  — pool size upper bound         (default: 10)
//
// The pool is created lazily on first require() and shared for the lifetime
// of the process.  Call pool.end() in test teardown to close all connections.
//
// FORENSIC BOUNDARY:
//   This module has no knowledge of evidence rows, evidence IDs, forensic
//   analysis, or AI outputs.  It is a pure connection-management utility.
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

let _pool = null;

/**
 * Returns the singleton Pool, creating it on first call.
 * Throws synchronously if PG_DATABASE is not set.
 */
function getPool() {
  if (_pool) return _pool;

  const database = process.env.PG_DATABASE;
  if (!database) {
    throw new Error(
      'PG_DATABASE environment variable is required to use the PostgreSQL repository. ' +
      'Set it to the target database name.',
    );
  }

  _pool = new Pool({
    host:     process.env.PG_HOST     || 'localhost',
    port:     parseInt(process.env.PG_PORT || '5432', 10),
    database,
    user:     process.env.PG_USER     || undefined,
    password: process.env.PG_PASSWORD || undefined,
    ssl:      process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max:      parseInt(process.env.PG_MAX_CLIENTS || '10', 10),
    idleTimeoutMillis:    30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Surface connection errors without crashing the process.
  _pool.on('error', (err) => {
    console.error('[db/pool] idle client error:', err.message);
  });

  return _pool;
}

/**
 * Replace the singleton pool — used in tests to inject a test-database pool.
 * @param {Pool|null} pool
 */
function setPool(pool) {
  _pool = pool;
}

module.exports = { getPool, setPool };
