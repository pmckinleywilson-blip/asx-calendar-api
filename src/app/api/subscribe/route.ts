import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

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
 * Accept { email, tickers, calendar_type } and create a subscription.
 * For the MVP, this stores subscriptions in memory (will be migrated to
 * Vercel Postgres for production persistence + email delivery).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, tickers, calendar_type } = body;

    if (!email || !tickers || !Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json(
        { detail: 'Email and at least one ticker required.' },
        { status: 400, headers: CORS }
      );
    }

    // Generate a unique feed token
    const feedToken = randomBytes(32).toString('hex');
    const host = request.headers.get('host') ?? 'asx-calendar-api.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const feedUrl = `${protocol}://${host}/api/feed/${feedToken}.ics`;

    // TODO: Persist to database (Vercel Postgres)
    // For now, return success with the feed URL
    console.log(`[subscribe] ${email} → ${tickers.join(',')} (${calendar_type})`);

    return NextResponse.json(
      {
        feed_url: feedUrl,
        events_confirmed: 0,
        events_pending: tickers.length,
        message: `Subscribed to ${tickers.length} ASX codes. Calendar invites will be sent to ${email} as events are confirmed.`,
      },
      { headers: CORS }
    );
  } catch (err) {
    console.error('Subscribe error:', err);
    return NextResponse.json(
      { detail: 'An error occurred while subscribing.' },
      { status: 500, headers: CORS }
    );
  }
}
