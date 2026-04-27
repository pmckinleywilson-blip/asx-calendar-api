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
| `LLM_MODEL` | GitHub Secrets | Override default model (currently `google/gemma-4-31b-it`) |
| `RESEND_API_KEY` | Vercel, GitHub Secrets | Email delivery |
| `INVITE_FROM_EMAIL` | GitHub Secrets | Sender email for calendar invites |

---

## LLM Provider

The pipeline supports two LLM providers via `scripts/lib/llm-client.js`:
- **OpenRouter** (preferred): Uses the `openai` npm package with baseURL `https://openrouter.ai/api/v1`. No daily token cap on paid models. $10 credit balance added April 9, 2026.
- **Groq** (fallback): Uses `groq-sdk` package. Free tier with daily token limits (~100K tokens/day).

When both keys are set, OpenRouter is preferred. Falls back to Groq if OpenRouter fails.

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

## Current State (as of April 9, 2026 — session 2)

### Working
- Website deployed and accessible
- Database schema created with all tables
- 1,755 companies loaded
- Pipeline orchestrator (detect -> verify -> notify) with time budgets
- Continuous poller deployed on Railway.app
- 3-tier status system in DB and frontend
- Estimate.js generates PCP-based events for all companies (~3,500 estimated events in DB)
- Subscriber ICS calendar feeds
- **OpenRouter + Gemma 4 integration FIXED** — was broken since setup, now using `openai` npm package
- **Pipeline completes without timeout** — first successful full run in 42m24s

### Database State (April 9)
- ~3,500+ total events (almost all `estimated` from estimate.js)
- 5 `date_confirmed` events from IR scraper (WBC found 3, a couple others)
- 2 events from ASX announcements (TR8, KYP)
- **0 `confirmed` events** — no webcast URLs in any event yet
- Root cause: LLM pipeline was broken until this session (see below)

### What Was Fixed This Session
1. **OpenRouter integration (critical).** The `groq-sdk` hardcodes `/openai/v1/chat/completions` as its API path. With OpenRouter baseURL, this produced `https://openrouter.ai/api/v1/openai/v1/chat/completions` → 404. Switched to the `openai` npm package which uses the correct `/chat/completions` path.
2. **Pipeline timeout kills.** detect.js burned 35 min retrying 404s, leaving verify.js only 10 min before the 45-min timeout killed it. Fixed with: fail-fast on 404/401/403 (no retry), time budget for verify.js, and pipeline.js passes remaining budget.
3. **Rate limit handling.** Classification failures on rate limit were treating ALL announcements as "possible", flooding extraction with doomed calls. Now: skip batches on rate limit, detect OpenRouter per-day limit and abort early.
4. **Poller OpenRouter support.** poller.js now accepts `OPENROUTER_API_KEY` in addition to `GROQ_API_KEY`.
5. **Switched to paid Gemma 4 31B model.** Free-tier daily request cap was too low (~50 requests). Added $10 credits to OpenRouter and switched from `google/gemma-4-31b-it:free` to `google/gemma-4-31b-it` (paid, ~$1-3/month). Updated both the code default AND the `LLM_MODEL` GitHub Secret (the secret overrides code).

### Remaining Issues
1. **Hardcoded IR URLs are brittle** — URLs break when companies redesign their sites. Need a more dynamic approach.
2. **Daily digest email reports success even when runs fail** — needs honest failure alerting.
3. **Railway poller needs env var updates** — `OPENROUTER_API_KEY` and possibly `LLM_MODEL` need to be added in the Railway dashboard. May also need a manual redeploy to pick up the code fix.
### First Successful Pipeline Run (paid model)
- **Date:** April 9, 2026
- **Duration:** 43m34s (within 45-min timeout)
- detect.js: 392 announcements classified → 72 flagged → **3 events detected** (earnings)
- verify.js: 16/44 IR pages scraped → **4 events found** (earnings with dates)
- **7 new events written to DB in a single run**
- No rate limit errors, no daily cap issues

### Open Questions
- Does Railway auto-deploy from master, or does it need a manual trigger?
- What's the actual monthly OpenRouter cost once the pipeline is running on schedule?
- Can the pipeline process all tiers + full IR verification within 45 minutes? (Currently only gets through 1 of 2 tiers + 16/44 IR tickers)

---

## Suggested Next Steps (priority order)

### 1. Get Railway poller working (high — it's deployed but broken)
The poller code now supports OpenRouter, but the Railway deployment needs env var updates:
- Add `OPENROUTER_API_KEY` in the Railway dashboard
- Add `LLM_MODEL=google/gemma-4-31b-it` in the Railway dashboard
- Confirm Railway auto-deploys from master, or trigger a manual redeploy
- Check poller logs after deploy to confirm it's classifying announcements

The poller is the key to 100% announcement coverage (the scheduled pipeline only catches what's in the ASX API's 5-item window at scan time). Without it, we miss announcements on busy filing days.

### 2. Pipeline speed — fit all tiers + IR into 45 minutes (high)
Currently the pipeline only processes 1 of 2 scheduled tiers and 16/44 IR tickers before hitting the time budget. Options:
- **Increase GitHub Actions timeout** to 60 minutes (simple, but burns more CI minutes)
- **Parallelize LLM calls** — batch 3-5 concurrent classification requests instead of serial (biggest win, OpenRouter handles concurrent requests fine)
- **Split tiers across runs** — run ASX100 at one cron time, ASX101-300 at another, so each run has fewer companies
- **Reduce extraction delay** from 1.5s to 500ms for paid model (paid tier has higher rate limits)
- **Skip already-seen announcements in detect.js** — the poller's `seen_announcements` table could be reused to avoid re-classifying announcements the poller already processed

### 3. Dynamic IR URL discovery (medium — current URLs are breaking)
~88 hardcoded IR URLs in `ir-pages.js` break when companies redesign their sites. Approaches:
- **Google Custom Search API** — search `"[company name] investor relations financial calendar"` and cache the top result. Free tier: 100 queries/day.
- **Crawl from company homepage** — fetch the company's main website, use the LLM to find the IR/financial calendar link. More robust than hardcoded URLs.
- **ASX company page as anchor** — every ASX-listed company has a page at `asx.com.au/asx/share-price-research/company/[TICKER]` which often links to the company website. Start there.

### 4. Honest failure alerting (medium)
The daily digest and pipeline currently report success even when they accomplish nothing. Fix:
- Pipeline should exit non-zero if 0 events were classified (indicates LLM failure, not "no events")
- Daily digest should report the number of events it actually found, not just "sent"
- Consider a simple Slack/email webhook on pipeline failure

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
