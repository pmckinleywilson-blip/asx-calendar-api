import { NextRequest, NextResponse } from 'next/server';
import { filterEvents } from '@/lib/events';
import { EventsQuery, APIResponse, CalendarEvent, INDEX_TIERS, EVENT_TYPES } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Api-Version': '1.0.0',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS_HEADERS });
}

/**
 * GET /api/events
 *
 * Query parameters:
 *   index    — asx20 | asx50 | asx100 | asx200 | asx300 | all-ords | small-ords
 *   sector   — GICS sector (partial, case-insensitive)
 *   industry — GICS industry group (partial, case-insensitive)
 *   type     — earnings | agm | egm | ex-dividend | dividend-payment | ipo | trading-halt | capital-raise | other
 *   code     — Comma-separated ASX codes (e.g. BHP,CBA,CSL)
 *   from     — Start date ISO 8601 (YYYY-MM-DD)
 *   to       — End date ISO 8601 (YYYY-MM-DD)
 *   limit    — Max results (default 50, max 500)
 *   offset   — Pagination offset (default 0)
 */
export function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    // Validate index
    const indexParam = params.get('index') ?? undefined;
    if (indexParam && !INDEX_TIERS.includes(indexParam as any)) {
      return NextResponse.json(
        {
          error: 'invalid_parameter',
          message: `Invalid index "${indexParam}". Valid values: ${INDEX_TIERS.join(', ')}`,
          status: 400,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // Validate event type
    const typeParam = params.get('type') ?? undefined;
    if (typeParam && !EVENT_TYPES.includes(typeParam as any)) {
      return NextResponse.json(
        {
          error: 'invalid_parameter',
          message: `Invalid type "${typeParam}". Valid values: ${EVENT_TYPES.join(', ')}`,
          status: 400,
        },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const query: EventsQuery = {
      index: indexParam as EventsQuery['index'],
      sector: params.get('sector') ?? undefined,
      industry: params.get('industry') ?? undefined,
      type: typeParam as EventsQuery['type'],
      code: params.get('code') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      limit: Math.min(parseInt(params.get('limit') ?? '50', 10), 500),
      offset: parseInt(params.get('offset') ?? '0', 10),
    };

    const { events, total } = filterEvents(query);

    const response: APIResponse<CalendarEvent[]> = {
      data: events,
      meta: {
        total,
        limit: query.limit!,
        offset: query.offset!,
        filters: {
          index: query.index,
          sector: query.sector,
          industry: query.industry,
          type: query.type,
          code: query.code,
          from: query.from,
          to: query.to,
        },
      },
    };

    return NextResponse.json(response, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('Events API error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
