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

## Current State (as of April 27, 2026 — session 3)

### Working
- Website deployed and accessible at https://asx-calendar-api.vercel.app
- Database: 3,636 events (3,542 estimated, 94 date_confirmed, 0 confirmed)
- 1,755 companies loaded
- Pipeline running successfully on GitHub Actions — 5x daily on weekdays
- 8 of last 10 pipeline runs succeeded (~42 min each, now optimised)
- Health endpoint now reads from database (was reading static file before)
- Groq fallback code removed — OpenRouter is sole LLM provider
- Node.js 22 + actions v5 (ahead of June 2 deprecation deadline)

### What Was Done This Session (April 27)
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
2. **Hardcoded IR URLs are brittle** — URLs break when companies redesign their sites.
3. **Daily digest email reports success even when runs fail** — needs honest failure alerting.
4. **Railway poller status unknown** — needs env var updates in Railway dashboard. Trial credits running low (see below).

### Open Questions
- What's the actual monthly OpenRouter cost now that the pipeline is running on schedule?
- Is the poller actually running on Railway, or is it stopped/broken?
- With the pipeline speed improvements, can it now process all tiers + full IR verification within 60 minutes?

---

## Railway Poller Cost Analysis (April 27, 2026)

### Current Situation
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

### 1. Decide Railway poller future (high — trial expiring ~May 9)
Options detailed in "Railway Poller Cost Analysis" above. If keeping Railway:
- Upgrade to Hobby plan ($5/month) before trial expires
- Add `OPENROUTER_API_KEY` env var in Railway dashboard
- Add `LLM_MODEL=google/gemma-4-31b-it` env var
- Confirm auto-deploy picked up the latest code changes

### 2. Dynamic IR URL discovery (medium — current URLs are breaking)
~88 hardcoded IR URLs in `ir-pages.js` break when companies redesign their sites. Approaches:
- **Google Custom Search API** — search `"[company name] investor relations financial calendar"` and cache the top result. Free tier: 100 queries/day.
- **Crawl from company homepage** — fetch the company's main website, use the LLM to find the IR/financial calendar link.
- **ASX company page as anchor** — every ASX-listed company has a page at `asx.com.au/asx/share-price-research/company/[TICKER]` which often links to the company website.

### 3. Honest failure alerting (medium)
The daily digest and pipeline currently report success even when they accomplish nothing. Fix:
- Pipeline should exit non-zero if 0 events were classified (indicates LLM failure, not "no events")
- Daily digest should report the number of events it actually found, not just "sent"
- Consider a simple Slack/email webhook on pipeline failure

### 4. Get to confirmed events (medium — 0 confirmed so far)
94 events have confirmed dates but none have webcast URLs + times. Investigate:
- Are the LLM extraction prompts looking for webcast URLs correctly?
- Do ASX announcements actually contain webcast URLs, or are they on IR pages?
- May need to scrape IR pages closer to event date for webcast details

### 5. Website improvements (low — works but basic)
- Show event counts by status on the homepage ("X confirmed, Y date-confirmed, Z estimated")
- Add a "last pipeline run" timestamp so users know data freshness
- Filter/sort by status, date, sector
- Show which events are new since last visit

### 6. Cost monitoring (low — cheap but good to track)
- Check OpenRouter credit usage after a week of scheduled runs
- Set up a budget alert on OpenRouter if available
- Track tokens consumed per pipeline run (the LLM response includes usage metadata)

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
