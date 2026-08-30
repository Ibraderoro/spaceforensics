'use strict';

// ---------------------------------------------------------------------------
// db/migrate.js — Phase 8.2
//
// Applies pending SQL migration files in filename order.
// Safe to run multiple times — each migration is guarded by schema_migrations.
//
// Usage:
//   node backend/db/migrate.js
// or programmatically:
//   const { runMigrations } = require('./db/migrate');
//   await runMigrations(pool);
// ---------------------------------------------------------------------------

const fs   = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Apply all pending migrations from the migrations/ directory.
 * @param {import('pg').Pool} pool
 */
async function runMigrations(pool) {
  // Ensure schema_migrations exists (bootstraps the migration tracker).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        NOT NULL PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  const appliedVersions = new Set(applied.rows.map((r) => r.version));

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedVersions.has(version)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      // The SQL file itself inserts the migration record, but guard in case it doesn't.
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
        [version],
      );
      await client.query('COMMIT');
      console.log(`[migrate] applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`[migrate] failed on ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  require('dotenv').config();
  const { getPool } = require('./pool');
  const pool = getPool();

  runMigrations(pool)
    .then(() => {
      console.log('[migrate] all migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] error:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
