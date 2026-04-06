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
