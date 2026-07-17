# 300-Day UPSC Prep Ledger — Vite + Vercel

A Vite-built static app (no server, no backend of its own). Cloud sync is optional
and goes through Supabase directly from the browser.

## Local development

```
npm install
cp .env.example .env      # fill in the three values, or leave blank for local-only mode
npm run dev
```

## One-time Supabase setup (only needed if you want cross-device sync)

1. Create a free project at supabase.com.
2. Open the SQL Editor and run:

```sql
create table upsc_sync (
  id bigint generated always as identity primary key,
  sync_code text not null,
  scope text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz default now(),
  unique (sync_code, scope, key)
);
alter table upsc_sync enable row level security;
create policy "allow anon all" on upsc_sync for all using (true) with check (true);
```

If you already ran this before, you don't need to run it again for the
new features below — but `supabase-migration.sql` (next to this file)
is safe to re-run any time and adds a lookup index.

### New: daily topic picks + total-study stopwatch (no schema change needed)

Each day's GS/Optional cards now have a "Choose today's topic" button —
pick any subject+topic from the full syllabus (or the optional list) for
that specific day instead of following the auto-generated 220-day order.
This is saved per profile, so you and your partner pick independently,
and it syncs the same way `progress`/`subjectOrder` already do. There's
also a Total Time Studied stopwatch (separate from the five per-slot
countdowns) that tracks cumulative seconds studied per profile.

Both features reuse the existing `upsc_sync` table (it's a generic
key/value store), just under two new `key` values — run
`supabase-migration.sql` if you want the extra lookup index, but it's
optional; sync will work without it.

3. In Supabase → Project Settings → API, copy the **Project URL** and the
   **anon/public key**. This key is meant to be exposed client-side — the RLS
   policy above (not secrecy) is what controls access. Since the policy is wide
   open, treat your sync code like a shared password: make it long and
   unguessable, not "test" or "1234".

## Deploy to Vercel

1. Push this folder to a GitHub repo (or `vercel deploy` directly from here with the CLI).
2. In Vercel: Add New → Project → Import the repo. Vite is auto-detected —
   build command `vite build`, output directory `dist`. No vercel.json needed.
3. Before (or after) the first deploy, go to Project Settings → Environment
   Variables and add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_SYNC_CODE`
4. Deploy (or redeploy, if you added the variables after the first deploy —
   Vite bakes them in at build time, so a change requires a fresh build).

Once live, open the same URL on both devices. No manual entry needed — the
app reads the three variables automatically. Settings → Cloud Sync still lets
either of you override them locally if you ever want to.

Without any Supabase variables set, the app works exactly the same but keeps
each device's progress local to that browser (localStorage) — nothing breaks,
you just don't get cross-device sync.
