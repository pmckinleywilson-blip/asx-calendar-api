import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { loadCompanies } from '@/lib/companies';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Api-Version': '1.0.0',
};

/**
 * GET /api/health
 *
 * Health check endpoint — returns API status, event counts by status,
 * and last pipeline activity. Reads from the database when available.
 */
export async function GET() {
  try {
    const companies = loadCompanies();

    // Try to get live counts from the database
    if (process.env.DATABASE_URL) {
      const sql = neon(process.env.DATABASE_URL);

      const [countRows, recentRow] = await Promise.all([
        sql`
          SELECT status, COUNT(*)::int AS count
          FROM events
          GROUP BY status
        `,
        sql`
          SELECT updated_at FROM events
          ORDER BY updated_at DESC LIMIT 1
        `,
      ]);

      const byStatus: Record<string, number> = {};
      let totalEvents = 0;
      for (const row of countRows) {
        byStatus[row.status as string] = row.count as number;
        totalEvents += row.count as number;
      }

      return NextResponse.json(
        {
          status: 'healthy',
          version: '1.0.0',
          data: {
            companies: companies.length,
            events: totalEvents,
            by_status: byStatus,
            last_update: recentRow[0]?.updated_at ?? null,
          },
          source: 'database',
          timestamp: new Date().toISOString(),
        },
        { headers: CORS_HEADERS }
      );
    }

    // Fallback: no database configured
    return NextResponse.json(
      {
        status: 'healthy',
        version: '1.0.0',
        data: {
          companies: companies.length,
          events: 0,
          by_status: {},
          last_update: null,
        },
        source: 'none',
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
