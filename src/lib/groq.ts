// ============================================================
// Groq LLM client — event extraction from ASX announcements
// ============================================================

import Groq from 'groq-sdk';
import { EventType, EVENT_TYPES } from './types';

/** Lightweight event shape returned by the LLM extractor (pre-storage). */
export interface ExtractedEvent {
  id: string;
  companyCode: string;
  companyName: string;
  eventType: EventType;
  title: string;
  date: string;
  time?: string;
  description?: string;
  source?: string;
  confirmed: boolean;
}

// --------------- Singleton client ---------------

let _client: Groq | null = null;

function getClient(): Groq {
  if (!_client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set. Add it to your environment variables.',
      );
    }
    _client = new Groq({ apiKey });
  }
  return _client;
}

// --------------- Types ---------------

interface RawExtractedEvent {
  eventType?: string;
  date?: string;
  title?: string;
  time?: string;
  description?: string;
  confirmed?: boolean;
}

export interface AnnouncementInput {
  title: string;
  date: string;
  url: string;
  companyCode: string;
  companyName: string;
}

// --------------- Prompt ---------------

const SYSTEM_PROMPT = `You are a financial data extraction assistant specialising in the Australian Securities Exchange (ASX).

Given the raw text of an ASX company announcement, extract every identifiable calendar event.

For each event return a JSON object with these fields:
- eventType: one of ${EVENT_TYPES.map((t) => `"${t}"`).join(', ')}
- date: ISO 8601 date string (YYYY-MM-DD). If only a month/year is given, use the first day of that month.
- title: short descriptive title for the event
- time: time in HH:MM format (24h, AEST) if mentioned, otherwise omit
- description: one- or two-sentence summary, otherwise omit
- confirmed: true if the date is explicitly stated and firm, false if estimated or tentative

Return ONLY a JSON array of event objects. If no events can be identified, return an empty array [].
Do not include any markdown formatting, code fences, or explanatory text — just the raw JSON array.`;

function buildUserPrompt(
  text: string,
  companyCode: string,
  companyName: string,
): string {
  return [
    `Company: ${companyName} (ASX: ${companyCode})`,
    '',
    '--- Announcement text ---',
    text,
    '--- End of text ---',
  ].join('\n');
}

// --------------- Helpers ---------------

function isValidEventType(t: unknown): t is EventType {
  return typeof t === 'string' && (EVENT_TYPES as readonly string[]).includes(t);
}

function isValidDateString(d: unknown): d is string {
  if (typeof d !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/**
 * Attempt to parse a JSON array from potentially messy LLM output.
 * Handles cases where the model wraps the array in code fences or
 * adds preamble text.
 */
function parseJsonArray(raw: string): unknown[] {
  let cleaned = raw.trim();

  // Strip markdown code fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Find the outermost [ ... ]
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  cleaned = cleaned.slice(start, end + 1);

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function makeId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function toExtractedEvent(
  raw: RawExtractedEvent,
  companyCode: string,
  companyName: string,
  source?: string,
): ExtractedEvent | null {
  if (!isValidDateString(raw.date)) return null;

  const eventType = isValidEventType(raw.eventType) ? raw.eventType : 'ad_hoc';

  return {
    id: makeId(),
    companyCode,
    companyName,
    eventType,
    title: typeof raw.title === 'string' ? raw.title : `${companyCode} event`,
    date: raw.date,
    ...(typeof raw.time === 'string' && raw.time ? { time: raw.time } : {}),
    ...(typeof raw.description === 'string' && raw.description
      ? { description: raw.description }
      : {}),
    ...(source ? { source } : {}),
    confirmed: typeof raw.confirmed === 'boolean' ? raw.confirmed : false,
  };
}

// --------------- Public API ---------------

/**
 * Extract structured calendar events from raw announcement text
 * using the Groq LLM (llama-3.3-70b-versatile).
 */
export async function extractEvents(
  text: string,
  companyCode: string,
  companyName: string,
  source?: string,
): Promise<ExtractedEvent[]> {
  const client = getClient();

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserPrompt(text, companyCode, companyName),
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) return [];

    const items = parseJsonArray(content);

    const events: ExtractedEvent[] = [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const evt = toExtractedEvent(
        item as RawExtractedEvent,
        companyCode,
        companyName,
        source,
      );
      if (evt) events.push(evt);
    }

    return events;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[groq] Failed to extract events for ${companyCode}: ${message}`,
    );
    return [];
  }
}

/**
 * Batch-process an array of announcements through Groq and return
 * all extracted calendar events. Processes sequentially to stay
 * within rate limits.
 */
export async function extractEventsFromAnnouncements(
  announcements: AnnouncementInput[],
): Promise<ExtractedEvent[]> {
  const allEvents: ExtractedEvent[] = [];

  for (const ann of announcements) {
    // Build a synthetic text block from the announcement metadata
    // (the caller may later supply full body text instead).
    const text = [
      `Title: ${ann.title}`,
      `Date: ${ann.date}`,
      `URL: ${ann.url}`,
    ].join('\n');

    const events = await extractEvents(
      text,
      ann.companyCode,
      ann.companyName,
      ann.url,
    );

    allEvents.push(...events);
  }

  return allEvents;
}
