// ============================================================
// Events data layer — loads events JSON, supports filtering
// ============================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import type { EventItem, EventType } from './types';

let _cache: EventItem[] | null = null;

/**
 * Load events from the JSON data file (cached after first call).
 */
export function loadEvents(): EventItem[] {
  if (_cache) return _cache;

  const eventsPath = join(process.cwd(), 'src', 'data', 'events.json');
  try {
    const raw = readFileSync(eventsPath, 'utf-8');
    _cache = JSON.parse(raw) as EventItem[];
  } catch {
    _cache = [];
  }
  return _cache;
}

/**
 * Find an event by ID.
 */
export function getEventById(id: number): EventItem | undefined {
  return loadEvents().find((e) => e.id === id);
}

/**
 * Get all unique event types present in the data.
 */
export function getEventTypes(): EventType[] {
  const events = loadEvents();
  return [...new Set(events.map((e) => e.event_type))].sort() as EventType[];
}

/**
 * Get date range of available events.
 */
export function getDateRange(): { earliest: string; latest: string } | null {
  const events = loadEvents();
  if (events.length === 0) return null;

  const sorted = [...events].sort((a, b) => a.event_date.localeCompare(b.event_date));
  return {
    earliest: sorted[0].event_date,
    latest: sorted[sorted.length - 1].event_date,
  };
}
