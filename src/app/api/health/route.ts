import { NextResponse } from 'next/server';
import { loadCompanies } from '@/lib/companies';
import { loadEvents } from '@/lib/events';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Api-Version': '1.0.0',
};

/**
 * GET /api/health
 *
 * Health check endpoint — returns API status, counts, and version.
 */
export function GET() {
  try {
    const companies = loadCompanies();
    const events = loadEvents();

    return NextResponse.json(
      {
        status: 'healthy',
        version: '1.0.0',
        data: {
          companies: companies.length,
          events: events.length,
        },
        timestamp: new Date().toISOString(),
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { status: 'unhealthy', error: String(err) },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
