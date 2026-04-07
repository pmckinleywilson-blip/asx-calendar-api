// ============================================================
// Notification Script
// Sends calendar invite emails for confirmed, unnotified events
// to matching subscribers via Resend.
//
// Required env vars: DATABASE_URL, RESEND_API_KEY, INVITE_FROM_EMAIL
// Usage: node scripts/notify.js
// ============================================================

const { neon } = require('@neondatabase/serverless');
const { Resend } = require('resend');

// ---------------------------------------------------------------------------
// ICS Generation (inline, no external dependencies)
// ---------------------------------------------------------------------------

function pad2(n) {
  return n.toString().padStart(2, '0');
}

function escapeIcs(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line) {
  const maxLen = 75;
  if (line.length <= maxLen) return line;

  const parts = [line.slice(0, maxLen)];
  let pos = maxLen;
  while (pos < line.length) {
    parts.push(' ' + line.slice(pos, pos + maxLen - 1));
    pos += maxLen - 1;
  }
  return parts.join('\r\n');
}

function nowUtcStamp() {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    'T' +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    'Z'
  );
}

const SYDNEY_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Australia/Sydney',
  'BEGIN:STANDARD',
  'DTSTART:19700405T030000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4',
  'TZOFFSETFROM:+1100',
  'TZOFFSETTO:+1000',
  'TZNAME:AEST',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19701004T020000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=10',
  'TZOFFSETFROM:+1000',
  'TZOFFSETTO:+1100',
  'TZNAME:AEDT',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
].join('\r\n');

function generateIcs(event) {
  const dtstamp = nowUtcStamp();
  const uid = 'asx-calendar-' + event.id + '@asx-calendar-api.vercel.app';
  const summary = event.title || (event.ticker + ' ' + event.event_type);
  const hasTime = !!event.event_time;

  // Build description
  const descParts = [];
  if (event.description) descParts.push(event.description);
  if (event.fiscal_period) descParts.push('Fiscal period: ' + event.fiscal_period);
  if (event.status) descParts.push('Status: ' + event.status);
  if (event.webcast_url) descParts.push('Webcast: ' + event.webcast_url);
  if (event.phone_number) descParts.push('Phone: ' + event.phone_number);
  if (event.phone_passcode) descParts.push('Passcode: ' + event.phone_passcode);
  const description = descParts.join('\n');

  // Build DTSTART — event_date may be a Date object or string from Postgres
  const dateStr = typeof event.event_date === 'string'
    ? event.event_date.substring(0, 10)
    : event.event_date.toISOString().substring(0, 10);
  const dateParts = dateStr.split('-');
  let dtstart;
  if (hasTime) {
    const timeParts = event.event_time.split(':');
    dtstart = 'DTSTART;TZID=Australia/Sydney:' + dateParts[0] + dateParts[1] + dateParts[2] + 'T' + timeParts[0] + timeParts[1] + '00';
  } else {
    dtstart = 'DTSTART;VALUE=DATE:' + dateParts[0] + dateParts[1] + dateParts[2];
  }

  const status = event.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE';  // ICS only has CONFIRMED/TENTATIVE

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ASX Calendar API//asx-calendar-api.vercel.app//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  if (hasTime) {
    lines.push(SYDNEY_VTIMEZONE);
  }

  lines.push('BEGIN:VEVENT');
  lines.push('UID:' + uid);
  lines.push('DTSTAMP:' + dtstamp);
  lines.push(dtstart);
  if (hasTime) lines.push('DURATION:PT1H30M');
  lines.push(foldLine('SUMMARY:' + escapeIcs(summary)));
  if (description) lines.push(foldLine('DESCRIPTION:' + escapeIcs(description)));
  if (event.webcast_url) lines.push(foldLine('URL:' + event.webcast_url));
  lines.push('STATUS:' + status);
  lines.push('CATEGORIES:' + event.event_type.toUpperCase());
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Email formatting helpers
// ---------------------------------------------------------------------------

function formatDate(event) {
  const d = new Date(event.event_date + 'T00:00:00');
  const day = d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Australia/Sydney',
  });

  if (event.event_time) {
    return day + ', ' + event.event_time + ' AEST';
  }
  return day;
}

function buildEmailHtml(event, unsubscribeUrl) {
  const title = event.title || (event.ticker + ' ' + event.event_type);
  const dateStr = formatDate(event);

  const detailRows = [];
  detailRows.push('<tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td>' + dateStr + '</td></tr>');

  if (event.fiscal_period) {
    detailRows.push('<tr><td style="padding:4px 12px 4px 0;color:#666">Period</td><td>' + event.fiscal_period + '</td></tr>');
  }
  if (event.webcast_url) {
    detailRows.push('<tr><td style="padding:4px 12px 4px 0;color:#666">Webcast</td><td><a href="' + event.webcast_url + '" style="color:#0066cc">' + event.webcast_url + '</a></td></tr>');
  }
  if (event.phone_number) {
    let phoneStr = event.phone_number;
    if (event.phone_passcode) phoneStr += ' (passcode: ' + event.phone_passcode + ')';
    detailRows.push('<tr><td style="padding:4px 12px 4px 0;color:#666">Dial-in</td><td>' + phoneStr + '</td></tr>');
  }
  if (event.description) {
    detailRows.push('<tr><td style="padding:4px 12px 4px 0;color:#666">Details</td><td>' + event.description + '</td></tr>');
  }

  return '<div style="font-family:\'SF Mono\',Menlo,Consolas,monospace;font-size:13px;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px">' +
    '<div style="border-bottom:1px solid #e0e0e0;padding-bottom:12px;margin-bottom:16px">' +
    '<strong style="font-size:15px">' + event.ticker + '</strong>' +
    '<span style="color:#666;margin-left:8px">' + event.company_name + '</span>' +
    '</div>' +
    '<p style="margin:0 0 16px">' + title + '</p>' +
    '<table style="border-collapse:collapse;font-size:13px;margin-bottom:20px">' +
    detailRows.join('\n') +
    '</table>' +
    '<p style="font-size:11px;color:#999;margin-top:24px;border-top:1px solid #e0e0e0;padding-top:12px">' +
    'This invite was generated by ASX Calendar API.<br>' +
    '<a href="' + unsubscribeUrl + '" style="color:#999">Unsubscribe</a>' +
    '</p>' +
    '</div>';
}

