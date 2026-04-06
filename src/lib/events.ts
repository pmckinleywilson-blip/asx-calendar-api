// ============================================================
// Events data layer — loads sample events, supports filtering
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { CalendarEvent, EventsQuery, EventType } from './types';
import { loadCompanies } from './companies';

let _cache: CalendarEvent[] | null = null;

/**
 * Load events from the JSON data file (cached).
 */
export function loadEvents(): CalendarEvent[] {
  if (_cache) return _cache;

  const eventsPath = join(process.cwd(), 'src', 'data', 'events.json');
  try {
    const raw = readFileSync(eventsPath, 'utf-8');
    _cache = JSON.parse(raw) as CalendarEvent[];
  } catch {
    _cache = [];
  }
  return _cache;
}

/**
 * Filter events by query parameters.
 */
export function filterEvents(query: EventsQuery): {
  events: CalendarEvent[];
  total: number;
} {
  let results = loadEvents();
  const companies = loadCompanies();

  // Filter by specific company codes
  if (query.code) {
    const codes = query.code
      .split(',')
      .map((c) => c.trim().toUpperCase());
    results = results.filter((e) => codes.includes(e.companyCode));
  }

  // Filter by index — resolve which codes belong to that index, then filter
  if (query.index) {
    const indexCodes = new Set(
      companies
        .filter((c) => c.indices.includes(query.index!))
        .map((c) => c.code)
    );
    results = results.filter((e) => indexCodes.has(e.companyCode));
  }

  // Filter by sector
  if (query.sector) {
    const s = query.sector.toLowerCase();
    const sectorCodes = new Set(
      companies
        .filter((c) => c.sector.toLowerCase().includes(s))
        .map((c) => c.code)
    );
    results = results.filter((e) => sectorCodes.has(e.companyCode));
  }

  // Filter by industry
  if (query.industry) {
    const ind = query.industry.toLowerCase();
    const industryCodes = new Set(
      companies
        .filter((c) => c.industryGroup.toLowerCase().includes(ind))
        .map((c) => c.code)
    );
    results = results.filter((e) => industryCodes.has(e.companyCode));
  }

  // Filter by event type
  if (query.type) {
    results = results.filter((e) => e.eventType === query.type);
  }

  // Filter by date range
  if (query.from) {
    results = results.filter((e) => e.date >= query.from!);
  }
  if (query.to) {
    results = results.filter((e) => e.date <= query.to!);
  }

  // Sort by date ascending
  results.sort((a, b) => a.date.localeCompare(b.date));

  const total = results.length;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;

  return {
    events: results.slice(offset, offset + limit),
    total,
  };
}

/**
 * Get all unique event types present in the data.
 */
export function getEventTypes(): EventType[] {
  const events = loadEvents();
  return [...new Set(events.map((e) => e.eventType))].sort() as EventType[];
}

/**
 * Get date range of available events.
 */
export function getDateRange(): { earliest: string; latest: string } | null {
  const events = loadEvents();
  if (events.length === 0) return null;

  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));
  return {
    earliest: sorted[0].date,
    latest: sorted[sorted.length - 1].date,
  };
}
