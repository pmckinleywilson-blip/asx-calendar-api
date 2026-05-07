import { NextRequest, NextResponse } from 'next/server';
import { getEventsByIdsFromDB, eventRowToItem } from '@/lib/db';
import { loadEvents } from '@/lib/events';
import { generateBulkIcs } from '@/lib/ics';
import type { EventItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS_HEADERS });
}

/**
 * POST /api/calendar/bulk
 *
 * Accepts a JSON body containing an array of event IDs (number[])
 * and returns a single .ics file with all matching events.
 *
 * Reads from Postgres when DATABASE_URL is set. No date filter is applied
 * here — if a caller has a specific event ID in hand, they get the event,
 * even if it's in the past.
 */
export async function POST(request: NextRequest) {
  try {
    let ids: unknown;

    try {
      ids = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'bad_request', message: 'Request body must be valid JSON.', status: 400 },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    if (!Array.isArray(ids)) {
      return NextResponse.json(
        { error: 'bad_request', message: 'Request body must be an array of event IDs.', status: 400 },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    // Coerce to numbers, drop anything that isn't a finite integer.
    const numericIds = ids
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && Number.isInteger(n));

    let matched: EventItem[] = [];

    if (process.env.DATABASE_URL) {
      const rows = await getEventsByIdsFromDB(numericIds);
      matched = rows.map(eventRowToItem);
    } else {
      const allEvents = loadEvents();
      const idSet = new Set(numericIds.map(String));
      matched = allEvents.filter((e) => idSet.has(String(e.id)));
    }

    if (matched.length === 0) {
      return NextResponse.json(
        { error: 'not_found', message: 'No events found for the supplied IDs.', status: 404 },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const ics = generateBulkIcs(matched);

    return new Response(ics, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="asx-events.ics"',
      },
    });
  } catch (err) {
    console.error('Bulk calendar error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
