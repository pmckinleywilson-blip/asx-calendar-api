import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';

export const dynamic = 'force-dynamic';

/**
 * GET /api/test-email?to=someone@example.com
 *
 * Diagnostic endpoint — sends a test email and returns the full
 * Resend API response (or error) so we can debug delivery issues.
 */
export async function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get('to');
  if (!to) {
    return NextResponse.json({ error: 'Missing ?to= parameter' }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const fromAddr = process.env.INVITE_FROM_EMAIL;

  // Report config (without exposing the full key)
  const config = {
    RESEND_API_KEY: apiKey ? `${apiKey.substring(0, 8)}...` : 'NOT SET',
    INVITE_FROM_EMAIL: fromAddr ?? 'NOT SET (will use default)',
  };

  if (!apiKey) {
    return NextResponse.json({
      error: 'RESEND_API_KEY is not set',
      config,
    }, { status: 500 });
  }

  const from = fromAddr ?? 'invites@asx-calendar-api.vercel.app';

  try {
    const resend = new Resend(apiKey);

    const result = await resend.emails.send({
      from,
      to,
      subject: 'ASX Calendar — Test Email',
      html: `
        <div style="font-family:monospace;font-size:13px;padding:20px">
          <p><strong>This is a test email from ASX Calendar API.</strong></p>
          <p>If you received this, email delivery is working correctly.</p>
          <p style="color:#999;font-size:11px">Sent at ${new Date().toISOString()}</p>
        </div>
      `,
    });

    return NextResponse.json({
      status: 'sent',
      config,
      from,
      to,
      resend_response: result,
    });
  } catch (err: any) {
    return NextResponse.json({
      status: 'error',
      config,
      from,
      to,
      error: err.message ?? String(err),
      full_error: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err))),
    }, { status: 500 });
  }
}
