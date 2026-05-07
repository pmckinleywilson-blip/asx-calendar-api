# ASX Calendar API

## What this is

A platform that tracks upcoming ASX company events (earnings webcasts, AGMs, investor days) and delivers them to subscribers as calendar invites. The goal is to let investors and their agents populate calendars **weeks in advance** with webcast details — not just find out on the day.

**Live site:** https://asx-calendar-api.vercel.app
**Repo:** https://github.com/pmckinleywilson-blip/asx-calendar-api

---

## Design Principles

1. **Reasoning, not keywords.** The LLM reads announcements holistically and reasons about whether they contain event information. No keyword matching, no regex-based classification.
2. **Primary sources only.** We use the ASX API and company IR pages directly. We ARE the aggregator — we don't rely on third-party financial data providers.
3. **Plan ahead.** The core use case is populating calendars 2-4 weeks before events, not finding webcast links on the day. Early detection of dates matters more than last-minute enrichment.

---

## Architecture

| Component | Runs on | Purpose |
|---|---|---|
| **Website + API** | Vercel | Next.js frontend, 13 API routes, ICS calendar feeds |
| **Database** | Neon Postgres | Events, subscribers, seen announcements, notification log |
| **Pipeline** (detect -> verify -> notify) | GitHub Actions | Scheduled event detection, IR verification, email notifications |
| **Continuous Poller** | Railway.app | Sweeps all companies every ~5 seconds for 100% announcement coverage |
| **Daily Digest** | GitHub Actions | Morning email summary of upcoming events |
| **Company Updater** | GitHub Actions | Weekly refresh of ASX company list (1,755 companies) |

---

## Event Status Hierarchy

Events progress through three tiers as better information becomes available. Higher-priority sources overwrite lower ones automatically via the upsert logic.

| Status | Label on site | Meaning | Typical source |
|---|---|---|---|
| `estimated` | "Estimated based on PCP" | Date inferred from prior corresponding period | `estimate.js` |
| `date_confirmed` | "Date confirmed, time TBC" | Date confirmed by company, time/webcast unknown | IR page or ASX announcement |
| `confirmed` | "Confirmed" | Date + time + webcast URL available | ASX announcement with full details |

**Source priority** (for upsert — higher number wins):
1. `estimated` (1)
2. `calendar_api` (2)
3. `company_ir` (3)
4. `press_release` (4)
5. `asx_announcement` (5)

---

## Pipeline Components

### Layer 1: Estimated Events (`scripts/estimate.js`)
- Generates 2 estimated events (HY + FY results) for every company
- Uses Australian reporting calendar patterns based on fiscal year end:
  - June 30 FY (majority): HY ~Feb, FY ~Aug
  - Sep 30 FY (banks): HY ~May, FY ~Nov
  - Mar 31 FY (MQG, XRO): FY ~May, HY ~Nov
  - Dec 31 FY (NEM, RMD): HY ~Aug, FY ~Feb
- No LLM needed — pure calendar logic
- Runs as Step 0 of every pipeline run

### Layer 2: IR Website Scrapers (`scripts/verify.js` + `scripts/lib/ir-pages.js`)
- ~88 companies have IR page URLs stored in `ir-pages.js`
- Fetches financial calendars from company investor relations pages
- LLM extracts event dates from unstructured HTML/text
- Produces `date_confirmed` events that override estimates

### Layer 3: ASX Announcement Scanning (`scripts/detect.js` + `scripts/poller.js`)
- **detect.js**: Tiered scanning via GitHub Actions (ASX100 daily, 101-300 MWF, 301-500 Mon/Thu)
- **poller.js**: Continuous sweep of ALL companies on Railway.app (~5 second cycles)
- Two-pass LLM: classify announcement titles -> deep-extract from relevant ones
- Reasoning-first prompts (the LLM reasons about what the announcement could contain, not keyword matching)
- Trading halts flagged as "possible" (can precede ad-hoc webcasts)

### Notification (`scripts/notify.js`)
- Sends ICS calendar invites via Resend email API
- Tracks sent notifications in `notification_log` table to prevent duplicates

