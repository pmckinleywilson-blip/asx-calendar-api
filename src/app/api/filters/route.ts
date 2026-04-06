import { NextResponse } from 'next/server';
import { getFilterOptions } from '@/lib/companies';
import { getEventTypes, getDateRange } from '@/lib/events';
import { INDEX_TIERS, EVENT_TYPES } from '@/lib/types';

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
 * GET /api/filters
 *
 * Returns all available filter options for building UIs or agent tool schemas.
 */
export function GET() {
  try {
    const { sectors, industries } = getFilterOptions();
    const dateRange = getDateRange();

    return NextResponse.json(
      {
        indices: [...INDEX_TIERS],
        sectors,
        industries,
        eventTypes: [...EVENT_TYPES],
        dateRange,
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error('Filters API error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
