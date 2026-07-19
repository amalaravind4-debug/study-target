# 300-Day UPSC Prep Ledger — Vite + Vercel

A Vite-built static app (no server, no backend of its own). Cloud sync is optional
and goes through Supabase directly from the browser. It's also an installable PWA.

## Local development

```
npm install
cp .env.example .env      # fill in the three values, or leave blank for local-only mode
npm run dev
```

## What's new in this update

- **Full Mains GS coverage** — added World History, Indian Society, Governance,
  Social Justice, International Relations, Internal Security, and Disaster
  Management (60 more content-days). The plan is now **360 days total**, not 300 —
  genuinely more syllabus needs more time. Reorder/trim any subject from
  Settings → Reorder if you'd rather compress it back down.
- **Background/screen-off-safe timers** — rewritten to compute remaining time from
  wall-clock timestamps rather than counting ticks. A throttled or fully suspended
  background tab will catch up and show the correct time the instant you return to
  it, instead of drifting. Full honesty: no website can guarantee a sound/alert with
  the screen fully off or the tab fully closed the way a native alarm can — see the
  PWA section below for what actually helps here.
- **Progress charts** — a new 📈 button opens: (1) a manually-adjustable day-range
  bar chart of minutes studied per day, and (2) a single-day breakdown by slot
  (GS/Optional/Answer Writing/Current Affairs/Revision). Both are per profile.
- **Revision notes** — a "Notes" card on each day, autosaves, and is surfaced back
  to you automatically inside the 1/3/7/28/90-day spaced revision list on the days
  it's due.
- **PWA-ready** — manifest, icons, and a service worker are included (see below).
- **Schema**: see `supabase-migration.sql` — safe to run on your already-deployed
  database. Still additive only; two more keys (`dailySlotSeconds`, `notes`) just
  ride the same key-value table as everything else.

## PWA install (Add to Home Screen)

Once deployed to a real HTTPS domain (Vercel gives you this automatically):

- **Android/Chrome**: visit the site, then use the browser menu → "Install app" /
  "Add to Home Screen". It'll behave like a standalone app (own icon, no address bar).
- **iOS/Safari**: Share button → "Add to Home Screen". iOS applies extra
  restrictions on background execution regardless of PWA status — installing it
  still gives you a full-screen app icon and better notification behavior than a
  browser tab, but Apple does not allow any website (installed or not) to guarantee
  background timers/alarms with the screen off.
- The included service worker (`public/sw.js`) enables offline loading of the app
  shell and relays timer-completion notifications through the OS notification
  system rather than just the in-page one — this is meaningfully more reliable on
  Android when the tab is merely backgrounded (not swiped away), but is not a
  substitute for a native alarm on either platform.
- Icons live in `public/icons/`; regenerate them (any image editor, or ask me) if
  you want your own branding instead of the placeholder "300" ledger mark.

## One-time Supabase setup (only needed if you want cross-device sync)

1. Create a free project at supabase.com.
2. Open the SQL Editor and run `supabase-migration.sql` from this folder (safe to
   re-run even if you already ran the original schema before).
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