### Daily Digest (`scripts/daily-digest.js`)
- Morning email summary of upcoming events for each subscriber's tickers

### Continuous Poller (`scripts/poller.js`)
- Runs on Railway.app, sweeps all companies every ~5 seconds
- Tracks seen `documentKey` IDs in `seen_announcements` table
- Only sends genuinely new (never-before-seen) announcements through the LLM pipeline
- Runs during ASX filing hours (7:00am - 8:00pm AEST, weekdays)

---

## ASX API Limitation

The Markit Digital API (`asx.api.markitdigital.com`) returns a **hard cap of 5 announcements per company** — no pagination, no date filtering, no workaround. The continuous poller compensates by sweeping every ~5 seconds, so announcements are captured before they get pushed off by newer filings. On a busy results day, a single company can file 7+ announcements in an hour, so fast polling is essential.

The official real-time feed is **ASX ComNews** (paid institutional product). We use the free API with fast polling instead.

---

## Database Schema

### `events` table
Core table. Unique constraint on `(ticker, event_date, event_type)`. Key fields:
- `ticker`, `company_name`, `event_type` (earnings/investor_day/conference/ad_hoc)
- `event_date`, `event_time`, `timezone` (defaults Australia/Sydney)
- `webcast_url`, `phone_number`, `phone_passcode`, `replay_url`
- `fiscal_period` (e.g. "HY2026", "FY2026")
- `source`, `source_url`, `status` (confirmed/date_confirmed/estimated)
- `ir_verified`, `notified_at`

### `subscribers` table
- `email`, `tickers` (JSON array), `calendar_type`, `feed_token` (UUID for ICS feed URL)

### `seen_announcements` table
- `document_key` (PRIMARY KEY), `ticker`, `title`, `announcement_date`
- Purges entries older than 90 days

### `notification_log` table
- Prevents duplicate emails. Unique on `(subscriber_id, event_id)`

### `ir_pages` table (added April 29, session 4)
Stores the IR URL for each ticker plus health metrics. Auto-created and seeded
on first `verify.js` run from the hardcoded `IR_URLS` map in `lib/ir-pages.js`.
- `ticker` (PK), `url`
- `last_checked_at`, `last_status` (`ok`/`http_error`/`no_events`/`parse_error`),
  `last_http_code`, `last_event_count`
- `consecutive_failures` (HTTP/network errors — triggers rediscovery at ≥3)
- `consecutive_no_events` (200 OK but 0 events extracted — triggers at ≥8)
- `discovered_via` (`seed` / `markit_about` / `manual`),
  `rediscovered_at`, `previous_url`

---

## IR URL Discovery System

The `ir_pages` table replaces the old hardcoded `IR_URLS` map as the source of
truth for IR page URLs (the map remains in `lib/ir-pages.js` as the seed and an
offline fallback).

**How it works:**
1. **Seed.** On first `verify.js` run, the table is auto-created and populated
   from the hardcoded map. After that, `verify.js` reads URLs from the DB.
2. **Track outcomes.** Each `scrapeIRPage()` call records its result against
   the ticker — HTTP status, event count, and either incrementing
   `consecutive_failures` or `consecutive_no_events` on a bad run.
3. **Auto-rediscover.** Before the next scrape attempt, if a ticker has hit
   the failure threshold (≥3 HTTP errors or ≥8 zero-event runs), the system
   tries to find a fresh URL via:
   - **Markit `/companies/{TICKER}/about`** for the canonical company website
     (every ASX-listed company is in this API).
   - **Homepage scrape** with realistic User-Agent.
   - **Heuristic link extraction** — anchors with hrefs matching
     `/investor`, `/shareholder`, `/ir`, `/financial-calendar` etc, scored
     against negative patterns (`/products`, `/careers`, etc).
4. **Persistence.** A successful rediscovery updates the `url` column,
   preserves the old one in `previous_url` for audit, and resets the failure
   counters. The in-memory `_urlMap` is updated too so the next scrape uses the
   new URL immediately.

