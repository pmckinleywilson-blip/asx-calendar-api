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

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Vercel, GitHub Secrets, Railway | Neon Postgres connection string |
| `GROQ_API_KEY` | Vercel, GitHub Secrets, Railway | Groq LLM API key |
| `OPENROUTER_API_KEY` | GitHub Secrets, Railway | OpenRouter API key (alternative LLM provider) |
| `LLM_MODEL` | GitHub Secrets | Override default model (e.g. `google/gemma-4-31b-it:free`) |
| `RESEND_API_KEY` | Vercel, GitHub Secrets | Email delivery |
| `INVITE_FROM_EMAIL` | GitHub Secrets | Sender email for calendar invites |

---

## LLM Provider

The pipeline supports two LLM providers via `scripts/lib/llm-client.js`:
- **Groq** (default): Fast, free tier with daily token limits (~100K tokens/day)
- **OpenRouter** (preferred): No daily token cap, free models available (Gemma 4 31B)

When both keys are set, OpenRouter is preferred. Falls back to Groq if OpenRouter fails.

Current model: `google/gemma-4-31b-it:free` on OpenRouter.

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

## Current State (as of April 9, 2026)

### Working
- Website deployed and accessible
- Database schema created with all tables
- 1,755 companies loaded
- Pipeline orchestrator (detect -> verify -> notify)
- Continuous poller deployed on Railway.app
- 3-tier status system in DB and frontend
- OpenRouter + Gemma 4 integration added
- Estimate.js generates PCP-based events for all companies
- Subscriber ICS calendar feeds

### Known Issues
1. **IR scraper finding very few events** — only a handful of companies returning events despite ~88 having IR URLs configured. Failing silently for most. Needs investigation.
2. **Website showing very few events** — consequence of issue #1 and potentially the pipeline not running successfully end-to-end.
3. **Hardcoded IR URLs are brittle** — URLs break when companies redesign their sites. Need a more dynamic approach (e.g. Google search for "[company] investor relations financial calendar", or crawling from the company homepage).
4. **Daily digest email reports success even when runs fail** — needs honest failure alerting so silent failures don't go unnoticed.
5. **OpenRouter/Gemma integration unverified end-to-end** — was set up but the session froze before confirming it works in production.
6. **Pipeline runs may be failing silently** — need to check recent GitHub Actions runs and Railway poller logs to confirm what's actually running.

### Open Questions
- Is the Railway poller currently running and healthy?
- Are GitHub Actions pipeline runs succeeding?
- How many events are actually in the database right now?
- Is OpenRouter being used, or is everything still hitting Groq (with its daily limits)?

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

---

## Session Continuity

This document should be updated at the end of every working session. Before closing a session, ask:

> "Update PROJECT.md with what we did and what's still open."

To start a new session, say:

> "Read PROJECT.md in the repo root. Pick up where we left off."
