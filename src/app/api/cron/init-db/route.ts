import { NextRequest, NextResponse } from 'next/server';
import { initDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/cron/init-db
 *
 * One-time endpoint to create the database tables.
 * Safe to call multiple times (uses IF NOT EXISTS).
 */
export async function GET(request: NextRequest) {
  try {
    await initDatabase();
    return NextResponse.json({
      status: 'ok',
      message: 'Database tables created successfully.',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('DB init error:', err);
    return NextResponse.json(
      { error: 'Failed to initialize database', detail: String(err) },
      { status: 500 }
    );
  }
}