**No LLM is used in discovery** — keeps it cheap enough to run on every verify
pass without bloating the OpenRouter bill. If the heuristic finds nothing, the
existing URL is left in place.

**Health reporting** — run `node scripts/ir-health.js` to see which URLs are
healthy, stale, or were auto-rediscovered. Add `--rediscover` to actively
re-run discovery against any flagged-stale ticker. Add `--rediscover-all` to
brute-force every ticker (useful if a wave of sites redesigned at once).

**Files involved:**
- `scripts/lib/ir-pages.js` — main scraper, now DB-aware. Exports
  `loadIRPages`, `recordScrapeOutcome`, `rediscoverStale`, `shouldRediscover`.
- `scripts/lib/ir-discovery.js` — Markit lookup + homepage heuristic.
- `scripts/ir-health.js` — CLI report and rediscovery driver.
- `scripts/verify.js` — calls `loadIRPages(sql)` at startup and threads `sql`
  through `scrapeIRPage(ticker, llmApiKey, sql)` so outcomes are tracked.

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel, GitHub Secrets, Railway | Neon Postgres connection string |
| `OPENROUTER_API_KEY` | GitHub Secrets, Railway | OpenRouter API key (sole LLM provider) |
| `LLM_MODEL` | GitHub Secrets | Override default model (currently `google/gemma-4-31b-it`) |
| `RESEND_API_KEY` | Vercel, GitHub Secrets | Email delivery |
| `INVITE_FROM_EMAIL` | GitHub Secrets | Sender email for calendar invites |

---

## LLM Provider

The pipeline uses **OpenRouter** as the sole LLM provider via `scripts/lib/llm-client.js`:
- Uses the `openai` npm package with baseURL `https://openrouter.ai/api/v1`
- No daily token cap on paid models
- $10 credit balance added April 9, 2026
- Groq fallback was removed in April 27 session (groq-sdk had path issues with non-Groq providers)

Current model: `google/gemma-4-31b-it` (paid) on OpenRouter. ~$0.14/M input, ~$0.40/M output tokens. Estimated cost: $1-3/month.

**Important:** The `LLM_MODEL` GitHub Secret overrides the code default. If you change the model in code, also update the secret via `gh secret set LLM_MODEL --body "model-name"`.

---

## Deployment

### Vercel (website + API)
- Auto-deploys from `master` branch
- Next.js 16, React 19, Tailwind CSS v4
- Cron triggers `/api/cron/update-companies` weekly

### Railway.app (continuous poller)
- Deploys from same repo using `Dockerfile.railway`
- Runs `node scripts/poller.js` as a worker (not a web service)
- Restart policy: on failure, max 10 retries
- Needs `DATABASE_URL` and `GROQ_API_KEY` (or `OPENROUTER_API_KEY`) env vars

### GitHub Actions (pipeline)
- Workflow: `.github/workflows/scrape.yml`
- Runs pipeline 4-hourly during AU market hours (weekdays)
- Runs daily digest at 7am AEST
- Updates company list on Mondays
- Has `permissions: contents: write` for auto-committing company data

---

## Current State (as of May 7, 2026 — session 5)

### Working
- **Railway poller upgraded to Hobby plan ($5/mo).** Trial was due to expire
  ~May 9; paid plan now active. Poller heartbeat verified live via direct
  query of `seen_announcements.first_seen_at` — last scan ~1.5 min before
  audit, ~30 scans/hour through ASX trading hours.
- **Vercel Git auto-deploy restored.** The integration was completely
  disconnected from GitHub — that's why every "auto-deploy" since early April
  had silently failed and every deploy required `vercel --prod` from CLI.
  Reconnected in the dashboard; verified with empty commit (build kicked
  off in 11 seconds). Going forward every push to `master` deploys.
- **Past events hidden from `/api/events` by default.** `getEventsFromDB`
  previously defaulted `date_from` to `'1900-01-01'`, so the homepage showed
  all 3,719 events including 81 past ones. Now defaults to `CURRENT_DATE`.
  The `?date_from=` query param remains an explicit override for historical
  lookups.
