import { NextRequest, NextResponse } from 'next/server';

/**
 * /.well-known/ai-plugin.json
 *
 * Agent discovery manifest — follows the OpenAI plugin spec.
 * AI agents (ChatGPT, Claude, open-source tool-use agents) look for this
 * file to discover what the API does and how to call it.
 */
export function GET(request: NextRequest) {
  const host = request.headers.get('host') ?? 'asx-calendar-api.vercel.app';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  const baseUrl = `${protocol}://${host}`;

  const manifest = {
    schema_version: 'v1',
    name_for_human: 'ASX Calendar API',
    name_for_model: 'asx_calendar_api',
    description_for_human:
      'Browse upcoming earnings dates, AGMs, ex-dividend dates, and other corporate events for all ASX-listed companies. Filter by index (ASX 20/50/100/200/300, All Ords, Small Ords), GICS sector, industry, and event type.',
    description_for_model:
      'Query the Australian Securities Exchange (ASX) corporate events calendar. Returns structured JSON of upcoming events (earnings results, AGMs, EGMs, ex-dividend dates, dividend payments, IPOs, trading halts, capital raises) for ~2000 ASX-listed companies. Supports filtering by ASX index tier (asx20, asx50, asx100, asx200, asx300, all-ords, small-ords), GICS sector, GICS industry group, event type, company code, and date range. Use GET /api/events for events, GET /api/companies for company lookup, GET /api/filters for available filter values.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: `${baseUrl}/openapi.json`,
    },
    logo_url: `${baseUrl}/logo.png`,
    contact_email: 'admin@example.com',
    legal_info_url: `${baseUrl}/terms`,
  };

  return NextResponse.json(manifest, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
