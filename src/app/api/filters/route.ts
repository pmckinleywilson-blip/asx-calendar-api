import { NextResponse } from 'next/server';
import { getFilterOptions } from '@/lib/companies';
import { getEventTypes, getDateRange } from '@/lib/events';
import { INDEX_TIERS, EVENT_TYPES } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS });
}

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
      { headers: CORS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', message: String(err) },
      { status: 500, headers: CORS }
    );
  }
}
