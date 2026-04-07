// ============================================================
// Database layer — Neon Postgres (serverless HTTP)
// ============================================================

import { neon } from '@neondatabase/serverless';

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function getSQL() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[db] DATABASE_URL not set — database operations will be skipped');
    return null;
  }
  return neon(url);
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

export async function initDatabase(): Promise<void> {
  const sql = getSQL();
  if (!sql) return;

  await sql`
    CREATE TABLE IF NOT EXISTS subscribers (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      tickers       TEXT NOT NULL,
      calendar_type TEXT DEFAULT 'outlook',
      feed_token    TEXT UNIQUE NOT NULL,
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS notification_log (
      id            SERIAL PRIMARY KEY,
      subscriber_id INTEGER REFERENCES subscribers(id),
      event_id      INTEGER NOT NULL,
      sent_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(subscriber_id, event_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id             SERIAL PRIMARY KEY,
      ticker         TEXT NOT NULL,
      company_name   TEXT NOT NULL,
      event_type     TEXT NOT NULL CHECK (event_type IN ('earnings', 'investor_day', 'conference', 'ad_hoc')),
      event_date     DATE NOT NULL,
      event_time     TEXT,
      timezone       TEXT DEFAULT 'Australia/Sydney',
      title          TEXT,
      description    TEXT,
      webcast_url    TEXT,
      phone_number   TEXT,
      phone_passcode TEXT,
      replay_url     TEXT,
      fiscal_period  TEXT,
      source         TEXT NOT NULL,
      source_url     TEXT,
      ir_verified    BOOLEAN DEFAULT false,
      status         TEXT DEFAULT 'date_confirmed' CHECK (status IN ('confirmed', 'date_confirmed', 'estimated')),
      notified_at    TIMESTAMPTZ,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(ticker, event_date, event_type)
    )
  `;

  // Add replay_url column to existing tables that predate it
  await sql`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS replay_url TEXT
  `;

  // Migrate status CHECK constraint to support granular statuses:
  //   confirmed      = date + time + webcast (ready to attend)
  //   date_confirmed = date confirmed via IR calendar (time/webcast TBC)
  //   estimated      = date estimated from prior corresponding period
  //   tentative      = detected from announcement but unverified
  //   postponed / cancelled
  // Seen announcements table for the continuous poller.
  // Tracks every announcement ID we've ever processed so we never re-classify.
  await sql`
    CREATE TABLE IF NOT EXISTS seen_announcements (
      document_key  TEXT PRIMARY KEY,
      ticker        TEXT NOT NULL,
      title         TEXT,
      announcement_date DATE,
      first_seen_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Index for cleanup queries (delete old entries to keep table lean)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_seen_announcements_date
    ON seen_announcements (first_seen_at)
  `;

  // Migrate status to simplified 3-tier system:
  //   confirmed      = date + time + webcast (ready to attend)
  //   date_confirmed = date confirmed via IR or ASX announcement (time/webcast TBC)
  //   estimated      = date estimated from prior corresponding period
  await sql`
    ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check
  `;
  // Migrate old statuses before adding new constraint
  await sql`
    UPDATE events SET status = 'date_confirmed'
    WHERE status IN ('tentative', 'postponed', 'cancelled')
  `;
  await sql`
    ALTER TABLE events ADD CONSTRAINT events_status_check
      CHECK (status IN ('confirmed', 'date_confirmed', 'estimated'))
  `;
}

// ---------------------------------------------------------------------------
// Subscriber CRUD
// ---------------------------------------------------------------------------

export interface SubscriberRow {
  id: number;
  email: string;
  tickers: string;       // JSON-encoded array
  calendar_type: string;
  feed_token: string;
  is_active: boolean;
  created_at: string;
}

/**
 * Insert a new subscription and return the created row.
 */
export async function createSubscription(
  email: string,
  tickers: string[],
  calendarType: string,
  feedToken: string,
): Promise<SubscriberRow | null> {
  const sql = getSQL();
  if (!sql) return null;

  const tickersJson = JSON.stringify(tickers);

  const rows = await sql`
    INSERT INTO subscribers (email, tickers, calendar_type, feed_token)
    VALUES (${email}, ${tickersJson}, ${calendarType}, ${feedToken})
    RETURNING *
  `;

  return (rows[0] as SubscriberRow) ?? null;
}

