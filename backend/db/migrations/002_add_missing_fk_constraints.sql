-- ---------------------------------------------------------------------------
-- Migration 002 — Add missing FK constraints on challenges table
-- Phase 8 — SpaceForensics
--
-- Migration 001 created the challenges table with a REFERENCES clause, but
-- because CREATE TABLE IF NOT EXISTS is a no-op when the table already
-- exists, any database that had the table created before the FK was added to
-- the migration file is missing the constraint.
--
-- This migration adds the FK idempotently using DO blocks.
-- Safe to run multiple times.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- challenges.investigation_id → investigations.investigation_id ON DELETE CASCADE
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'challenges'::regclass
      AND contype = 'f'
      AND conname = 'challenges_investigation_id_fkey'
  ) THEN
    ALTER TABLE challenges
      ADD CONSTRAINT challenges_investigation_id_fkey
      FOREIGN KEY (investigation_id)
      REFERENCES investigations (investigation_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Record this migration.
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version)
VALUES ('002_add_missing_fk_constraints')
ON CONFLICT (version) DO NOTHING;
