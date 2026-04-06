// ============================================================
// ASX Calendar API — Core Types
// ============================================================

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

/** Calendar event types */
export const EVENT_TYPES = [
  'earnings',
  'agm',
  'egm',
  'ex-dividend',
  'dividend-payment',
  'ipo',
  'trading-halt',
  'capital-raise',
  'other',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// ---- Data models ----

export interface Company {
  code: string;            // e.g. "BHP"
  name: string;            // e.g. "BHP Group Limited"
  sector: GICSSector;
  industryGroup: string;   // GICS industry group
  marketCapRank: number;   // 1 = largest
  indices: IndexTier[];    // computed from rank
}

export interface CalendarEvent {
  id: string;
  companyCode: string;
  companyName: string;
  eventType: EventType;
  title: string;
  date: string;             // ISO 8601 date  (YYYY-MM-DD)
  time?: string;            // Optional HH:MM in AEST
  description?: string;
  source?: string;          // URL or label
  confirmed: boolean;       // true = confirmed, false = estimated
}

// ---- API request / response ----

export interface EventsQuery {
  index?: IndexTier;
  sector?: string;
  industry?: string;
  type?: EventType;
  code?: string;            // comma-separated ASX codes
  from?: string;            // ISO date
  to?: string;              // ISO date
  limit?: number;
  offset?: number;
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

export interface APIError {
  error: string;
  message: string;
  status: number;
}
