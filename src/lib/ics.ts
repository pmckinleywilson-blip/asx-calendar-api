// ============================================================
// ICS (iCalendar) generator — no external dependencies
// ============================================================

import { EventItem } from './types';

// ---- Helpers ----

/** Escape special characters per RFC 5545 (backslash-escape commas, semicolons, newlines). */
function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Fold long lines at 75 octets per RFC 5545. */
function foldLine(line: string): string {
  const maxLen = 75;
  if (line.length <= maxLen) return line;

  const parts: string[] = [line.slice(0, maxLen)];
  let pos = maxLen;
  while (pos < line.length) {
    parts.push(' ' + line.slice(pos, pos + maxLen - 1));
    pos += maxLen - 1;
  }
  return parts.join('\r\n');
}

/** Generate a UTC timestamp string for the current moment (DTSTAMP). */
function nowUtcStamp(): string {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Build the DTSTART property.
 *
 * If a time is available we emit a TZID-qualified date-time in Australia/Sydney.
 * Otherwise we emit a DATE value (all-day event).
 */
function buildDtStart(event: EventItem): string {
  const [year, month, day] = event.event_date.split('-');

  if (event.event_time) {
    const [hour, minute] = event.event_time.split(':');
    return `DTSTART;TZID=Australia/Sydney:${year}${month}${day}T${hour}${minute}00`;
  }

  return `DTSTART;VALUE=DATE:${year}${month}${day}`;
}

/**
 * Build a human-readable DESCRIPTION from all available metadata.
 */
function buildDescription(event: EventItem): string {
  const parts: string[] = [];

  if (event.description) parts.push(event.description);
  if (event.fiscal_period) parts.push(`Fiscal period: ${event.fiscal_period}`);
  if (event.status) parts.push(`Status: ${event.status}`);
  if (event.webcast_url) parts.push(`Webcast: ${event.webcast_url}`);
  if (event.phone_number) parts.push(`Phone: ${event.phone_number}`);
  if (event.phone_passcode) parts.push(`Passcode: ${event.phone_passcode}`);
  if (event.replay_url) parts.push(`Replay: ${event.replay_url}`);

  return parts.join('\n');
}

/**
 * Build a single VEVENT block.
 */
function buildVEvent(event: EventItem, dtstamp: string): string {
  const uid = `asx-calendar-${event.id}@asx-calendar-api.vercel.app`;
  const summary = event.title ?? `${event.ticker} ${event.event_type}`;
  const description = buildDescription(event);
  const status = event.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE';
  const categories = event.event_type.toUpperCase();

  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    buildDtStart(event),
  ];

  // Duration — only meaningful when we have a concrete start time
  if (event.event_time) {
    lines.push('DURATION:PT1H30M');
  }

  lines.push(foldLine(`SUMMARY:${escapeIcs(summary)}`));
  lines.push(foldLine(`DESCRIPTION:${escapeIcs(description)}`));

  if (event.webcast_url) {
    lines.push(foldLine(`URL:${event.webcast_url}`));
  }

  lines.push(`STATUS:${status}`);
  lines.push(`CATEGORIES:${categories}`);
  lines.push('END:VEVENT');

  return lines.join('\r\n');
}

// ---- VTIMEZONE for Australia/Sydney ----

const SYDNEY_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Australia/Sydney',
  'BEGIN:STANDARD',
  'DTSTART:19700405T030000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4',
  'TZOFFSETFROM:+1100',
  'TZOFFSETTO:+1000',
  'TZNAME:AEST',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19701004T020000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10',
  'TZOFFSETFROM:+1000',
  'TZOFFSETTO:+1100',
  'TZNAME:AEDT',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

// ---- Public API ----

/**
 * Generate an ICS calendar string for a single event.
 */
export function generateSingleIcs(event: EventItem): string {
  const dtstamp = nowUtcStamp();
  const needsTz = !!event.event_time;

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ASX Calendar API//asx-calendar-api.vercel.app//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  if (needsTz) {
    lines.push(SYDNEY_VTIMEZONE);
  }

  lines.push(buildVEvent(event, dtstamp));
  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate an ICS calendar string containing multiple events.
 */
export function generateBulkIcs(events: EventItem[]): string {
  const dtstamp = nowUtcStamp();
  const needsTz = events.some((e) => !!e.event_time);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ASX Calendar API//asx-calendar-api.vercel.app//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  if (needsTz) {
    lines.push(SYDNEY_VTIMEZONE);
  }

  for (const event of events) {
    lines.push(buildVEvent(event, dtstamp));
  }

  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

/**
 * Build a Google Calendar "add event" URL for a given event.
 *
 * Google expects dates in UTC format: YYYYMMDDTHHmmSSZ
 * When there is no time we fall back to all-day format: YYYYMMDD/YYYYMMDD (next day).
 */
export function generateGmailUrl(event: EventItem): string {
  const title = event.title ?? `${event.ticker} ${event.event_type}`;
  const details = buildDescription(event);
  const location = event.webcast_url ?? '';

  const [year, month, day] = event.event_date.split('-').map(Number);

  let dates: string;

  if (event.event_time) {
    const [hour, minute] = event.event_time.split(':').map(Number);

    // Convert AEST (UTC+10) to UTC. We use +10 as a simple offset since
    // Google Calendar will let the user adjust for DST in their own tz.
    const start = new Date(Date.UTC(year, month - 1, day, hour - 10, minute, 0));
    const end = new Date(start.getTime() + 90 * 60 * 1000); // +1h30m

    const fmt = (d: Date) =>
      d.getUTCFullYear().toString() +
      pad2(d.getUTCMonth() + 1) +
      pad2(d.getUTCDate()) +
      'T' +
      pad2(d.getUTCHours()) +
      pad2(d.getUTCMinutes()) +
      pad2(d.getUTCSeconds()) +
      'Z';

    dates = `${fmt(start)}/${fmt(end)}`;
  } else {
    // All-day event: YYYYMMDD/YYYYMMDD (end = next day)
    const startStr = `${year}${pad2(month)}${pad2(day)}`;
    const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
    const endStr =
      nextDay.getUTCFullYear().toString() +
      pad2(nextDay.getUTCMonth() + 1) +
      pad2(nextDay.getUTCDate());
    dates = `${startStr}/${endStr}`;
  }

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates,
    details,
    location,
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