- **ICS endpoints now read from Postgres, not stale events.json.** The feed
  (`/api/feed/[token]`), bulk download (`/api/calendar/bulk`), single-event
  ICS (`/api/calendar/[id]`), and Gmail-link route had all been reading
  `loadEvents()` — a static JSON file with 34 records, 30 days old. They now
  query the DB. Subscriber feeds carry only future events (the underlying
  `getEventsByTickers()` already filters to `event_date >= CURRENT_DATE`).
- **Database: 3,719 events** — 169 `date_confirmed` (up 52 from 117 on Apr
  29), 3,550 `estimated`, **0 `confirmed`** (unchanged). 1,754 companies,
  3 subscribers (1 real), 15,165 `seen_announcements`. Pipeline running
  cleanly — 26 of 30 most recent runs successful (the few failures were all
  GitHub-infrastructure or Node-22-upgrade transients).

### What Was Done This Session (May 7)
1. **Status audit.** Confirmed pipeline healthy via `gh run list` (only 3
   failures + 1 cancel in last 50 runs, all GitHub-side or pre-Node-22
   upgrade). Confirmed Railway poller was alive via direct DB query of
   `seen_announcements.first_seen_at`. Confirmed Vercel last-deployment was
   8 days stale.
2. **Upgraded Railway to Hobby.** User upgraded in the Railway dashboard;
   confirmed `OPENROUTER_API_KEY` and `LLM_MODEL=google/gemma-4-31b-it`
   env vars still set. Poller continued sweeping uninterrupted.
3. **Fixed past-events bug.** `getEventsFromDB` in `src/lib/db.ts` now
   defaults `date_from` to `CURRENT_DATE` across all three query branches
   (tickers / search / default). Static-file fallback in `/api/events`
   route mirrors the same default. Verified live: `/api/events` returns
   3,638 events (was 3,719); `?date_from=2020-01-01` still returns the full
   3,719 via the override. Commit `81ceb28`.
4. **Restored Vercel Git auto-deploy.** Settings → Git showed "Connect
   GitHub Repository" — the integration was fully disconnected (root cause
   of the 30+ days of stale deploys, including the "stalled" auto-deploy
   noted on Apr 29). User reconnected via the dashboard; verified with an
   empty commit `fb20945` that triggered a Production build in 11 seconds.
