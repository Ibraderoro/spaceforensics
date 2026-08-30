-- ---------------------------------------------------------------------------
-- Migration 001 — Investigation Persistence Schema
-- Phase 8.2 — SpaceForensics
--
-- Creates all tables required to persist the Investigation operational layer.
-- Safe to run multiple times (all statements use CREATE TABLE IF NOT EXISTS).
--
-- Tables:
--   investigations          — one row per investigation
--   investigation_events    — append-only lifecycle event log
--   observations            — one row per analyst observation
--   observation_versions    — append-only text version history
--   observation_evidence    — evidence_id citations (M:N, read-only ref)
--   observation_hypotheses  — hypothesis_id citations (M:N, read-only ref)
--   challenges              — one row per analyst challenge
--   challenge_lifecycle     — append-only status transition log
--   challenge_evidence      — supporting evidence_id citations (M:N, read-only ref)
--
-- FORENSIC BOUNDARY:
--   No table stores evidence rows, values, timestamps, or any field from the
--   forensic analysis pipeline.  Evidence IDs are stored as opaque text
--   references only.  causal_attribution_established is never stored here.
--
-- Identifier convention:
--   All primary keys are UUID v4 strings, generated in application code (STORE-2).
--   No SERIAL / IDENTITY columns are used for business identifiers.
-- ---------------------------------------------------------------------------

-- Track applied migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       TEXT        NOT NULL PRIMARY KEY,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- investigations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investigations (
  investigation_id  TEXT        NOT NULL PRIMARY KEY,   -- UUID v4, app-generated
  case_id           TEXT        NOT NULL,               -- STORE-1: always case-scoped
  title             TEXT        NOT NULL,
  description       TEXT,
  opened_by         TEXT,
  opened_at         TIMESTAMPTZ NOT NULL,               -- app-generated, stored as-is
  status            TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'suspended', 'closed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()  -- row insert time (metadata only)
);

CREATE INDEX IF NOT EXISTS investigations_case_id_idx
  ON investigations (case_id);

-- ---------------------------------------------------------------------------
-- investigation_events
-- Append-only lifecycle event log (opened / suspended / closed / resumed /
-- re-opened).  Corresponds to the `events` array on the investigation record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investigation_events (
  id            BIGSERIAL   NOT NULL PRIMARY KEY,       -- internal ordering key only
  investigation_id TEXT     NOT NULL
                REFERENCES investigations (investigation_id) ON DELETE CASCADE,
  event         TEXT        NOT NULL,
  actor         TEXT,
  event_at      TIMESTAMPTZ NOT NULL,                   -- app-generated ISO timestamp
  reason        TEXT,
  inserted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS investigation_events_investigation_id_idx
  ON investigation_events (investigation_id);

-- ---------------------------------------------------------------------------
-- observations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observations (
  observation_id    TEXT        NOT NULL PRIMARY KEY,   -- UUID v4
  investigation_id  TEXT        NOT NULL
                    REFERENCES investigations (investigation_id) ON DELETE CASCADE,
  authored_by       TEXT,
  authored_at       TIMESTAMPTZ NOT NULL,               -- app-generated
  status            TEXT        NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published', 'superseded', 'deleted'))
);

CREATE INDEX IF NOT EXISTS observations_investigation_id_idx
  ON observations (investigation_id);

-- ---------------------------------------------------------------------------
-- observation_versions
-- Append-only text history. Each edit appends a new row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_versions (
  id             BIGSERIAL   NOT NULL PRIMARY KEY,
  observation_id TEXT        NOT NULL
                 REFERENCES observations (observation_id) ON DELETE CASCADE,
  version        INTEGER     NOT NULL,
  text           TEXT        NOT NULL DEFAULT '',
  authored_by    TEXT,
  authored_at    TIMESTAMPTZ NOT NULL,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (observation_id, version)
);

CREATE INDEX IF NOT EXISTS observation_versions_obs_id_idx
  ON observation_versions (observation_id);

-- ---------------------------------------------------------------------------
-- observation_evidence
-- Stores the evidence_id references cited in an observation (read-only refs).
-- STORE-4: these are opaque string references — no evidence data is stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_evidence (
  observation_id TEXT NOT NULL
                 REFERENCES observations (observation_id) ON DELETE CASCADE,
  evidence_id    TEXT NOT NULL,
  PRIMARY KEY (observation_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- observation_hypotheses
-- Stores the hypothesis_id references cited in an observation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS observation_hypotheses (
  observation_id TEXT NOT NULL
                 REFERENCES observations (observation_id) ON DELETE CASCADE,
  hypothesis_id  TEXT NOT NULL,
  PRIMARY KEY (observation_id, hypothesis_id)
);

-- ---------------------------------------------------------------------------
-- challenges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenges (
  challenge_id       TEXT        NOT NULL PRIMARY KEY,  -- UUID v4
  investigation_id   TEXT        NOT NULL
                     REFERENCES investigations (investigation_id) ON DELETE CASCADE,
  case_id            TEXT,                              -- CH-1: case-scoped
  target_type        TEXT        NOT NULL
                     CHECK (target_type IN (
                       'hypothesis_assessment',
                       'evidence_classification',
                       'limitation',
                       'missing_evidence',
                       'additional_investigation'
                     )),
  target_id          TEXT        NOT NULL,
  authored_by        TEXT,
  created_at         TIMESTAMPTZ NOT NULL,              -- app-generated
  analyst_statement  TEXT        NOT NULL DEFAULT '',
  status             TEXT        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'under_review', 'resolved', 'rejected')),
  -- resolution_metadata fields (null until resolved)
  resolution_outcome TEXT        CHECK (resolution_outcome IN (
                       'acknowledged', 'will_not_fix', 'escalated'
                     )),
  resolution_notes   TEXT,
  resolved_by        TEXT,
  resolved_at        TIMESTAMPTZ,
  inserted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS challenges_investigation_id_idx
  ON challenges (investigation_id);

CREATE INDEX IF NOT EXISTS challenges_case_id_idx
  ON challenges (case_id);

-- ---------------------------------------------------------------------------
-- challenge_lifecycle
-- Append-only status transition log. Corresponds to the `lifecycle` array.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenge_lifecycle (
  id           BIGSERIAL   NOT NULL PRIMARY KEY,
  challenge_id TEXT        NOT NULL
               REFERENCES challenges (challenge_id) ON DELETE CASCADE,
  status       TEXT        NOT NULL,
  actor        TEXT,
  transition_at TIMESTAMPTZ NOT NULL,                   -- app-generated
  notes        TEXT,
  inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS challenge_lifecycle_challenge_id_idx
  ON challenge_lifecycle (challenge_id);

-- ---------------------------------------------------------------------------
-- challenge_evidence
-- Supporting evidence_id references cited in a challenge (read-only refs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenge_evidence (
  challenge_id TEXT NOT NULL
               REFERENCES challenges (challenge_id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL,
  PRIMARY KEY (challenge_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Record this migration.
-- ---------------------------------------------------------------------------
INSERT INTO schema_migrations (version)
VALUES ('001_create_investigations')
ON CONFLICT (version) DO NOTHING;
