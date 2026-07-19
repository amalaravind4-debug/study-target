-- Safe to run against your EXISTING, already-deployed Supabase project.
-- Nothing here is destructive — it only creates things "if not exists".
--
-- Why no real schema change is needed: upsc_sync is a generic key-value
-- store (sync_code, scope, key, value). Every feature added since the first
-- deploy — per-profile daily topic choices, total-time-studied, per-day/
-- per-slot time breakdowns (for the progress charts), and revision notes —
-- just uses new "key" values inside the SAME table, scoped by profile
-- ('psir' or 'malayalam') exactly like 'progress' already was. No new
-- columns, no new tables, nothing to migrate.
--
-- This script just (a) re-confirms the table/policy exist in case you're
-- setting this up fresh, and (b) adds a lookup index now that each
-- profile has more keys than before, so reads/writes stay fast.

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

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'upsc_sync' and policyname = 'allow anon all'
  ) then
    create policy "allow anon all" on upsc_sync for all using (true) with check (true);
  end if;
end $$;

create index if not exists idx_upsc_sync_lookup on upsc_sync (sync_code, scope);

-- Optional but recommended: confirms the keys now in use, for your own reference.
-- scope = 'shared'  -> keys: settings, currentDay
-- scope = 'psir'    -> keys: progress, subjectOrder, dayChoice, optChoice, totalSeconds,
--                             dailySlotSeconds, notes
-- scope = 'malayalam' -> keys: progress, subjectOrder, dayChoice, optChoice, totalSeconds,
--                             dailySlotSeconds, notes