// ---------------------------------------------------------------------------
// Main notification pipeline
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('==========================================================');
  console.log('ASX Event Notification Pipeline');
  console.log('Started: ' + new Date().toISOString());
  console.log('==========================================================\n');

  // Validate environment
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[notify] FATAL: DATABASE_URL not set');
    process.exit(1);
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.error('[notify] FATAL: RESEND_API_KEY not set');
    process.exit(1);
  }

  const fromEmail = process.env.INVITE_FROM_EMAIL || 'invites@asx-calendar-api.vercel.app';

  const sql = neon(databaseUrl);
  const resend = new Resend(resendApiKey);

  // Step 1: Query unnotified events with confirmed or date_confirmed status
  const today = new Date().toISOString().substring(0, 10);
  console.log('[notify] Querying date_confirmed/confirmed events with event_date >= ' + today + ' and notified_at IS NULL...');

  const events = await sql`
    SELECT * FROM events
    WHERE status IN ('confirmed', 'date_confirmed')
      AND notified_at IS NULL
      AND event_date >= ${today}
    ORDER BY event_date ASC
  `;

  console.log('[notify] Found ' + events.length + ' unnotified confirmed event(s)\n');

  if (events.length === 0) {
    console.log('[notify] Nothing to notify. Exiting.');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n[notify] Duration: ' + elapsed + 's');
    process.exit(0);
  }

  let totalEmails = 0;
  let totalErrors = 0;

  for (let e = 0; e < events.length; e++) {
    const event = events[e];
    const title = event.title || (event.ticker + ' ' + event.event_type);
    console.log('[' + (e + 1) + '/' + events.length + '] ' + event.ticker + ' — ' + title + ' (' + event.event_date + ')');

    // Step 2: Find active subscribers whose tickers array contains this ticker
    const needle = JSON.stringify([event.ticker]);
    const subscribers = await sql`
      SELECT * FROM subscribers
      WHERE is_active = true
        AND tickers::jsonb @> ${needle}::jsonb
    `;

    if (subscribers.length === 0) {
      console.log('  No subscribers for ' + event.ticker);
      continue;
    }

    console.log('  Found ' + subscribers.length + ' subscriber(s)');

    for (let s = 0; s < subscribers.length; s++) {
      const sub = subscribers[s];

      // Step 3: Check notification_log to avoid re-sending
      const alreadySent = await sql`
        SELECT 1 FROM notification_log
        WHERE subscriber_id = ${sub.id} AND event_id = ${event.id}
        LIMIT 1
      `;

      if (alreadySent.length > 0) {
        console.log('  Skipping ' + sub.email + ' — already notified');
        continue;
      }

      // Step 4: Generate ICS content
      const icsContent = generateIcs(event);
      const icsFilename = event.ticker + '-' + event.event_date.substring(0, 10) + '.ics';

      // Build unsubscribe URL
      const unsubscribeUrl = 'https://asx-calendar-api.vercel.app/api/subscribe?token=' + sub.feed_token + '&action=unsubscribe';

      // Build email HTML
      const html = buildEmailHtml(event, unsubscribeUrl);

      const dateStr = formatDate(event);
      const subject = event.ticker + ' ' + title + ' — ' + dateStr;

      // Step 5: Send email via Resend
      try {
        await resend.emails.send({
          from: fromEmail,
          to: sub.email,
          subject: subject,
          html: html,
          headers: {
            'List-Unsubscribe': '<' + unsubscribeUrl + '>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          attachments: [
            {
              filename: icsFilename,
              content: Buffer.from(icsContent).toString('base64'),
              contentType: 'text/calendar',
            },
          ],
        });

        console.log('  Sent to ' + sub.email);
        totalEmails++;

        // Step 6: Log to notification_log
        await sql`
          INSERT INTO notification_log (subscriber_id, event_id)
          VALUES (${sub.id}, ${event.id})
          ON CONFLICT (subscriber_id, event_id) DO NOTHING
        `;
      } catch (err) {
        console.error('  Error sending to ' + sub.email + ': ' + err.message);
        totalErrors++;
      }
    }

    // Step 7: Mark event as notified
    await sql`
      UPDATE events SET notified_at = NOW() WHERE id = ${event.id}
    `;
    console.log('  Marked event id=' + event.id + ' as notified');
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n==========================================================');
  console.log('Notification Pipeline Complete');
  console.log('==========================================================');
  console.log('  Duration:       ' + elapsed + 's');
  console.log('  Events:         ' + events.length);
  console.log('  Emails sent:    ' + totalEmails);
  console.log('  Errors:         ' + totalErrors);
  console.log('  Finished: ' + new Date().toISOString());
  console.log('==========================================================\n');
}

main().catch(function (err) {
  console.error('[notify] Fatal error:', err);
  process.exit(1);
});
