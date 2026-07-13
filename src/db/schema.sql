-- ============================================================================
-- Callback Tracker schema
-- Two concerns kept apart:
--   1. repair_orders  = read-only snapshots pulled from Tekmetric (overwritten each sync)
--   2. callback_items = OUR workflow (notes, completed, follow-ups) — never touched by sync
-- ============================================================================

-- Session store (used by connect-pg-simple for Google sign-in sessions)
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    varchar PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON user_sessions (expire);

-- ---------------------------------------------------------------------------
-- Repair orders: one row per Tekmetric RO id. Upserted every sync (newest wins).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_orders (
  tek_id           bigint PRIMARY KEY,          -- Tekmetric RO "id" (stable across reopen/repost)
  ro_number        integer NOT NULL,            -- repairOrderNumber (human-facing)
  shop_id          integer NOT NULL,
  status_id        integer NOT NULL,            -- 5 Posted, 6 Accounts Receivable
  posted_date      timestamptz,
  updated_date     timestamptz,
  service_writer_id integer,
  advisor_name     text,
  customer_id      bigint,
  customer_name    text,
  approved_cents   bigint NOT NULL DEFAULT 0,   -- sum of authorized job subtotals
  declined_cents   bigint NOT NULL DEFAULT 0,   -- sum of declined job subtotals
  synced_at        timestamptz NOT NULL DEFAULT now()
);
-- Used to dedupe by RO number (keep newest posted_date) and to filter by date/advisor.
CREATE INDEX IF NOT EXISTS idx_ro_number ON repair_orders (ro_number, posted_date DESC);
CREATE INDEX IF NOT EXISTS idx_ro_posted ON repair_orders (posted_date DESC);

-- ---------------------------------------------------------------------------
-- Callback items: the actual work list. One RO can have several over time
-- (initial call, then follow-up attempts). This is what the 3 tabs read from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS callback_items (
  id                 bigserial PRIMARY KEY,
  ro_tek_id          bigint NOT NULL REFERENCES repair_orders(tek_id) ON DELETE CASCADE,
  attempt            integer NOT NULL DEFAULT 1,
  kind               text NOT NULL DEFAULT 'initial',  -- 'initial' | 'followup'
  due_date           date,                             -- when a follow-up is due (null for initial)
  notes              text NOT NULL DEFAULT '',
  completed          boolean NOT NULL DEFAULT false,
  completed_by       text,
  completed_by_email text,
  completed_at       timestamptz,
  follow_up_date     date,                             -- set when completed WITH a follow-up scheduled
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cb_ro       ON callback_items (ro_tek_id);
CREATE INDEX IF NOT EXISTS idx_cb_open     ON callback_items (completed, kind);
-- Guarantee exactly one initial item per RO so re-syncing an RO never duplicates the callback.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cb_initial
  ON callback_items (ro_tek_id) WHERE kind = 'initial';

-- ---------------------------------------------------------------------------
-- Sync bookkeeping: remembers the last successful run so nightly syncs can be
-- incremental (only pull ROs changed since then) instead of re-pulling everything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_state (
  id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single-row table
  last_synced_at timestamptz,
  last_count     integer,
  last_run_at    timestamptz,
  last_error     text
);
INSERT INTO sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- People & access. Domain sign-in is automatic; this table only records
-- per-person overrides: who is a manager, and guest (out-of-domain) access.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_users (
  email       text PRIMARY KEY,
  display_name text,
  is_manager  boolean NOT NULL DEFAULT false,
  is_guest    boolean NOT NULL DEFAULT false,   -- true = granted access despite outside domain
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz
);
