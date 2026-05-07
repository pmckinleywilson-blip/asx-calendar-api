import { NextRequest, NextResponse } from 'next/server';
import { getEventByIdFromDB, eventRowToItem } from '@/lib/db';
import { loadEvents } from '@/lib/events';
import { generateGmailUrl } from '@/lib/ics';
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
 * GET /api/calendar/[id]/gmail
 *
 * Returns a JSON object containing a Google Calendar "add event" URL.
 * Reads from Postgres when DATABASE_URL is set; static JSON is a fallback.
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

    const gmail_url = generateGmailUrl(event);

    return NextResponse.json({ gmail_url }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('Gmail URL error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
