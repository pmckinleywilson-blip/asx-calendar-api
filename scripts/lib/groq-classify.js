// ============================================================
// Groq LLM Classification and Extraction
// Two-pass approach: batch classify titles, then deep extract from content.
// ============================================================

const Groq = require('groq-sdk');

const MODEL = 'llama-3.3-70b-versatile';
const BATCH_SIZE = 25;
const MAX_RETRIES = 3;
const GROQ_DELAY_MS = 1000;

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
// Groq API call with retry and exponential backoff
// ---------------------------------------------------------------------------

async function callGroq(client, messages, attempt) {
  if (attempt === undefined) attempt = 1;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: messages,
    });

    const content = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : null;

    return content || '';
  } catch (err) {
    const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));

    if (attempt < MAX_RETRIES) {
      const backoffMs = isRateLimit
        ? Math.min(2000 * Math.pow(2, attempt), 30000)
        : 1000 * attempt;

      console.log('  [groq] Retry ' + attempt + '/' + MAX_RETRIES + ' after ' + backoffMs + 'ms — ' + (err.message || err));
      await delay(backoffMs);
      return callGroq(client, messages, attempt + 1);
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLASSIFICATION SYSTEM PROMPT
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `You are an expert ASX (Australian Securities Exchange) analyst. Your task is to classify company announcements by whether they contain information about an upcoming teleconference, webcast, conference call, investor briefing, or results presentation that investors could dial into or watch live.

IMPORTANT: Webcasts and conference call details are OFTEN embedded in announcements with non-obvious titles. For example:
- "Half Year Results" → LIKELY contains conference call details
- "Appendix 4D and Financial Report" → UNLIKELY but may mention a briefing
- "Strategic Update" → MIGHT contain an investor day or presentation webcast
- "Trading Halt" → IRRELEVANT
- "Change of Director's Interest" → IRRELEVANT
- "Results of Meeting" → IRRELEVANT
- "Dividend/Distribution" → IRRELEVANT

Classify each announcement as:
- "relevant" — likely contains teleconference/webcast event information
- "possible" — might contain event info, worth checking
- "irrelevant" — definitely no event info (director changes, trading halts, dividends, appendix filings, etc.)

Return a JSON array of objects: [{"index": 0, "classification": "relevant"}, ...]
Return ONLY the JSON array, no other text.`;

// ---------------------------------------------------------------------------
// EXTRACTION SYSTEM PROMPT
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM_PROMPT = `You are extracting teleconference/webcast event details from an ASX company announcement.

Extract ONLY events where investors can dial in or watch a live webcast/conference call. This includes:
- Earnings results briefings/presentations
- Investor days
- Strategic update webcasts
- M&A announcement conference calls
- AGM webcasts (if they have a webcast component)

Do NOT extract:
- Dividend dates (ex-div, record, payment dates)
- Director appointments
- Share buyback notices
- Trading halts (these are not events investors attend)

Return JSON:
{
  "has_event": true/false,
  "event_type": "earnings" | "investor_day" | "conference" | "ad_hoc",
  "event_date": "YYYY-MM-DD",
  "event_time": "HH:MM" (24-hour AEST) or null,
  "title": "short descriptive title",
  "webcast_url": "URL" or null,
  "phone_number": "number" or null,
  "phone_passcode": "code" or null,
  "fiscal_period": "HY2026" or "FY2026" or null,
  "description": "one sentence summary" or null,
  "confidence": "high" | "medium" | "low"
}

CRITICAL RULES:
1. The event date is the DATE OF THE CALL/WEBCAST, not the date of the announcement or the reporting period end date
2. Times should be in AEST (UTC+10). If the announcement says AEDT, subtract 1 hour to get AEST
3. Webcast URLs must be from the company's domain, not from news sites
4. If you find a date but aren't sure if it's the call date vs reporting period date, set confidence to "low"
5. "has_event" should be false if no teleconference/webcast is mentioned
6. Return ONLY JSON, no markdown or explanation`;

// ---------------------------------------------------------------------------
// classifyAnnouncements — Batch classify announcement titles via Groq
// ---------------------------------------------------------------------------

async function classifyAnnouncements(announcements, groqApiKey) {
  if (!announcements || announcements.length === 0) return [];

  const client = new Groq({ apiKey: groqApiKey });
  const relevant = [];

  // Split into batches
  const batches = [];
  for (let i = 0; i < announcements.length; i += BATCH_SIZE) {
    batches.push(announcements.slice(i, i + BATCH_SIZE));
  }

  console.log('[groq] Classifying ' + announcements.length + ' announcements in ' + batches.length + ' batch(es)');

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log('  [groq] Batch ' + (b + 1) + '/' + batches.length + ' (' + batch.length + ' items)');

    // Build the list of announcements for the prompt
    const lines = [];
    for (let i = 0; i < batch.length; i++) {
      const a = batch[i];
      lines.push(i + '. [' + a.ticker + '] ' + a.title + ' (' + a.date + ')');
    }

    const userPrompt = 'Classify these ASX announcements:\n\n' + lines.join('\n');

    try {
      const raw = await callGroq(client, [
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
      // On error, treat entire batch as possible to avoid missing events
      console.log('    Error classifying batch: ' + err.message + ' — treating batch as possible');
      for (let k = 0; k < batch.length; k++) {
        batch[k].classification = 'possible';
        relevant.push(batch[k]);
      }
    }

    // Delay between batches
    if (b < batches.length - 1) {
      await delay(GROQ_DELAY_MS);
    }
  }

  console.log('[groq] Classification complete: ' + relevant.length + '/' + announcements.length + ' announcements flagged for deep extraction');
  return relevant;
}

// ---------------------------------------------------------------------------
// extractEventDetails — Deep extraction from one announcement's full content
// ---------------------------------------------------------------------------

async function extractEventDetails(announcement, content, groqApiKey) {
  if (!content) return null;

  const client = new Groq({ apiKey: groqApiKey });

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
    const raw = await callGroq(client, [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);

    const parsed = parseJsonFromLLM(raw);

    if (!parsed || typeof parsed !== 'object') {
      console.log('    [groq] Warning: could not parse extraction response for ' + announcement.ticker + ' — ' + announcement.title);
      return null;
    }

    // If no event found, return null
    if (!parsed.has_event) return null;

    // Validate required fields
    if (!parsed.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.event_date)) {
      console.log('    [groq] Warning: invalid event_date for ' + announcement.ticker + ': ' + parsed.event_date);
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
      phone_number: parsed.phone_number || null,
      phone_passcode: parsed.phone_passcode || null,
      fiscal_period: parsed.fiscal_period || null,
      description: parsed.description || null,
      confidence: parsed.confidence || 'medium',
      source_url: announcement.url,
      classification: announcement.classification || 'relevant',
    };
  } catch (err) {
    console.log('    [groq] Error extracting from ' + announcement.ticker + ' — ' + announcement.title + ': ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyAnnouncements: classifyAnnouncements,
  extractEventDetails: extractEventDetails,
};
