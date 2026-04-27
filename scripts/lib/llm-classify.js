// ============================================================
// LLM Classification and Extraction (OpenRouter)
// Two-pass approach: batch classify titles, then deep extract from content.
// ============================================================

const { createClient, getModel } = require('./llm-client');

const MODEL_OVERRIDE = null; // set to override llm-client's default
const BATCH_SIZE = 25;
const MAX_RETRIES = 3;
const LLM_DELAY_MS = 500; // 500ms between batches — paid tier has higher rate limits

// Global flag: once we hit a daily token limit, skip all remaining LLM calls.
// This prevents the pipeline from burning 60 minutes retrying against a limit
// that won't reset for hours.
let _dailyLimitReached = false;

/**
 * Check if a 429 error is a daily/hard limit vs. a short-term rate limit.
 * Daily limits won't reset for minutes/hours — retrying is pointless.
 */
function isDailyLimit(err) {
  const msg = err.message || String(err);
  return msg.includes('tokens per day') || msg.includes('free-models-per-day');
}

/**
 * Returns true if the daily LLM budget has been exhausted.
 * Callers can check this to skip remaining LLM work.
 */
function isLLMBudgetExhausted() {
  return _dailyLimitReached;
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// JSON parsing helper — tolerates markdown fences and preamble text
// ---------------------------------------------------------------------------

function parseJsonFromLLM(raw) {
  let cleaned = raw.trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try parsing as-is first
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Fall through
  }

  // Find the outermost [ ... ] or { ... }
  const arrayStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');

  if (arrayStart !== -1) {
    const end = cleaned.lastIndexOf(']');
    if (end > arrayStart) {
      try {
        return JSON.parse(cleaned.slice(arrayStart, end + 1));
      } catch (_) {
        // Fall through
      }
    }
  }

  if (objStart !== -1) {
    const end = cleaned.lastIndexOf('}');
    if (end > objStart) {
      try {
        return JSON.parse(cleaned.slice(objStart, end + 1));
      } catch (_) {
        // Fall through
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM API call with retry and exponential backoff
// ---------------------------------------------------------------------------

async function callLLM(client, messages, attempt) {
  if (attempt === undefined) attempt = 1;

  // If we already know the daily limit is hit, fail fast
  if (_dailyLimitReached) {
    throw new Error('LLM daily token limit reached — skipping');
  }

  var model = MODEL_OVERRIDE || getModel();

  try {
    const completion = await client.chat.completions.create({
      model: model,
      temperature: 0,
      messages: messages,
    });

    const content = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : null;

    return content || '';
  } catch (err) {
    var status = err.status || 0;
    var msg = err.message || String(err);
    var isRateLimit = status === 429 || msg.includes('429');

    // Non-retryable errors — fail immediately, don't waste time
    if (status === 404 || status === 401 || status === 403) {
      console.log('  [llm] Non-retryable error (' + status + ') — check model name and API key');
      throw err;
    }

    // Daily limit (OpenRouter free-models-per-day) — don't retry
    if (isRateLimit && isDailyLimit(err)) {
      _dailyLimitReached = true;
      console.log('  [llm] DAILY LIMIT reached — aborting all remaining LLM calls');
      throw err;
    }

    if (attempt < MAX_RETRIES) {
      const backoffMs = isRateLimit
        ? Math.min(2000 * Math.pow(2, attempt), 30000)
        : 1000 * attempt;

      console.log('  [llm] Retry ' + attempt + '/' + MAX_RETRIES + ' after ' + backoffMs + 'ms — ' + (msg.substring(0, 200)));
      await delay(backoffMs);
      return callLLM(client, messages, attempt + 1);
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLASSIFICATION SYSTEM PROMPT
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `You are an expert ASX (Australian Securities Exchange) analyst.

GOAL: Identify announcements that either:
(a) contain information about an investor event (teleconference, webcast, results briefing, investor day, AGM), OR
(b) announce the DATE of an upcoming corporate event (results release date, reporting date, AGM date, investor day date) — even if no webcast or dial-in details are included yet.

Both are valuable. Webcast details let investors attend; dates let investors plan ahead. A date without webcast details is still useful — the webcast details typically follow closer to the event.

REASONING APPROACH — for EACH announcement, think about:
1. What is the PURPOSE of this announcement? Is it communicating results, strategy, an event, or a future date — or is it a purely administrative/compliance filing?
2. Does it mention a FUTURE DATE for results, a briefing, a presentation, an AGM, or an investor day?
3. Could the underlying corporate activity involve a live briefing? Results announcements almost always have an accompanying webcast.
4. Even if the title is generic, could the CONTENT contain dates, webcast URLs, dial-in numbers, or event logistics?

Companies communicate event information in many non-obvious ways:
- A "Shareholder Email" or "Shareholder Letter" may contain the webcast URL or announce a future results date
- A "Media Release" may embed conference call dial-in details at the bottom, or announce an upcoming results date
- An "Investor Presentation" PDF may have the webcast link on the cover page
- An Appendix 4D filing is often accompanied by a separate results briefing
- A "Financial Calendar" or "Key Dates" announcement lists upcoming reporting dates for the year
- A "Results Release Date" or "Notification of Reporting Dates" announcement sets the date for upcoming results
- A "Trading Halt" signals the company is about to make a material announcement — these are frequently followed by ad-hoc webcasts. Classify as "possible".
- An announcement with [price-sensitive] is more likely to involve a briefing than a routine filing

CLASSIFY each announcement:
- "relevant" — likely contains event/webcast details OR an upcoming event date
- "possible" — uncertain, but the corporate context suggests it could (e.g. trading halts, generic updates that might mention dates)
- "irrelevant" — purely administrative filing with no plausible connection to an investor event or date (e.g. substantial holder notices, director interest changes, daily share buy-back notices, cleansing notices, Appendix 3Y/3Z forms)

Return a JSON array: [{"index": 0, "classification": "relevant"}, ...]
Return ONLY JSON.`;

// ---------------------------------------------------------------------------
// EXTRACTION SYSTEM PROMPT
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM_PROMPT = `You are extracting investor event details from an ASX company announcement.

There are TWO types of information we want to capture:

TYPE 1 — EVENT WITH DETAILS: An investor event someone could attend, watch, or listen to (earnings briefing, investor day, conference call, AGM webcast). These have webcast URLs, dial-in numbers, times, or registration links.

TYPE 2 — DATE ONLY: An announcement of WHEN a future corporate event will occur (results release date, AGM date, investor day date), even if no webcast or dial-in details are provided yet. These dates let investors plan ahead — the webcast details typically follow closer to the event.

Both types are valuable. Extract whichever is present.

REASONING APPROACH:
1. Read the FULL content carefully. Webcast details are often buried at the bottom, in a footnote, or in a "For further information" section.
2. Distinguish between the REPORTING PERIOD end date and the EVENT date. "Half year ended 30 September 2025" means Sep 30 is the period end — the briefing/results date is when results are released or when the call is scheduled.
3. Look for ANY access method: webcast URLs (often viostream, webcast.openbriefing.com, or company-hosted), teleconference dial-in numbers, registration links, or references to a live Q&A.
4. Also look for DATE announcements: "results will be released on [date]", "AGM to be held on [date]", financial calendar listings, key dates for the year.
5. If the announcement references a presentation or briefing happening "today" or "at [time]", that's an event — extract it even if no URL is given.
6. A replay URL is still valuable — extract it. Investors use replays.
7. If the announcement lists MULTIPLE future dates (e.g. a financial calendar with HY results, FY results, AGM), return the NEAREST future date as the primary event. Mention the others in the description.

Return JSON:
{
  "has_event": true/false,
  "event_type": "earnings" | "investor_day" | "conference" | "ad_hoc",
  "event_date": "YYYY-MM-DD",
  "event_time": "HH:MM" (24-hour AEST) or null,
  "title": "short descriptive title",
  "webcast_url": "URL" or null,
  "replay_url": "URL" or null,
  "phone_number": "number" or null,
  "phone_passcode": "code" or null,
  "fiscal_period": "HY2026" or "FY2026" or null,
  "description": "one sentence summary" or null,
  "confidence": "high" | "medium" | "low"
}

RULES:
1. event_date = the date of the BRIEFING/RESULTS RELEASE, not the reporting period end date
2. Convert all times to AEST (UTC+10). AEDT = AEST+1, so subtract 1 hour
3. Webcast URLs should be from the company or their webcast provider — not news sites
4. If a date is mentioned but you cannot determine whether it is the event date or the period end date, set confidence to "low"
5. "has_event" = true if the announcement contains EITHER webcast/briefing details OR a future event date. Set to false only if there is no event information AND no future date.
6. If you have a date but no webcast/dial-in details, still return has_event: true with the date, and set webcast_url, phone_number etc. to null. The date alone is valuable.
7. Return ONLY JSON, no markdown or explanation`;

// ---------------------------------------------------------------------------
// classifyAnnouncements — Batch classify announcement titles via LLM
// ---------------------------------------------------------------------------

async function classifyAnnouncements(announcements, llmApiKey) {
  if (!announcements || announcements.length === 0) return [];

  const client = createClient(llmApiKey);
  const relevant = [];

  // Split into batches
  const batches = [];
  for (let i = 0; i < announcements.length; i += BATCH_SIZE) {
    batches.push(announcements.slice(i, i + BATCH_SIZE));
  }

  console.log('[llm] Classifying ' + announcements.length + ' announcements in ' + batches.length + ' batch(es)');

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log('  [llm] Batch ' + (b + 1) + '/' + batches.length + ' (' + batch.length + ' items)');

    // Build the list of announcements for the prompt — include all metadata
    // so the LLM can reason holistically about each announcement
    const lines = [];
    for (let i = 0; i < batch.length; i++) {
      const a = batch[i];
      var parts = i + '. [' + a.ticker + '] ' + a.title + ' (' + a.date + ')';
      if (a.announcement_type) parts += ' [type: ' + a.announcement_type + ']';
      if (a.market_sensitive) parts += ' [price-sensitive]';
      lines.push(parts);
    }

    const userPrompt = 'Classify these ASX announcements:\n\n' + lines.join('\n');

    try {
      const raw = await callLLM(client, [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]);

      const parsed = parseJsonFromLLM(raw);

      if (Array.isArray(parsed)) {
        let relevantCount = 0;
        let possibleCount = 0;

        for (let k = 0; k < parsed.length; k++) {
          const item = parsed[k];
          if (typeof item !== 'object' || item === null) continue;

          const idx = item.index;
          const classification = item.classification;

          if (typeof idx !== 'number' || idx < 0 || idx >= batch.length) continue;

          if (classification === 'relevant' || classification === 'possible') {
            const ann = batch[idx];
            ann.classification = classification;
            relevant.push(ann);

            if (classification === 'relevant') relevantCount++;
            else possibleCount++;
          }
        }

        console.log('    Results: ' + relevantCount + ' relevant, ' + possibleCount + ' possible, ' + (batch.length - relevantCount - possibleCount) + ' irrelevant');
      } else {
        // If parsing failed, treat entire batch as possible (don't miss events)
        console.log('    Warning: failed to parse classification response — treating batch as possible');
        for (let k = 0; k < batch.length; k++) {
          batch[k].classification = 'possible';
          relevant.push(batch[k]);
        }
      }
    } catch (err) {
      var errMsg = err.message || String(err);
      var isRateLimitErr = (err.status === 429) || errMsg.includes('429');

      if (isRateLimitErr || _dailyLimitReached) {
        // Rate limit or daily cap — skip batch entirely (don't flood extraction with doomed calls)
        console.log('    Rate limited — skipping batch (' + batch.length + ' announcements)');
        if (_dailyLimitReached) {
          console.log('    Daily limit reached — skipping all remaining batches');
          break;
        }
      } else {
        // Non-rate-limit error — treat batch as possible to avoid missing events
        console.log('    Error classifying batch: ' + errMsg.substring(0, 200) + ' — treating batch as possible');
        for (let k = 0; k < batch.length; k++) {
          batch[k].classification = 'possible';
          relevant.push(batch[k]);
        }
      }
    }

    // Delay between batches
    if (b < batches.length - 1) {
      await delay(LLM_DELAY_MS);
    }
  }

  console.log('[llm] Classification complete: ' + relevant.length + '/' + announcements.length + ' announcements flagged for deep extraction');
  return relevant;
}

// ---------------------------------------------------------------------------
// extractEventDetails — Deep extraction from one announcement's full content
// ---------------------------------------------------------------------------

async function extractEventDetails(announcement, content, llmApiKey) {
  if (!content) return null;

  const client = createClient(llmApiKey);

  const userPrompt = [
    'Company: ' + announcement.company_name + ' (ASX: ' + announcement.ticker + ')',
    'Announcement title: ' + announcement.title,
    'Announcement date: ' + announcement.date,
    '',
    '--- Announcement content ---',
    content,
    '--- End of content ---',
  ].join('\n');

  try {
    const raw = await callLLM(client, [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    const parsed = parseJsonFromLLM(raw);

    if (!parsed || typeof parsed !== 'object') {
      console.log('    [llm] Warning: could not parse extraction response for ' + announcement.ticker + ' — ' + announcement.title);
      return null;
    }

    // If no event found, return null
    if (!parsed.has_event) return null;

    // Validate required fields
    if (!parsed.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.event_date)) {
      console.log('    [llm] Warning: invalid event_date for ' + announcement.ticker + ': ' + parsed.event_date);
      return null;
    }

    // Validate event_type
    const validTypes = ['earnings', 'investor_day', 'conference', 'ad_hoc'];
    if (!validTypes.includes(parsed.event_type)) {
      parsed.event_type = 'ad_hoc';
    }

    // Validate event_time format if present
    if (parsed.event_time && !/^\d{2}:\d{2}$/.test(parsed.event_time)) {
      parsed.event_time = null;
    }

    return {
      ticker: announcement.ticker,
      company_name: announcement.company_name,
      event_type: parsed.event_type,
      event_date: parsed.event_date,
      event_time: parsed.event_time || null,
      title: parsed.title || announcement.title,
      webcast_url: parsed.webcast_url || null,
      replay_url: parsed.replay_url || null,
      phone_number: parsed.phone_number || null,
      phone_passcode: parsed.phone_passcode || null,
      fiscal_period: parsed.fiscal_period || null,
      description: parsed.description || null,
      confidence: parsed.confidence || 'medium',
      source_url: announcement.url,
      classification: announcement.classification || 'relevant',
    };
  } catch (err) {
    console.log('    [llm] Error extracting from ' + announcement.ticker + ' — ' + announcement.title + ': ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyAnnouncements: classifyAnnouncements,
  extractEventDetails: extractEventDetails,
  isLLMBudgetExhausted: isLLMBudgetExhausted,
};
