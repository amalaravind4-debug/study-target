-- ============================================================
-- UPSC Prep Ledger — Supabase migration
-- Safe to run on your ALREADY-DEPLOYED project (idempotent).
-- ============================================================
--
-- Why this exists: the two new features (daily topic picks,
-- total-time-studied stopwatch) don't need new tables or columns.
-- upsc_sync is already a generic (sync_code, scope, key -> value)
-- store, and the app just writes two new "key" values into it:
--   key = 'topicChoices'  -> { "<day>": { gsKey, gsIdx, optIdx } }
--   key = 'studyTotal'    -> integer seconds
-- both scoped per profile (scope = 'psir' or 'malayalam'), exactly
-- like the existing 'progress' and 'subjectOrder' keys — so they
-- already sync separately for each of you under the same sync_code.
--
-- Run this anyway: it recreates the table/policy only if missing
-- (no-ops on an existing deploy) and adds a lookup index now that
-- more keys per profile are being read/written.
-- ============================================================

create table if not exists upsc_sync (
  id bigint generated always as identity primary key,
  sync_code text not null,
  scope text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  unique (sync_code, scope, key)
);

alter table upsc_sync enable row level security;

drop policy if exists "allow anon all" on upsc_sync;
create policy "allow anon all" on upsc_sync for all using (true) with check (true);

create index if not exists idx_upsc_sync_lookup on upsc_sync (sync_code, scope, key);

-- Nothing to backfill — topicChoices/studyTotal rows simply don't exist
-- yet for your sync_code, and the app treats a missing row as "no
-- override yet" / "0 seconds studied", which is exactly right.
