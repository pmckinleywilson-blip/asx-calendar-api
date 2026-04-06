// ============================================================
// Company data loader — reads CSV, computes index membership
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { Company, IndexTier, GICSSector, CompaniesQuery, GICS_SECTORS } from './types';

let _cache: Company[] | null = null;

/**
 * Derive which ASX indices a company belongs to based on market-cap rank.
 *
 *   ASX 20   → rank 1-20
 *   ASX 50   → rank 1-50
 *   ASX 100  → rank 1-100
 *   ASX 200  → rank 1-200
 *   ASX 300  → rank 1-300
 *   All Ords → rank 1-500  (approx 500 largest)
 *   Small Ords → rank 101-300
 */
function deriveIndices(rank: number): IndexTier[] {
  const indices: IndexTier[] = [];
  if (rank <= 20) indices.push('asx20');
  if (rank <= 50) indices.push('asx50');
  if (rank <= 100) indices.push('asx100');
  if (rank <= 200) indices.push('asx200');
  if (rank <= 300) indices.push('asx300');
  if (rank <= 500) indices.push('all-ords');
  if (rank > 100 && rank <= 300) indices.push('small-ords');
  return indices;
}

/**
 * Parse the ASX companies CSV file.
 * Expected columns: code, company_name, gics_sector, gics_industry_group, market_cap_rank
 */
function parseCSV(raw: string): Company[] {
  const lines = raw.trim().split('\n');
  const header = lines[0];
  if (!header) return [];

  // Determine column indices from header
  const cols = parseCSVLine(header);
  const colMap: Record<string, number> = {};
  cols.forEach((c, i) => {
    colMap[c.trim().toLowerCase().replace(/\s+/g, '_')] = i;
  });

  const codeIdx = colMap['code'] ?? 0;
  const nameIdx = colMap['company_name'] ?? 1;
  const sectorIdx = colMap['gics_sector'] ?? 2;
  const industryIdx = colMap['gics_industry_group'] ?? 3;
  const rankIdx = colMap['market_cap_rank'] ?? 4;

  const companies: Company[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const rank = parseInt(fields[rankIdx] ?? '9999', 10);
    const sector = (fields[sectorIdx] ?? '').trim() as GICSSector;

    companies.push({
      code: (fields[codeIdx] ?? '').trim().toUpperCase(),
      name: (fields[nameIdx] ?? '').trim(),
      sector,
      industryGroup: (fields[industryIdx] ?? '').trim(),
      marketCapRank: rank,
      indices: deriveIndices(rank),
    });
  }

  return companies;
}

/** Simple CSV line parser that handles quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Load all companies from CSV (cached after first call).
 */
export function loadCompanies(): Company[] {
  if (_cache) return _cache;

  const csvPath = join(process.cwd(), 'src', 'data', 'asx-companies.csv');
  const raw = readFileSync(csvPath, 'utf-8');
  _cache = parseCSV(raw);
  return _cache;
}

/**
 * Filter companies by query parameters.
 */
export function filterCompanies(query: CompaniesQuery): {
  companies: Company[];
  total: number;
} {
  let results = loadCompanies();

  // Index filter
  if (query.index) {
    results = results.filter((c) => c.indices.includes(query.index!));
  }

  // Sector filter (case-insensitive partial match)
  if (query.sector) {
    const s = query.sector.toLowerCase();
    results = results.filter((c) => c.sector.toLowerCase().includes(s));
  }

  // Industry filter (case-insensitive partial match)
  if (query.industry) {
    const ind = query.industry.toLowerCase();
    results = results.filter((c) => c.industryGroup.toLowerCase().includes(ind));
  }

  // Search (code or name)
  if (query.search) {
    const q = query.search.toLowerCase();
    results = results.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }

  const total = results.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;

  return {
    companies: results.slice(offset, offset + limit),
    total,
  };
}

/**
 * Look up a single company by ASX code.
 */
export function getCompanyByCode(code: string): Company | undefined {
  return loadCompanies().find((c) => c.code === code.toUpperCase());
}

/**
 * Return available sectors and industry groups for filter UIs.
 */
export function getFilterOptions() {
  const companies = loadCompanies();
  const sectors = [...new Set(companies.map((c) => c.sector))].sort();
  const industries = [...new Set(companies.map((c) => c.industryGroup))].sort();
  return { sectors, industries };
}
