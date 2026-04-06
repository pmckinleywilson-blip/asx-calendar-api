// ============================================================
// ASX Calendar API — Core Types
// ============================================================

/** Event types — teleconferences and webcasts only */
export const EVENT_TYPES = [
  'earnings',
  'investor_day',
  'conference',
  'ad_hoc',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** ASX index tiers (derived from market-cap rank) */
export const INDEX_TIERS = [
  'asx20',
  'asx50',
  'asx100',
  'asx200',
  'asx300',
  'all-ords',
  'small-ords',
] as const;

export type IndexTier = (typeof INDEX_TIERS)[number];

/** GICS Sectors used on the ASX */
export const GICS_SECTORS = [
  'Energy',
  'Materials',
  'Industrials',
  'Consumer Discretionary',
  'Consumer Staples',
  'Health Care',
  'Financials',
  'Information Technology',
  'Communication Services',
  'Utilities',
  'Real Estate',
] as const;

export type GICSSector = (typeof GICS_SECTORS)[number];

// ---- Data models ----

export interface Company {
  code: string;            // e.g. "BHP"
  name: string;            // e.g. "BHP Group Limited"
  sector: string;          // GICS sector
  industryGroup: string;   // GICS industry group
  marketCapRank: number;   // 1 = largest
  indices: IndexTier[];    // computed from rank
}

export interface EventItem {
  id: number;
  ticker: string;              // ASX code
  company_name: string;
  event_type: EventType;
  event_date: string;          // YYYY-MM-DD
  event_time: string | null;   // HH:MM (24h AEST)
  timezone: string;            // e.g. "Australia/Sydney"
  title: string | null;
  description: string | null;
  webcast_url: string | null;
  phone_number: string | null;
  phone_passcode: string | null;
  replay_url: string | null;
  fiscal_period: string | null; // e.g. "HY2026", "FY2026"
  source: string;
  source_url: string | null;
  ir_verified: boolean;
  status: 'confirmed' | 'tentative';
  created_at: string;
  updated_at: string;
}

export interface EventListResponse {
  events: EventItem[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface SubscribeResponse {
  feed_url: string;
  events_confirmed: number;
  events_pending: number;
  message: string;
}

// ---- API query types ----

export interface EventsQuery {
  index?: IndexTier;
  sector?: string;
  type?: EventType;
  confirmed_only?: boolean;
  ticker?: string;           // comma-separated
  q?: string;                // search query
  date_from?: string;
  date_to?: string;
  per_page?: number;
  page?: number;
}

export interface CompaniesQuery {
  index?: IndexTier;
  sector?: string;
  industry?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface APIResponse<T> {
  data: T;
  meta: {
    total: number;
    limit: number;
    offset: number;
    filters: Record<string, string | undefined>;
  };
}
