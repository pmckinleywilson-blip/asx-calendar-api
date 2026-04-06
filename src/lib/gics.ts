// ============================================================
// GICS (Global Industry Classification Standard) mapping
// Maps GICS Industry Group names → parent Sector names
// Covers all industry groups used on the ASX, including
// 2023+ reclassified names.
// ============================================================

/**
 * Map from GICS Industry Group name to its parent Sector.
 * Includes both legacy and current (2023+) naming conventions
 * to handle historical ASX data alongside newer classifications.
 */
export const GICS_MAP: Record<string, string> = {
  // ---- Energy ----
  'Energy Equipment & Services': 'Energy',
  'Oil Gas & Consumable Fuels': 'Energy',
  Energy: 'Energy',

  // ---- Materials ----
  Materials: 'Materials',
  Chemicals: 'Materials',
  'Construction Materials': 'Materials',
  'Containers & Packaging': 'Materials',
  'Metals & Mining': 'Materials',
  'Paper & Forest Products': 'Materials',

  // ---- Industrials ----
  'Capital Goods': 'Industrials',
  'Commercial & Professional Services': 'Industrials',
  Transportation: 'Industrials',

  // ---- Consumer Discretionary ----
  'Automobiles & Components': 'Consumer Discretionary',
  'Consumer Durables & Apparel': 'Consumer Discretionary',
  'Consumer Services': 'Consumer Discretionary',
  'Consumer Discretionary Distribution & Retail': 'Consumer Discretionary',
  Retailing: 'Consumer Discretionary',

  // ---- Consumer Staples ----
  'Food & Staples Retailing': 'Consumer Staples',
  'Food Beverage & Tobacco': 'Consumer Staples',
  'Household & Personal Products': 'Consumer Staples',
  'Consumer Staples Distribution & Retail': 'Consumer Staples',

  // ---- Health Care ----
  'Health Care Equipment & Services': 'Health Care',
  'Pharmaceuticals, Biotechnology & Life Sciences': 'Health Care',

  // ---- Financials ----
  Banks: 'Financials',
  'Diversified Financials': 'Financials',
  Insurance: 'Financials',
  'Financial Services': 'Financials',

  // ---- Information Technology ----
  'Software & Services': 'Information Technology',
  'Technology Hardware & Equipment': 'Information Technology',
  'Semiconductors & Semiconductor Equipment': 'Information Technology',

  // ---- Communication Services ----
  'Media & Entertainment': 'Communication Services',
  'Telecommunication Services': 'Communication Services',

  // ---- Utilities ----
  Utilities: 'Utilities',

  // ---- Real Estate ----
  'Equity Real Estate Investment Trusts (REITs)': 'Real Estate',
  'Equity Real Estate Investment Trusts': 'Real Estate',
  'Real Estate Management & Development': 'Real Estate',
};

/**
 * Build a lower-cased lookup table once so every call to
 * mapIndustryToSector is O(1) instead of O(n).
 */
const LOWER_MAP: Record<string, string> = {};
for (const [group, sector] of Object.entries(GICS_MAP)) {
  LOWER_MAP[group.toLowerCase()] = sector;
}

/**
 * Normalise a raw industry group string by trimming whitespace,
 * collapsing internal runs of whitespace to a single space, and
 * stripping trailing periods.
 */
export function normalizeIndustryGroup(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '');
}

/**
 * Map an industry group name to its parent GICS sector.
 *
 * Performs a case-insensitive lookup after normalising the input.
 * Falls back to fuzzy substring matching if no exact match is
 * found (e.g. "Metals & Mining  " or "Software and Services"
 * will still resolve).
 *
 * @returns The sector name, or `"Other"` when nothing matches.
 */
export function mapIndustryToSector(industryGroup: string): string {
  const cleaned = normalizeIndustryGroup(industryGroup);
  const key = cleaned.toLowerCase();

  // 1. Exact case-insensitive match
  if (LOWER_MAP[key]) {
    return LOWER_MAP[key];
  }

  // 2. Try replacing "and" with "&" (common ASX data variation)
  const withAmpersand = key.replace(/\band\b/g, '&');
  if (LOWER_MAP[withAmpersand]) {
    return LOWER_MAP[withAmpersand];
  }

  // 3. Fuzzy: check if any known key is a substring of the input
  //    or the input is a substring of a known key
  for (const [mapKey, sector] of Object.entries(LOWER_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) {
      return sector;
    }
  }

  return 'Other';
}
