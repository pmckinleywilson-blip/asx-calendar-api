import { NextRequest, NextResponse } from 'next/server';
import { loadEvents } from '@/lib/events';
import { generateSingleIcs } from '@/lib/ics';

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
 * Returns an .ics file for a single event.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const numericId = Number(id);

    const events = loadEvents();
    const event = events.find((e: any) => e.id === numericId || e.id === id);

    if (!event) {
      return NextResponse.json(
        { error: 'not_found', message: `Event with id "${id}" not found.`, status: 404 },
        { status: 404, headers: CORS_HEADERS },
      );
    }

    const ics = generateSingleIcs(event as any);

    const ticker = (event as any).ticker ?? (event as any).companyCode ?? 'event';
    const date = (event as any).event_date ?? (event as any).date ?? 'unknown';
    const filename = `asx-${ticker}-${date}.ics`;

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
