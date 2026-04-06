import { NextRequest, NextResponse } from 'next/server';
import { filterCompanies, getFilterOptions } from '@/lib/companies';
import { CompaniesQuery, APIResponse, Company, INDEX_TIERS } from '@/lib/types';

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
 * GET /api/companies
 *
 * Query parameters:
 *   index    — asx20 | asx50 | asx100 | asx200 | asx300 | all-ords | small-ords
 *   sector   — GICS sector (partial, case-insensitive)
 *   industry — GICS industry group (partial, case-insensitive)
 *   search   — Search by company name or ASX code
 *   limit    — Max results (default 100, max 500)
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

    const query: CompaniesQuery = {
      index: indexParam as CompaniesQuery['index'],
      sector: params.get('sector') ?? undefined,
      industry: params.get('industry') ?? undefined,
      search: params.get('search') ?? undefined,
      limit: Math.min(parseInt(params.get('limit') ?? '100', 10), 500),
      offset: parseInt(params.get('offset') ?? '0', 10),
    };

    const { companies, total } = filterCompanies(query);

    const response: APIResponse<Company[]> = {
      data: companies,
      meta: {
        total,
        limit: query.limit!,
        offset: query.offset!,
        filters: {
          index: query.index,
          sector: query.sector,
          industry: query.industry,
          search: query.search,
        },
      },
    };

    return NextResponse.json(response, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('Companies API error:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'An internal error occurred.', status: 500 },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