/**
 * Look up a subscription by its unique feed token.
 */
export async function getSubscriptionByToken(
  token: string,
): Promise<SubscriberRow | null> {
  const sql = getSQL();
  if (!sql) return null;

  const rows = await sql`
    SELECT * FROM subscribers WHERE feed_token = ${token} LIMIT 1
  `;

  return (rows[0] as SubscriberRow) ?? null;
}

/**
 * Look up a subscription by email address (for upsert logic).
 */
export async function getSubscriptionByEmail(
  email: string,
): Promise<SubscriberRow | null> {
  const sql = getSQL();
  if (!sql) return null;

  const rows = await sql`
    SELECT * FROM subscribers WHERE email = ${email} LIMIT 1
  `;

  return (rows[0] as SubscriberRow) ?? null;
}

/**
 * Return every active subscription.
 */
export async function getActiveSubscriptions(): Promise<SubscriberRow[]> {
  const sql = getSQL();
  if (!sql) return [];

  const rows = await sql`
    SELECT * FROM subscribers WHERE is_active = true ORDER BY created_at DESC
  `;

  return rows as SubscriberRow[];
}

/**
 * Find all active subscribers whose tickers JSON array contains the given
 * ticker code.  Uses a JSON containment check (`@>`) against a text
 * column storing a JSON array.
 */
export async function getSubscribersForTicker(
  ticker: string,
): Promise<SubscriberRow[]> {
  const sql = getSQL();
  if (!sql) return [];

  const needle = JSON.stringify([ticker]);

  const rows = await sql`
    SELECT * FROM subscribers
    WHERE is_active = true
      AND tickers::jsonb @> ${needle}::jsonb
  `;

  return rows as SubscriberRow[];
}

/**
 * Reactivate a previously deactivated subscription, optionally updating
 * tickers and calendar type.
 */
export async function reactivateSubscription(
  token: string,
  tickers: string[],
  calendarType: string,
): Promise<boolean> {
  const sql = getSQL();
  if (!sql) return false;

  const tickersJson = JSON.stringify(tickers);

  const rows = await sql`
    UPDATE subscribers
    SET is_active = true, tickers = ${tickersJson}, calendar_type = ${calendarType}
    WHERE feed_token = ${token}
    RETURNING id
  `;

  return rows.length > 0;
}

/**
 * Soft-delete: mark subscription as inactive.
 */
