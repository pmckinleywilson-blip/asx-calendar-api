import { NextRequest, NextResponse } from 'next/server';
import { writeFileSync } from 'fs';
import { join } from 'path';
import https from 'https';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const API_URL =
  'https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file?access_token=83ff96335c2d45a094df02a206a39ff4';

// GICS Industry Group → Sector mapping (inlined for serverless)
const GICS_MAP: Record<string, string> = {
  'energy equipment & services': 'Energy',
  'oil gas & consumable fuels': 'Energy',
  energy: 'Energy',
  materials: 'Materials',
  chemicals: 'Materials',
  'construction materials': 'Materials',
  'containers & packaging': 'Materials',
  'metals & mining': 'Materials',
  'paper & forest products': 'Materials',
  'capital goods': 'Industrials',
  'commercial & professional services': 'Industrials',
  transportation: 'Industrials',
  'automobiles & components': 'Consumer Discretionary',
  'consumer durables & apparel': 'Consumer Discretionary',
  'consumer services': 'Consumer Discretionary',
  'consumer discretionary distribution & retail': 'Consumer Discretionary',
  retailing: 'Consumer Discretionary',
  'food & staples retailing': 'Consumer Staples',
  'food beverage & tobacco': 'Consumer Staples',
  'household & personal products': 'Consumer Staples',
  'consumer staples distribution & retail': 'Consumer Staples',
  'health care equipment & services': 'Health Care',
  'pharmaceuticals, biotechnology & life sciences': 'Health Care',
  banks: 'Financials',
  'diversified financials': 'Financials',
  'financial services': 'Financials',
  insurance: 'Financials',
  'software & services': 'Information Technology',
  'technology hardware & equipment': 'Information Technology',
  'semiconductors & semiconductor equipment': 'Information Technology',
  'media & entertainment': 'Communication Services',
  'telecommunication services': 'Communication Services',
  utilities: 'Utilities',
  'equity real estate investment trusts (reits)': 'Real Estate',
  'equity real estate investment trusts': 'Real Estate',
  'real estate management & development': 'Real Estate',
};

function mapSector(industry: string): string {
  const key = industry.toLowerCase().trim();
  if (GICS_MAP[key]) return GICS_MAP[key];
  // Fuzzy match
  for (const [k, v] of Object.entries(GICS_MAP)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return 'Other';
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
    else { current += ch; }
  }
  fields.push(current);
  return fields;
}

const ETF_KEYWORDS = /\b(ETF|FUND|INDEX|MANAGED|VANGUARD|ISHARES|BETASHARES|SPDR)\b/i;
function isETF(name: string, industry: string): boolean {
  if (/REIT/i.test(industry)) return false;
  return ETF_KEYWORDS.test(name);
}

/**
 * GET /api/cron/update-companies
 *
 * Fetches the full ASX company directory from the official API,
 * processes it, and writes to src/data/asx-companies.csv.
 *
 * Protected by CRON_SECRET — only callable by Vercel Cron or with the secret.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sets this automatically for cron jobs)
  const authHeader = request.headers.get('authorization');
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const raw = await fetchUrl(API_URL);
    const lines = raw.trim().split('\n');
    if (lines.length < 2) {
      return NextResponse.json({ error: 'Empty response from ASX API' }, { status: 502 });
    }

    // Parse header
    const header = parseCSVLine(lines[0]);
    const colMap: Record<string, number> = {};
    header.forEach((h, i) => {
      colMap[h.trim().toLowerCase().replace(/\s+/g, '_')] = i;
    });

    const codeIdx = colMap['asx_code'] ?? 0;
    const nameIdx = colMap['company_name'] ?? 1;
    const industryIdx = colMap['gics_industry_group'] ?? 2;
    const capIdx = colMap['market_cap'] ?? -1;

    interface CompanyRow {
      code: string;
      name: string;
      industry: string;
      sector: string;
      marketCap: number;
    }

    const companies: CompanyRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      const code = (fields[codeIdx] ?? '').trim().toUpperCase();
      const name = (fields[nameIdx] ?? '').trim().replace(/\.+$/, '').replace(/\s+/g, ' ');
      const industry = (fields[industryIdx] ?? '').trim();

      if (!code || !name) continue;
      if (!industry || industry === 'Not Applic' || industry === 'N/A') continue;
      if (isETF(name, industry)) continue;

      const cap = capIdx >= 0 ? parseInt(fields[capIdx] ?? '0', 10) || 0 : 0;
      const sector = mapSector(industry);

      companies.push({ code, name, industry, sector, marketCap: cap });
    }

    // Sort by market cap descending
    companies.sort((a, b) => b.marketCap - a.marketCap);

    // Write CSV
    const csvLines = ['code,company_name,gics_sector,gics_industry_group,market_cap_rank'];
    companies.forEach((c, i) => {
      const safeName = c.name.includes(',') ? `"${c.name}"` : c.name;
      const safeIndustry = c.industry.includes(',') ? `"${c.industry}"` : c.industry;
      csvLines.push(`${c.code},${safeName},${c.sector},${safeIndustry},${i + 1}`);
    });

    const csvPath = join(process.cwd(), 'src', 'data', 'asx-companies.csv');
    writeFileSync(csvPath, csvLines.join('\n') + '\n', 'utf-8');

    return NextResponse.json({
      status: 'ok',
      companies_written: companies.length,
      top_5: companies.slice(0, 5).map((c) => `${c.code} (${c.sector})`),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Cron update-companies error:', err);
    return NextResponse.json(
      { error: 'Failed to update companies', detail: String(err) },
      { status: 500 }
    );
  }
}
