import { NextRequest, NextResponse } from 'next/server';
import { loadEvents } from '@/lib/events';
import { generateBulkIcs } from '@/lib/ics';

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

    const allEvents = loadEvents();

    // Support both numeric and string IDs for flexibility
    const idSet = new Set(ids.map(String));
    const matched = allEvents.filter(
      (e: any) => idSet.has(String(e.id)),
    );

    if (matched.length === 0) {
      return NextResponse.json(
        { error: 'not_found', message: 'No events found for the supplied IDs.', status: 404 },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const ics = generateBulkIcs(matched as any[]);

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