export async function deactivateSubscription(token: string): Promise<boolean> {
  const sql = getSQL();
  if (!sql) return false;

  const rows = await sql`
    UPDATE subscribers SET is_active = false
    WHERE feed_token = ${token}
    RETURNING id
  `;

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Notification log
// ---------------------------------------------------------------------------

/**
 * Record that a notification was sent (ignore duplicate).
 */
export async function logNotification(
  subscriberId: number,
  eventId: number,
): Promise<void> {
  const sql = getSQL();
  if (!sql) return;

  await sql`
    INSERT INTO notification_log (subscriber_id, event_id)
    VALUES (${subscriberId}, ${eventId})
    ON CONFLICT (subscriber_id, event_id) DO NOTHING
  `;
}

/**
 * Check whether a notification has already been sent for this
 * subscriber + event pair.
 */
export async function hasNotificationBeenSent(
  subscriberId: number,
  eventId: number,
): Promise<boolean> {
  const sql = getSQL();
  if (!sql) return false;

  const rows = await sql`
    SELECT 1 FROM notification_log
    WHERE subscriber_id = ${subscriberId} AND event_id = ${eventId}
    LIMIT 1
  `;

  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface UpsertEventInput {
  ticker: string;
  company_name: string;
  event_type: 'earnings' | 'investor_day' | 'conference' | 'ad_hoc';
  event_date: string; // YYYY-MM-DD
  event_time?: string | null;
  timezone?: string;
  title?: string | null;
  description?: string | null;
  webcast_url?: string | null;
  phone_number?: string | null;
  phone_passcode?: string | null;
  replay_url?: string | null;
  fiscal_period?: string | null;
  source: string;
  source_url?: string | null;
  ir_verified?: boolean;
  status?: 'confirmed' | 'date_confirmed' | 'estimated';
}

export interface EventRow {
  id: number;
  ticker: string;
  company_name: string;
  event_type: string;
  event_date: string;
  event_time: string | null;
  timezone: string;
  title: string | null;
  description: string | null;
  webcast_url: string | null;
  phone_number: string | null;
  phone_passcode: string | null;
  replay_url: string | null;
  fiscal_period: string | null;
  source: string;
  source_url: string | null;
  ir_verified: boolean;
  status: string;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventsQueryFilters {
  ticker?: string;       // comma-separated tickers
  type?: string;
  status?: string;
  confirmed_only?: boolean;
  date_from?: string;
  date_to?: string;
  q?: string;            // search ticker or company_name
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Event CRUD
// ---------------------------------------------------------------------------

const SOURCE_PRIORITY: Record<string, number> = {
  asx_announcement: 5,   // Richest data: time, webcast URL, dial-in, passcode
  press_release: 4,
  company_ir: 3,          // Early dates (HY/FY/AGM) but usually no webcast details
  calendar_api: 2,
  estimated: 1,
};

function sourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? 0;
}

/**
 * Upsert an event. On conflict (ticker, event_date, event_type):
 *  - Only overwrite fields when the new source has higher or equal priority
 *  - Always fill in null fields regardless of priority
 *  - When ir_verified flips false->true, set status='confirmed'
 *  - Always set updated_at = NOW()
 */
export async function upsertEvent(
  event: UpsertEventInput,
): Promise<EventRow | null> {
  const sql = getSQL();
  if (!sql) return null;

  const newPriority    = sourcePriority(event.source);
  const event_time     = event.event_time     ?? null;
  const timezone       = event.timezone        ?? 'Australia/Sydney';
  const title          = event.title           ?? null;
  const description    = event.description     ?? null;
  const webcast_url    = event.webcast_url     ?? null;
  const phone_number   = event.phone_number    ?? null;
  const phone_passcode = event.phone_passcode  ?? null;
  const replay_url     = event.replay_url      ?? null;
  const fiscal_period  = event.fiscal_period   ?? null;
  const source_url     = event.source_url      ?? null;
  const ir_verified    = event.ir_verified     ?? false;
  const status         = event.status          ?? 'tentative';

  // We use a two-step approach: INSERT then conditionally UPDATE via CTE,
  // because the neon serverless driver's tagged templates don't allow raw
  // SQL interpolation for the CASE expression we need on the existing
  // row's source column. Instead, we do the priority comparison in TS.

  // Step 1: Try the insert; on conflict grab the existing row.
  const inserted = await sql`
    INSERT INTO events (
      ticker, company_name, event_type, event_date, event_time, timezone,
      title, description, webcast_url, phone_number, phone_passcode,
      replay_url, fiscal_period, source, source_url, ir_verified, status
    ) VALUES (
      ${event.ticker}, ${event.company_name}, ${event.event_type},
      ${event.event_date}, ${event_time}, ${timezone},
      ${title}, ${description}, ${webcast_url},
      ${phone_number}, ${phone_passcode}, ${replay_url},
      ${fiscal_period}, ${event.source}, ${source_url},
      ${ir_verified}, ${status}
    )
    ON CONFLICT (ticker, event_date, event_type) DO UPDATE SET
      updated_at = events.updated_at
    RETURNING *
  `;

  const existing = inserted[0] as EventRow | undefined;
  if (!existing) return null;

  // If the row was freshly created (created_at ~= updated_at and source
  // matches), no merge needed — return as-is.
  // Detect conflict: if source differs from what we tried to insert, OR
  // the id already existed, we need to merge.
  const wasInsert = existing.source === event.source
    && existing.company_name === event.company_name
    && existing.created_at === existing.updated_at;

  if (wasInsert) {
    return existing;
  }

  // Step 2: Merge — existing row was already there, apply priority rules.
  const existingPriority = sourcePriority(existing.source);
  const higherOrEqual    = newPriority >= existingPriority;

  // Build the merged values
  const mergedCompanyName  = higherOrEqual ? event.company_name : existing.company_name;
  const mergedEventTime    = existing.event_time === null ? event_time
                           : (higherOrEqual && event_time !== null ? event_time : existing.event_time);
  const mergedTimezone     = existing.timezone === null ? timezone
                           : (higherOrEqual && timezone !== null ? timezone : existing.timezone);
  const mergedTitle        = existing.title === null ? title
                           : (higherOrEqual && title !== null ? title : existing.title);
  const mergedDescription  = existing.description === null ? description
                           : (higherOrEqual && description !== null ? description : existing.description);
  const mergedWebcastUrl   = existing.webcast_url === null ? webcast_url
                           : (higherOrEqual && webcast_url !== null ? webcast_url : existing.webcast_url);
  const mergedPhoneNumber  = existing.phone_number === null ? phone_number
                           : (higherOrEqual && phone_number !== null ? phone_number : existing.phone_number);
  const mergedPhonePasscode = existing.phone_passcode === null ? phone_passcode
                            : (higherOrEqual && phone_passcode !== null ? phone_passcode : existing.phone_passcode);
  const mergedReplayUrl    = existing.replay_url === null ? replay_url
                           : (higherOrEqual && replay_url !== null ? replay_url : existing.replay_url);
  const mergedFiscalPeriod = existing.fiscal_period === null ? fiscal_period
                           : (higherOrEqual && fiscal_period !== null ? fiscal_period : existing.fiscal_period);
  const mergedSource       = higherOrEqual ? event.source : existing.source;
  const mergedSourceUrl    = existing.source_url === null ? source_url
                           : (higherOrEqual && source_url !== null ? source_url : existing.source_url);
  const mergedIrVerified   = ir_verified ? true : existing.ir_verified;

  // Derive status from the data we actually have after merging.
  // Status is computed, not stored directly — it reflects what info is available:
  //   confirmed      = date + time + webcast (ready to attend)
  //   date_confirmed = date confirmed (from IR page or ASX announcement)
  //   estimated      = date based on prior corresponding period
  const mergedStatus = (() => {
    // If we have a webcast URL and time, it's fully confirmed
    if (mergedWebcastUrl && mergedEventTime) return 'confirmed';
    // If either source says estimated and nothing better overrides
    if (status === 'estimated' && existing.status === 'estimated') return 'estimated';
    // Any real date source (IR page, ASX announcement) = date_confirmed
    return 'date_confirmed';
  })();

  const updated = await sql`
    UPDATE events SET
      company_name   = ${mergedCompanyName},
      event_time     = ${mergedEventTime},
      timezone       = ${mergedTimezone},
      title          = ${mergedTitle},
      description    = ${mergedDescription},
      webcast_url    = ${mergedWebcastUrl},
      phone_number   = ${mergedPhoneNumber},
      phone_passcode = ${mergedPhonePasscode},
      replay_url     = ${mergedReplayUrl},
      fiscal_period  = ${mergedFiscalPeriod},
      source         = ${mergedSource},
      source_url     = ${mergedSourceUrl},
      ir_verified    = ${mergedIrVerified},
      status         = ${mergedStatus},
      updated_at     = NOW()
    WHERE id = ${existing.id}
    RETURNING *
  `;

  return (updated[0] as EventRow) ?? null;
}

/**
 * Query events with optional filters. Returns paginated results with total.
 */
export async function getEventsFromDB(
  filters: EventsQueryFilters = {},
): Promise<{ events: EventRow[]; total: number }> {
  const sql = getSQL();
  if (!sql) return { events: [], total: 0 };

  const tickers = filters.ticker
    ? filters.ticker.split(',').map((t) => t.trim().toUpperCase())
    : null;

  const limit  = filters.limit  ?? 100;
  const offset = filters.offset ?? 0;

  // Build query with simple conditions — Neon tagged templates
  // struggle with complex IS NULL OR patterns, so we use a two-step
  // approach: fetch broadly then filter in JS for optional params.

  let rows;

  if (tickers && tickers.length > 0) {
    rows = await sql`
      SELECT * FROM events
      WHERE ticker = ANY(${tickers})
        AND event_date >= COALESCE(${filters.date_from ?? null}::date, '1900-01-01'::date)
        AND event_date <= COALESCE(${filters.date_to ?? null}::date, '2100-01-01'::date)
      ORDER BY event_date ASC, event_time ASC NULLS LAST
      LIMIT 5000
    `;
  } else if (filters.q) {
    const q = `%${filters.q}%`;
    rows = await sql`
      SELECT * FROM events
      WHERE (ticker ILIKE ${q} OR company_name ILIKE ${q})
        AND event_date >= COALESCE(${filters.date_from ?? null}::date, '1900-01-01'::date)
        AND event_date <= COALESCE(${filters.date_to ?? null}::date, '2100-01-01'::date)
      ORDER BY event_date ASC, event_time ASC NULLS LAST
      LIMIT 5000
    `;
  } else {
    rows = await sql`
      SELECT * FROM events
      WHERE event_date >= COALESCE(${filters.date_from ?? null}::date, '1900-01-01'::date)
        AND event_date <= COALESCE(${filters.date_to ?? null}::date, '2100-01-01'::date)
      ORDER BY event_date ASC, event_time ASC NULLS LAST
      LIMIT 5000
    `;
  }

  // Apply remaining filters in JS
  let events = (rows as EventRow[]).filter((e) => {
    if (filters.type && e.event_type !== filters.type) return false;
    if (filters.status && e.status !== filters.status) return false;
    if (filters.confirmed_only && e.status !== 'confirmed' && e.status !== 'date_confirmed') return false;
    return true;
  });

  const total = events.length;

  // Apply pagination
  events = events.slice(offset, offset + limit);

  return { events, total };
}

/**
 * Get a single event by its ID.
 */
export async function getEventByIdFromDB(
  id: number,
): Promise<EventRow | null> {
  const sql = getSQL();
  if (!sql) return null;

  const rows = await sql`
    SELECT * FROM events WHERE id = ${id} LIMIT 1
  `;

  return (rows[0] as EventRow) ?? null;
}

/**
 * Get all events that are confirmed or date_confirmed, not yet notified,
 * and with event_date >= today.
 */
export async function getUnnotifiedConfirmedEvents(): Promise<EventRow[]> {
  const sql = getSQL();
  if (!sql) return [];

  const rows = await sql`
    SELECT * FROM events
    WHERE status IN ('confirmed', 'date_confirmed')
      AND notified_at IS NULL
      AND event_date >= CURRENT_DATE
    ORDER BY event_date ASC, event_time ASC NULLS LAST
  `;

  return rows as EventRow[];
}

/**
 * Mark a single event as notified (set notified_at = NOW()).
 */
export async function markEventNotified(eventId: number): Promise<void> {
  const sql = getSQL();
  if (!sql) return;

  await sql`
    UPDATE events SET notified_at = NOW() WHERE id = ${eventId}
  `;
}

/**
 * Get all future events for a list of tickers.
 */
export async function getEventsByTickers(
  tickers: string[],
): Promise<EventRow[]> {
  const sql = getSQL();
  if (!sql) return [];

  const rows = await sql`
    SELECT * FROM events
    WHERE ticker = ANY(${tickers})
      AND event_date >= CURRENT_DATE
    ORDER BY event_date ASC, event_time ASC NULLS LAST
  `;

  return rows as EventRow[];
}

/**
 * Delete events with event_date before the given date (cleanup).
 */
export async function deleteOldEvents(beforeDate: string): Promise<number> {
  const sql = getSQL();
  if (!sql) return 0;

  const rows = await sql`
    DELETE FROM events WHERE event_date < ${beforeDate}::date RETURNING id
  `;

  return rows.length;
}