5. **Switched ICS endpoints to DB.** `/api/feed/[token]`,
   `/api/calendar/bulk`, `/api/calendar/[id]`, and
   `/api/calendar/[id]/gmail` now query Postgres when `DATABASE_URL` is
   set, with `loadEvents()` retained as a fallback. The feed uses
   `getEventsByTickers()` which is already future-only by design.
   Verified live by smoke-testing IDs that only exist in the DB (e.g.
   `225805` returned ORI's HY2026 results ICS), and by fetching the real
   subscriber's feed and confirming 12 future events for their 5 tickers.
   Commit `5f84ad3`.
6. **Refactored `/api/events`.** Added `eventRowToItem()` and
   `getEventsByIdsFromDB()` helpers to `lib/db.ts`. The events route's
   row-to-item plumbing collapsed from ~25 lines to 4. All four ICS
   routes share the same mapper.

### Previous Session (April 29)

#### Working (as of April 29)
- Website redeployed (Vercel auto-deploy had stalled — manual `vercel --prod`
  pushed 22 days of commits live, including the database-backed `/api/health`).
- Railway poller back online — `OPENROUTER_API_KEY` was missing from Railway
  env vars (the Apr 27 Groq→OpenRouter migration removed the Groq fallback
  but the env update on Railway was outstanding). Poller is sweeping again.
- Database: 3,659 events (3,542 estimated, 117 date_confirmed, 0 confirmed),
  growing by ~23 date_confirmed events in the last 2 days.
- IR URL discovery system shipped — see "IR URL Discovery System" section above.

#### What Was Done This Session (April 29)
1. **Diagnosed Railway crash.** Worker was crashing on startup with
   `FATAL: OPENROUTER_API_KEY not set` × 10 retries → Railway marked the
   deployment Crashed. Cause: Apr 27 Groq removal made OpenRouter mandatory,
   but the Railway env had `GROQ_API_KEY` only.
2. **Fixed Railway env.** Added `OPENROUTER_API_KEY` and
   `LLM_MODEL=google/gemma-4-31b-it`. Confirmed poller resumed sweeping
   (1029-write catch-up batch on first restart, then steady-state).
3. **Discovered Vercel auto-deploy was stalled.** Last production deployment
   was 22 days old despite multiple pushes since. Manually triggered
   `vercel --prod` from CLI. Production now reflects all April commits.
   (Root cause finally diagnosed in session 5: Git integration was fully
   disconnected.)
4. **Built IR URL discovery system.** New `ir_pages` Postgres table tracks
   URL health and auto-rediscovers stale URLs without an LLM in the loop.
   See "IR URL Discovery System" above. Files added: `lib/ir-discovery.js`,
   `ir-health.js`. Files changed: `lib/ir-pages.js`, `verify.js`,
   `PROJECT.md`.

### Previous Session (April 27)

#### What Was Done This Session (April 27)
1. **Committed & pushed Groq→OpenRouter migration.** 13 files had been modified locally since April 9 but never committed. Removed `groq-sdk` dependency, deleted `groq-classify.js` and `src/lib/groq.ts`, renamed to `llm-classify.js`. Now pushed to origin.
2. **Fixed /api/health endpoint.** Was reading from static `events.json` (34 records) instead of the database (3,636 events). Now queries Postgres for live counts by status + last_update timestamp.
3. **Pipeline performance improvements.** Reduced LLM inter-call delay from 1500ms → 500ms (paid tier). Bumped GitHub Actions timeout from 45 → 60 min. Extended detect.js budget to 40 min, verify.js to 58 min base. Should cut runtime by ~30-40%.
4. **Node.js upgrade.** Updated all 3 workflow jobs from Node 20 → 22, actions/checkout v4 → v5, actions/setup-node v4 → v5. Updated Dockerfile.railway from node:20-slim → node:22-slim.
5. **Railway cost analysis.** Trial credits 50% consumed. See "Railway Poller Cost Analysis" section below.

### Database State (April 27)
- **3,636 total events** in Postgres
- 3,542 `estimated` (PCP-based dates from estimate.js)
- 94 `date_confirmed` (from IR scraper + ASX announcements — up from 7 on April 9)
- **0 `confirmed`** (still no events with webcast URL + time)
- Pipeline has been running successfully since April 9 — steady accumulation of date_confirmed events

### Remaining Issues
1. **0 confirmed events** — No events have reached full confirmed status (date + time + webcast URL). The pipeline detects dates but webcast details are rare in announcements.
2. **Daily digest email reports success even when runs fail** — needs honest failure alerting.
3. **IR scrape coverage is poor** — only 27 of 78 tracked IR pages (35%) return events; 40 are `no_events`, 10 are `http_error`. Auto-rediscovery is implemented but hasn't been actively triggered. Run `node scripts/ir-health.js --rediscover` to clean up.
4. **Some scheduled GH Actions runs miss their cron window.** May 7's 0:17 UTC run never fired (no infra error — schedule just got dropped). The Railway poller covers the gap, but post-Railway-replacement plans should account for missed runs.
5. **Estimated events not superseded by date_confirmed events.** Subscriber feed showed both an `estimated` MQG 2026-05-14 row AND a `date_confirmed` MQG 2026-05-07 row — the "true" date was found but the estimate wasn't retired. Probably a fiscal-period-matching gap in `upsertEvent`.

### Open Questions
- What's the actual monthly OpenRouter cost now that the pipeline is running on schedule?
- With the pipeline speed improvements, can it now process all tiers + full IR verification within 60 minutes? (Mostly yes — recent runs land 45-57 min, occasionally hit timeout.)

---

## Railway Poller Cost Analysis (April 27, 2026 — superseded May 7)

**Decision (May 7, session 5): Hobby plan ($5/month).** Trial was used 50%
in 18 days, projected burn ~$4.20/mo, so the $5/mo Hobby plan is sized
correctly with a small margin. Auto-deploy works, env vars are set, poller
is verified live. Long-term migration options (Fly.io ~$2/mo, or
replacing the poller with more frequent GH Actions cron — free) are
preserved below in case the $5/mo becomes worth optimising.

### Current Situation (historical, pre-decision)
- Railway trial: $5 one-time credit, **50% used (~$2.50)** after ~18 days
- Burn rate: ~$0.14/day → ~$4.20/month
- Trial expires ~May 9 (30 days from signup)
- After trial: Free plan gives only $1/month credit (not enough)

### Railway Resource Pricing
- CPU: $20/vCPU/month ($0.000463/vCPU-min)
- RAM: $10/GB/month ($0.000231/GB-min)
- Poller runs ~13 hours/day × 22 weekdays = ~286 hours/month
- Estimated usage: ~0.1 vCPU avg + ~128MB RAM = **~$1.30/month compute**
- But Railway Hobby plan minimum is **$5/month** (includes $5 credit)

### Alternatives Compared

| Option | Cost/month | Pros | Cons |
|---|---|---|---|
| **Railway Hobby** | $5 | Already deployed, simple | Most expensive option |
| **Fly.io** | ~$2 | Cheapest hosted option (shared-cpu-1x 256MB = $2.02/mo) | Migration effort, no free tier for new users |
| **Render free tier** | $0 | Free | 0.1 CPU, spins down on idle — bad for polling |
| **GitHub Actions cron** | $0 | Already running, unlimited minutes (public repo) | Can't poll every 5s; minimum ~15 min interval |
| **Hetzner/DO VPS** | ~$4-5 | Full control, can run anything | Ops overhead, overkill for one script |

### Recommendation
**Short term:** Upgrade Railway to Hobby ($5/month) when trial expires. It's already deployed and working.

**Medium term:** Consider replacing the poller with **more frequent GitHub Actions runs**. Since this is a public repo, GitHub Actions minutes are unlimited. Increasing from 5 runs/day to every 15-30 minutes during market hours would catch most announcements. The pipeline speed improvements from this session (500ms delays, 60-min timeout) make more frequent runs viable. This eliminates Railway entirely — **$0/month**.

**If maximum coverage is needed:** Migrate to **Fly.io** at $2/month — cheapest hosted option for an always-on worker.

---

## Suggested Next Steps (priority order)

### 1. Railway poller — RESOLVED (May 7, session 5)
Upgraded to Hobby plan ($5/month). Trial-expiry decision is no longer
pressing. Long-term cheaper alternatives (Fly.io ~$2/mo, or replacing the
poller with frequent GH Actions cron) remain in **Railway Poller Cost
Analysis** below if the $5/month becomes annoying.

### 2. Dynamic IR URL discovery — IMPLEMENTED (April 29, session 4)
Hardcoded IR URLs are now persisted in the `ir_pages` Postgres table with health
tracking, and stale URLs auto-rediscover via the Markit `/about` endpoint plus
HTML heuristics. See **IR URL Discovery System** section below for details.

**Remaining limitations:**
- LLM-based discovery is not implemented (kept off the hot path for cost). If
  the heuristic finds zero candidate links on a homepage (because the page is
  bot-blocked or JS-rendered), the existing URL is left in place for manual
  intervention.
- The heuristic sometimes prefers a parent IR page (e.g. `/shareholder-centre`)
  over the original deep-link (e.g. `/shareholder-centre/financial-calendar`).
  The LLM extractor still finds events from parent pages, so this is acceptable.

### 3. Honest failure alerting (medium)
The daily digest and pipeline currently report success even when they accomplish nothing. Fix:
- Pipeline should exit non-zero if 0 events were classified (indicates LLM failure, not "no events")
- Daily digest should report the number of events it actually found, not just "sent"
- Consider a simple Slack/email webhook on pipeline failure

### 4. Get to confirmed events (medium — 0 confirmed so far)
169 events have confirmed dates but none have webcast URLs + times. Investigate:
- Are the LLM extraction prompts looking for webcast URLs correctly?
- Do ASX announcements actually contain webcast URLs, or are they on IR pages?
- May need to scrape IR pages closer to event date for webcast details
- Concrete next move: run `node scripts/test-detect.js` against a known
  full-disclosure announcement (e.g. CBA or BHP results day) and inspect
  what the LLM extracts — likely a prompt sharpening, not an architectural
  problem.

### 5. Run IR rediscovery (low — quick win)
Only 35% of tracked IR pages currently return events. The auto-rediscovery
system shipped in session 4 will eventually clean this up via the failure
counters, but you can force it manually:
```
node scripts/ir-health.js              # see what's stale
node scripts/ir-health.js --rediscover # actively re-find URLs
```
No LLM cost. ~5-min job.

### 6. Estimated-event garbage collection (low)
When a `date_confirmed` event lands for the same fiscal period as an
`estimated` event with a different date, the estimated row should be
retired. Currently both linger (e.g. MQG HY2026 has both 2026-05-07
date_confirmed AND 2026-05-14 estimated). Fix in `upsertEvent` — match by
`(ticker, fiscal_period, event_type)` and delete/supersede stale estimates.

### 7. Website improvements (low — works but basic)
- Show event counts by status on the homepage ("X confirmed, Y date-confirmed, Z estimated")
- Add a "last pipeline run" timestamp so users know data freshness
- Filter/sort by status, date, sector
- Show which events are new since last visit

### 8. Cost monitoring (low — cheap but good to track)
- Check OpenRouter credit usage after a week of scheduled runs
- Set up a budget alert on OpenRouter if available
- Track tokens consumed per pipeline run (the LLM response includes usage metadata)
- Now also includes the Railway $5/mo Hobby fee — keep an eye on actual
  resource usage in the Railway dashboard to confirm we're inside the
  included credit and not bleeding past it.

---

## Key Decisions Made (and why)

| Decision | Rationale |
|---|---|
| Continuous polling every ~5s instead of cron | ASX API caps at 5 announcements per company. Fast polling ensures we see every announcement before it gets pushed off. |
| Railway.app for the poller | Free tier (500 hrs/month), runs in the cloud, doesn't affect user's machine. Only need ~220 hrs/month (market hours). |
| OpenRouter over Groq | Groq has a daily token limit (~100K) that exhausts within 1-2 pipeline runs. OpenRouter has no daily cap and offers free models. |
| 3-tier status (not 2) | "Confirmed" vs "tentative" was too coarse. Users need to know if the date is estimated, date-confirmed-but-no-time, or fully confirmed with webcast. |
| Reasoning-first LLM prompts | Keyword matching misses context (e.g. trading halts that precede webcasts). The LLM reasons about what the announcement could contain. |
| Primary sources only | We are the aggregator. Using third-party data providers defeats the purpose. ASX API + company IR pages only. |
| Deduplication by documentKey | Avoids re-processing the same announcement every sweep. Only genuinely new (never-seen-before) announcements go through the LLM. |
| `openai` package for OpenRouter, `groq-sdk` for Groq | The groq-sdk hardcodes `/openai/v1/` in its API path, which breaks non-Groq providers. The `openai` package uses the standard `/chat/completions` path and works with any OpenAI-compatible API. |
| Fail-fast on 404/401/403 | These HTTP errors mean "model doesn't exist" or "bad auth" — retrying wastes minutes per call and compounds across hundreds of companies. |
| Time budget for verify.js | Pipeline runs detect → verify → notify sequentially. Without a budget, verify.js can be killed mid-run by the GitHub Actions timeout, producing no results. |

---

## Session Continuity

This document should be updated at the end of every working session. Before closing a session, ask:

> "Update PROJECT.md with what we did and what's still open."

To start a new session, say:

> "Read PROJECT.md in the repo root. Pick up where we left off."
