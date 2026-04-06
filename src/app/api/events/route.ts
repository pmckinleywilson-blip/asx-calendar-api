import { NextRequest, NextResponse } from 'next/server';
import { loadEvents } from '@/lib/events';
import { loadCompanies } from '@/lib/companies';
import { getEventsFromDB } from '@/lib/db';
import type { EventItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'X-Api-Version': '1.0.0',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS });
}

/**
 * GET /api/events
 *
 * When DATABASE_URL is set, reads from Postgres (real scraped events).
 * Otherwise falls back to the static events.json file.
 */
export async function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    const perPage = Math.min(parseInt(p.get('per_page') || '5000', 10), 5000);
    const page = Math.max(parseInt(p.get('page') || '1', 10), 1);
    const offset = (page - 1) * perPage;

    // ── Database path ──────────────────────────────────────────
    if (process.env.DATABASE_URL) {
      const dbResult = await getEventsFromDB({
        ticker: p.get('ticker') ?? undefined,
        type: p.get('type') ?? undefined,
        status: p.get('status') ?? undefined,
        confirmed_only: p.get('confirmed_only') === 'true',
        date_from: p.get('date_from') ?? undefined,
        date_to: p.get('date_to') ?? undefined,
        q: p.get('q') ?? undefined,
        limit: perPage,
        offset,
      });

      if (dbResult) {
        let dbEvents = dbResult.events;

        // Apply index/sector filters (requires company data)
        const index = p.get('index');
        const sector = p.get('sector');
        if (index || sector) {
          const companies = loadCompanies();
          if (index) {
            const indexCodes = new Set(
              companies.filter((c) => c.indices.includes(index as any)).map((c) => c.code)
            );
            dbEvents = dbEvents.filter((e: any) => indexCodes.has(e.ticker));
          }
          if (sector) {
            const sl = sector.toLowerCase();
            const sectorCodes = new Set(
              companies.filter((c) => c.sector.toLowerCase().includes(sl)).map((c) => c.code)
            );
            dbEvents = dbEvents.filter((e: any) => sectorCodes.has(e.ticker));
          }
        }

        // Map DB rows to EventItem shape
        const events = dbEvents.map((row: any) => ({
          id: row.id,
          ticker: row.ticker,
          company_name: row.company_name,
          event_type: row.event_type,
          event_date: typeof row.event_date === 'string'
            ? row.event_date.substring(0, 10)
            : new Date(row.event_date).toISOString().substring(0, 10),
          event_time: row.event_time,
          timezone: row.timezone ?? 'Australia/Sydney',
          title: row.title,
          description: row.description,
          webcast_url: row.webcast_url,
          phone_number: row.phone_number,
          phone_passcode: row.phone_passcode,
          replay_url: row.replay_url,
          fiscal_period: row.fiscal_period,
          source: row.source,
          source_url: row.source_url,
          ir_verified: row.ir_verified,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));

        const total = index || sector ? events.length : dbResult.total;

        return NextResponse.json(
          {
            events,
            total,
            page,
            per_page: perPage,
            pages: Math.ceil(total / perPage),
            source: 'database',
          },
          { headers: CORS }
        );
      }
    }

    // ── Fallback: static JSON file ─────────────────────────────
    let results = loadEvents() as EventItem[];
    const companies = loadCompanies();

    const q = p.get('q');
    if (q) {
      const ql = q.toLowerCase();
      results = results.filter(
        (e) =>
          e.ticker.toLowerCase().includes(ql) ||
          e.company_name.toLowerCase().includes(ql)
      );
    }

    const ticker = p.get('ticker');
    if (ticker) {
      const codes = ticker.split(',').map((t) => t.trim().toUpperCase());
      results = results.filter((e) => codes.includes(e.ticker));
    }

    const index = p.get('index');
    if (index) {
      const indexCodes = new Set(
        companies.filter((c) => c.indices.includes(index as any)).map((c) => c.code)
      );
      results = results.filter((e) => indexCodes.has(e.ticker));
    }

    const sector = p.get('sector');
    if (sector) {
      const sl = sector.toLowerCase();
      const sectorCodes = new Set(
        companies.filter((c) => c.sector.toLowerCase().includes(sl)).map((c) => c.code)
      );
      results = results.filter((e) => sectorCodes.has(e.ticker));
    }

    const type = p.get('type');
    if (type) {
      results = results.filter((e) => e.event_type === type);
    }

    if (p.get('confirmed_only') === 'true') {
      results = results.filter((e) => e.status === 'confirmed');
    }

    const dateFrom = p.get('date_from');
    if (dateFrom) results = results.filter((e) => e.event_date >= dateFrom);
    const dateTo = p.get('date_to');
    if (dateTo) results = results.filter((e) => e.event_date <= dateTo);

    results.sort((a, b) =>
      a.event_date.localeCompare(b.event_date) ||
      (a.event_time || '').localeCompare(b.event_time || '')
    );

    const total = results.length;
    const paged = results.slice(offset, offset + perPage);

    return NextResponse.json(
      {
        events: paged,
        total,
        page,
        per_page: perPage,
        pages: Math.ceil(total / perPage),
        source: 'file',
      },
      { headers: CORS }
    );
  } catch (err) {
    console.error('Events API error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: String(err), status: 500 },
      { status: 500, headers: CORS }
    );
  }
}
