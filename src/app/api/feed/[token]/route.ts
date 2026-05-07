import { NextRequest, NextResponse } from 'next/server';
import {
  getSubscriptionByToken,
  getEventsByTickers,
  eventRowToItem,
} from '@/lib/db';
import { loadEvents } from '@/lib/events';
import { generateBulkIcs } from '@/lib/ics';
import type { EventItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * GET /api/feed/[token].ics
 *
 * Serves a subscribable ICS calendar feed for the given subscription.
 * Calendar clients can poll this URL to stay in sync.
 *
 * Reads from Postgres when DATABASE_URL is set so subscribers always see
 * the latest events. Falls back to the static events.json file otherwise.
 * Past events are excluded — getEventsByTickers already filters to
 * event_date >= CURRENT_DATE.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token: rawToken } = await params;

  // Strip .ics suffix if present (feed URLs end with .ics for compatibility)
  const token = rawToken.replace(/\.ics$/, '');

  if (!token) {
    return NextResponse.json(
      { detail: 'Missing feed token.' },
      { status: 400 },
    );
  }

  // Look up subscription
  const sub = await getSubscriptionByToken(token);

  if (!sub || !sub.is_active) {
    return NextResponse.json(
      { detail: 'Feed not found or subscription inactive.' },
      { status: 404 },
    );
  }

  // Parse the subscriber's tickers
  let tickers: string[];
  try {
    tickers = JSON.parse(sub.tickers) as string[];
  } catch {
    tickers = [];
  }

  if (tickers.length === 0) {
    return new NextResponse(emptyCalendar(), {
      headers: calendarHeaders(),
    });
  }

  const upperTickers = tickers.map((t) => t.toUpperCase());

  // Resolve events for the subscriber's tickers — DB first, static fallback.
  let matched: EventItem[] = [];

  if (process.env.DATABASE_URL) {
    const rows = await getEventsByTickers(upperTickers);
    matched = rows.map(eventRowToItem);
  } else {
    const allEvents = loadEvents();
    const tickerSet = new Set(upperTickers);
    const today = new Date().toISOString().substring(0, 10);
    matched = allEvents.filter(
      (e) => tickerSet.has(e.ticker.toUpperCase()) && e.event_date >= today,
    );
  }

  // Generate ICS with refresh interval hints
  let ics: string;
  if (matched.length === 0) {
    ics = emptyCalendar();
  } else {
    ics = generateBulkIcs(matched);
    // Inject refresh interval after the METHOD line
    ics = ics.replace(
      'METHOD:PUBLISH',
      'METHOD:PUBLISH\r\nX-PUBLISHED-TTL:PT1H\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H',
    );
  }

  // Add feed name
  ics = ics.replace(
    'METHOD:PUBLISH',
    `METHOD:PUBLISH\r\nX-WR-CALNAME:ASX Calendar (${tickers.join(', ')})`,
  );

  return new NextResponse(ics, {
    headers: calendarHeaders(),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calendarHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="asx-calendar.ics"',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
}

function emptyCalendar(): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ASX Calendar API//asx-calendar-api.vercel.app//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-WR-CALNAME:ASX Calendar (empty)',
    'END:VCALENDAR',
  ].join('\r\n') + '\r\n';
}
