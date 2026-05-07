import { NextRequest, NextResponse } from 'next/server';
import { loadEvents } from '@/lib/events';
import { loadCompanies } from '@/lib/companies';
import { getEventsFromDB, eventRowToItem } from '@/lib/db';
import type { EventItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Human-readable status labels for the API and frontend
const STATUS_LABELS: Record<string, string> = {
  confirmed:      'Confirmed',
  date_confirmed: 'Date confirmed, time TBC',
  estimated:      'Estimated based on PCP',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

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

        // Map DB rows to EventItem shape, then attach human-readable status_label
        const events = dbEvents.map((row) => ({
          ...eventRowToItem(row),
          status_label: statusLabel(row.status),
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
      results = results.filter((e) => e.status === 'confirmed' || e.status === 'date_confirmed');
    }

    // Default lower bound is today — past events shouldn't show unless
    // the caller explicitly asks for them via date_from.
    const today = new Date().toISOString().substring(0, 10);
    const dateFrom = p.get('date_from') || today;
    results = results.filter((e) => e.event_date >= dateFrom);
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
