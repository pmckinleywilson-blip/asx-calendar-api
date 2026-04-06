import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  getSubscriptionByEmail,
  createSubscription,
  reactivateSubscription,
} from '@/lib/db';
import { sendWelcomeEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function OPTIONS() {
  return NextResponse.json(null, { headers: CORS });
}

/**
 * POST /api/subscribe
 *
 * Accept { email, tickers, calendar_type } and create (or update) a
 * subscription.  Persists to Neon Postgres when DATABASE_URL is set;
 * falls back to a stateless response for local development.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, tickers, calendar_type } = body;

    if (!email || !tickers || !Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json(
        { detail: 'Email and at least one ticker required.' },
        { status: 400, headers: CORS },
      );
    }

    const calendarType: string = calendar_type ?? 'outlook';
    const host = request.headers.get('host') ?? 'asx-calendar-api.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';

    // ------------------------------------------------------------------
    // Try database path
    // ------------------------------------------------------------------
    if (process.env.DATABASE_URL) {
      // Check for existing subscription (upsert)
      const existing = await getSubscriptionByEmail(email);

      let feedToken: string;

      if (existing && existing.is_active) {
        // Already active — return existing info
        feedToken = existing.feed_token;
        const feedUrl = `${protocol}://${host}/api/feed/${feedToken}.ics`;

        console.log(`[subscribe] Existing active: ${email}`);

        return NextResponse.json(
          {
            feed_url: feedUrl,
            events_confirmed: 0,
            events_pending: tickers.length,
            message: `You are already subscribed. Your feed URL is unchanged.`,
          } satisfies import('@/lib/types').SubscribeResponse,
          { headers: CORS },
        );
      }

      if (existing && !existing.is_active) {
        // Was unsubscribed — reactivate with updated tickers
        feedToken = existing.feed_token;
        await reactivateSubscription(feedToken, tickers, calendarType);

        const feedUrl = `${protocol}://${host}/api/feed/${feedToken}.ics`;

        sendWelcomeEmail(email, tickers, feedUrl).catch((err) =>
          console.error('[subscribe] Welcome email error:', err),
        );

        console.log(`[subscribe] Reactivated: ${email} -> ${tickers.join(',')}`);

        return NextResponse.json(
          {
            feed_url: feedUrl,
            events_confirmed: 0,
            events_pending: tickers.length,
            message: `Welcome back! Resubscribed to ${tickers.length} ASX codes. Calendar invites will be sent to ${email} as events are confirmed.`,
          } satisfies import('@/lib/types').SubscribeResponse,
          { headers: CORS },
        );
      }

      // New subscription
      feedToken = randomBytes(32).toString('hex');
      const row = await createSubscription(email, tickers, calendarType, feedToken);

      if (!row) {
        // Database returned null — treat as degraded
        console.warn('[subscribe] createSubscription returned null');
      }

      const feedUrl = `${protocol}://${host}/api/feed/${feedToken}.ics`;

      // Fire-and-forget welcome email (don't block the response)
      sendWelcomeEmail(email, tickers, feedUrl).catch((err) =>
        console.error('[subscribe] Welcome email error:', err),
      );

      console.log(`[subscribe] ${email} -> ${tickers.join(',')} (${calendarType})`);

      return NextResponse.json(
        {
          feed_url: feedUrl,
          events_confirmed: 0,
          events_pending: tickers.length,
          message: `Subscribed to ${tickers.length} ASX codes. Calendar invites will be sent to ${email} as events are confirmed.`,
        } satisfies import('@/lib/types').SubscribeResponse,
        { headers: CORS },
      );
    }

    // ------------------------------------------------------------------
    // Fallback — no database (local dev)
    // ------------------------------------------------------------------
    const feedToken = randomBytes(32).toString('hex');
    const feedUrl = `${protocol}://${host}/api/feed/${feedToken}.ics`;

    console.log(`[subscribe] (no db) ${email} -> ${tickers.join(',')} (${calendarType})`);

    return NextResponse.json(
      {
        feed_url: feedUrl,
        events_confirmed: 0,
        events_pending: tickers.length,
        message: `Subscribed to ${tickers.length} ASX codes. Calendar invites will be sent to ${email} as events are confirmed.`,
      } satisfies import('@/lib/types').SubscribeResponse,
      { headers: CORS },
    );
  } catch (err) {
    console.error('Subscribe error:', err);
    return NextResponse.json(
      { detail: 'An error occurred while subscribing.' },
      { status: 500, headers: CORS },
    );
  }
}
