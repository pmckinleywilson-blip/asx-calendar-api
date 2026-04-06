import { NextRequest, NextResponse } from 'next/server';
import { deactivateSubscription } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/unsubscribe?token=...
 *
 * One-click unsubscribe handler.  Deactivates the subscription and
 * returns a simple HTML confirmation page.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return new NextResponse(buildPage('INVALID LINK', 'No token provided.'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const success = await deactivateSubscription(token);

  if (success) {
    return new NextResponse(
      buildPage(
        'UNSUBSCRIBED',
        'You have been unsubscribed from ASX Calendar API notifications. You will no longer receive calendar invites.',
      ),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  return new NextResponse(
    buildPage(
      'NOT FOUND',
      'This subscription was not found or has already been deactivated.',
    ),
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// ---------------------------------------------------------------------------
// Minimal HTML page (terminal-light style)
// ---------------------------------------------------------------------------

function buildPage(heading: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${heading} — ASX Calendar API</title>
  <style>
    body {
      font-family: 'SF Mono', Menlo, Consolas, monospace;
      font-size: 14px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fafafa;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
    }
    .card {
      max-width: 480px;
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 32px;
      text-align: center;
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: 0.05em;
      margin: 0 0 16px;
    }
    p {
      color: #666;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
