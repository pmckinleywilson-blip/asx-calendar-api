import { NextRequest, NextResponse } from 'next/server';
import { getEventByIdFromDB, eventRowToItem } from '@/lib/db';
import { loadEvents } from '@/lib/events';
import { generateSingleIcs } from '@/lib/ics';
import type { EventItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS_HEADERS });
}

/**
 * GET /api/calendar/[id]
 *
 * Returns an .ics file for a single event. Reads from Postgres when
 * DATABASE_URL is set, with the static events.json file as a fallback.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const numericId = Number(id);

    let event: EventItem | undefined;

    if (process.env.DATABASE_URL && Number.isFinite(numericId)) {
      const row = await getEventByIdFromDB(numericId);
      if (row) event = eventRowToItem(row);
    }

    if (!event) {
      const events = loadEvents();
      event = events.find((e) => e.id === numericId);
    }

    if (!event) {
      return NextResponse.json(
        { error: 'not_found', message: `Event with id "${id}" not found.`, status: 404 },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const ics = generateSingleIcs(event);

    const filename = `asx-${event.ticker}-${event.event_date}.ics`;

    return new Response(ics, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('Calendar ICS error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
