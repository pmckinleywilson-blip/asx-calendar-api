import { NextRequest, NextResponse } from 'next/server';
import { loadEvents } from '@/lib/events';
import { loadCompanies } from '@/lib/companies';
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
 * Matches the SP500 project's query interface:
 *   q            — search ticker or company name
 *   ticker       — comma-separated ASX codes
 *   index        — asx20|asx50|asx100|asx200|asx300|all-ords|small-ords
 *   sector       — GICS sector (partial, case-insensitive)
 *   type         — earnings|investor_day|conference|ad_hoc
 *   confirmed_only — "true" to filter tentative
 *   date_from    — YYYY-MM-DD
 *   date_to      — YYYY-MM-DD
 *   per_page     — results per page (default 5000)
 *   page         — page number (default 1)
 */
export function GET(request: NextRequest) {
  try {
    const p = request.nextUrl.searchParams;
    let results = loadEvents() as EventItem[];
    const companies = loadCompanies();

    // Search (q) — ticker or company name
    const q = p.get('q');
    if (q) {
      const ql = q.toLowerCase();
      results = results.filter(
        (e) =>
          e.ticker.toLowerCase().includes(ql) ||
          e.company_name.toLowerCase().includes(ql)
      );
    }

    // Ticker filter
    const ticker = p.get('ticker');
    if (ticker) {
      const codes = ticker.split(',').map((t) => t.trim().toUpperCase());
      results = results.filter((e) => codes.includes(e.ticker));
    }

    // Index filter — resolve company codes in that index
    const index = p.get('index');
    if (index) {
      const indexCodes = new Set(
        companies
          .filter((c) => c.indices.includes(index as any))
          .map((c) => c.code)
      );
      results = results.filter((e) => indexCodes.has(e.ticker));
    }

    // Sector filter
    const sector = p.get('sector');
    if (sector) {
      const sl = sector.toLowerCase();
      const sectorCodes = new Set(
        companies
          .filter((c) => c.sector.toLowerCase().includes(sl))
          .map((c) => c.code)
      );
      results = results.filter((e) => sectorCodes.has(e.ticker));
    }

    // Event type filter
    const type = p.get('type');
    if (type) {
      results = results.filter((e) => e.event_type === type);
    }

    // Confirmed only
    if (p.get('confirmed_only') === 'true') {
      results = results.filter((e) => e.status === 'confirmed');
    }

    // Date range
    const dateFrom = p.get('date_from');
    if (dateFrom) {
      results = results.filter((e) => e.event_date >= dateFrom);
    }
    const dateTo = p.get('date_to');
    if (dateTo) {
      results = results.filter((e) => e.event_date <= dateTo);
    }

    // Sort by date
    results.sort((a, b) => a.event_date.localeCompare(b.event_date) || (a.event_time || '').localeCompare(b.event_time || ''));

    // Pagination
    const total = results.length;
    const perPage = Math.min(parseInt(p.get('per_page') || '5000', 10), 5000);
    const page = Math.max(parseInt(p.get('page') || '1', 10), 1);
    const offset = (page - 1) * perPage;
    const paged = results.slice(offset, offset + perPage);

    return NextResponse.json(
      {
        events: paged,
        total,
        page,
        per_page: perPage,
        pages: Math.ceil(total / perPage),
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
