// ============================================================
// Daily Digest Email
// Sends a morning summary of all events added or updated
// in the last 24 hours, plus upcoming events in the next 14 days.
//
// Required env vars: DATABASE_URL, RESEND_API_KEY
// Optional env vars: INVITE_FROM_EMAIL, DIGEST_RECIPIENT
// Usage: node scripts/daily-digest.js
// ============================================================

const { neon } = require('@neondatabase/serverless');
const { Resend } = require('resend');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DIGEST_RECIPIENT = process.env.DIGEST_RECIPIENT || 'pmckinleywilson@gmail.com';
const FROM_EMAIL = process.env.INVITE_FROM_EMAIL || 'onboarding@resend.dev';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDate(d) {
  if (typeof d === 'string') return d.substring(0, 10);
  if (d instanceof Date) return d.toISOString().substring(0, 10);
  return String(d).substring(0, 10);
}

function formatDateNice(dateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const STATUS_LABELS = {
  confirmed: 'Confirmed',
  date_confirmed: 'Date confirmed, time TBC',
  estimated: 'Estimated based on PCP',
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('==========================================================');
  console.log('ASX Calendar — Daily Digest');
  console.log('Started: ' + new Date().toISOString());
  console.log('==========================================================\n');

  var databaseUrl = process.env.DATABASE_URL;
  var resendApiKey = process.env.RESEND_API_KEY;

  if (!databaseUrl) { console.error('FATAL: DATABASE_URL not set'); process.exit(1); }
  if (!resendApiKey) { console.error('FATAL: RESEND_API_KEY not set'); process.exit(1); }

  var sql = neon(databaseUrl);
  var resend = new Resend(resendApiKey);

  var today = new Date().toISOString().substring(0, 10);
  var yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().substring(0, 10);
  var twoWeeks = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().substring(0, 10);

  // Query 1: Events added or updated in the last 24 hours
  var recentChanges = await sql`
    SELECT * FROM events
    WHERE updated_at >= ${yesterday}::timestamptz
    ORDER BY updated_at DESC
  `;

  // Query 2: All upcoming events in the next 14 days
  var upcoming = await sql`
    SELECT * FROM events
    WHERE event_date >= ${today}
      AND event_date <= ${twoWeeks}
    ORDER BY event_date ASC, event_time ASC NULLS LAST
  `;

  // Query 3: Total event counts
  var totalRows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed,
      COUNT(*) FILTER (WHERE status = 'date_confirmed') AS date_confirmed,
      COUNT(*) FILTER (WHERE status = 'estimated') AS estimated,
      COUNT(*) FILTER (WHERE webcast_url IS NOT NULL) AS with_webcast
    FROM events
    WHERE event_date >= ${today}
  `;
  var counts = totalRows[0] || {};

  // Query 4: Seen announcements count (poller activity)
  var seenRows = await sql`
    SELECT COUNT(*) AS total FROM seen_announcements
    WHERE first_seen_at >= ${yesterday}::timestamptz
  `;
  var announcementsScanned = seenRows[0] ? seenRows[0].total : 0;

  console.log('[digest] Recent changes (24h): ' + recentChanges.length);
  console.log('[digest] Upcoming (14 days): ' + upcoming.length);
  console.log('[digest] Announcements scanned (24h): ' + announcementsScanned);

  // Build email HTML
  var html = '';

  // Header
  html += '<div style="font-family: monospace; max-width: 700px; margin: 0 auto; color: #1b1b1b;">';
  html += '<h2 style="border-bottom: 2px solid #1b1b1b; padding-bottom: 8px;">ASX CALENDAR — DAILY DIGEST</h2>';
  html += '<p style="font-size: 12px; color: #666;">' + formatDateNice(today) + '</p>';

  // Stats bar
  html += '<div style="background: #f5f5f5; padding: 10px; margin: 12px 0; font-size: 12px;">';
  html += '<strong>EVENTS:</strong> ' + counts.total + ' &nbsp;|&nbsp; ';
  html += '<strong style="color: #1a7f37;">CONFIRMED:</strong> ' + counts.confirmed + ' &nbsp;|&nbsp; ';
  html += '<strong style="color: #9a6700;">DATE CONFIRMED:</strong> ' + counts.date_confirmed + ' &nbsp;|&nbsp; ';
  html += '<strong>WEBCAST:</strong> ' + counts.with_webcast + ' &nbsp;|&nbsp; ';
  html += '<strong>SCANNED (24h):</strong> ' + announcementsScanned + ' announcements';
  html += '</div>';

  // Recent changes
  if (recentChanges.length > 0) {
    html += '<h3 style="margin-top: 20px;">NEW / UPDATED (last 24 hours)</h3>';
    html += '<table style="width: 100%; border-collapse: collapse; font-size: 11px;">';
    html += '<tr style="background: #1b1b1b; color: white; text-align: left;">';
    html += '<th style="padding: 4px 6px;">TICKER</th>';
    html += '<th style="padding: 4px 6px;">EVENT</th>';
    html += '<th style="padding: 4px 6px;">DATE</th>';
    html += '<th style="padding: 4px 6px;">STATUS</th>';
    html += '<th style="padding: 4px 6px;">WEBCAST</th>';
    html += '</tr>';

    for (var i = 0; i < recentChanges.length; i++) {
      var ev = recentChanges[i];
      var bg = i % 2 === 0 ? '#fff' : '#f9f9f9';
      var statusLabel = STATUS_LABELS[ev.status] || ev.status;
      var statusColor = ev.status === 'confirmed' ? '#1a7f37' : (ev.status === 'date_confirmed' ? '#9a6700' : '#666');

      html += '<tr style="background: ' + bg + ';">';
      html += '<td style="padding: 4px 6px; font-weight: bold;">' + ev.ticker + '</td>';
      html += '<td style="padding: 4px 6px;">' + (ev.title || ev.event_type) + '</td>';
      html += '<td style="padding: 4px 6px;">' + formatDateNice(safeDate(ev.event_date)) + '</td>';
      html += '<td style="padding: 4px 6px; color: ' + statusColor + ';">' + statusLabel + '</td>';
      html += '<td style="padding: 4px 6px;">' + (ev.webcast_url ? '<a href="' + ev.webcast_url + '">Link</a>' : '—') + '</td>';
      html += '</tr>';
    }
    html += '</table>';
  } else {
    html += '<p style="font-size: 12px; color: #666;">No new or updated events in the last 24 hours.</p>';
  }

  // Upcoming events
  if (upcoming.length > 0) {
    html += '<h3 style="margin-top: 20px;">UPCOMING (next 14 days)</h3>';
    html += '<table style="width: 100%; border-collapse: collapse; font-size: 11px;">';
    html += '<tr style="background: #1b1b1b; color: white; text-align: left;">';
    html += '<th style="padding: 4px 6px;">DATE</th>';
    html += '<th style="padding: 4px 6px;">TICKER</th>';
    html += '<th style="padding: 4px 6px;">EVENT</th>';
    html += '<th style="padding: 4px 6px;">TIME</th>';
    html += '<th style="padding: 4px 6px;">STATUS</th>';
    html += '<th style="padding: 4px 6px;">WEBCAST</th>';
    html += '</tr>';

    for (var j = 0; j < upcoming.length; j++) {
      var ev2 = upcoming[j];
      var bg2 = j % 2 === 0 ? '#fff' : '#f9f9f9';
      var statusLabel2 = STATUS_LABELS[ev2.status] || ev2.status;
      var statusColor2 = ev2.status === 'confirmed' ? '#1a7f37' : (ev2.status === 'date_confirmed' ? '#9a6700' : '#666');

      html += '<tr style="background: ' + bg2 + ';">';
      html += '<td style="padding: 4px 6px;">' + formatDateNice(safeDate(ev2.event_date)) + '</td>';
      html += '<td style="padding: 4px 6px; font-weight: bold;">' + ev2.ticker + '</td>';
      html += '<td style="padding: 4px 6px;">' + (ev2.title || ev2.event_type) + '</td>';
      html += '<td style="padding: 4px 6px;">' + (ev2.event_time || 'TBC') + '</td>';
      html += '<td style="padding: 4px 6px; color: ' + statusColor2 + ';">' + statusLabel2 + '</td>';
      html += '<td style="padding: 4px 6px;">' + (ev2.webcast_url ? '<a href="' + ev2.webcast_url + '">Link</a>' : '—') + '</td>';
      html += '</tr>';
    }
    html += '</table>';
  }

  // Footer
  html += '<div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 10px; color: #999;">';
  html += '<a href="https://asx-calendar-api.vercel.app">View full calendar</a> &nbsp;|&nbsp; ';
  html += 'Powered by ASX Calendar API';
  html += '</div>';
  html += '</div>';

  // Send email
  console.log('[digest] Sending digest to ' + DIGEST_RECIPIENT + '...');

  try {
    var result = await resend.emails.send({
      from: FROM_EMAIL,
      to: DIGEST_RECIPIENT,
      subject: 'ASX Calendar Digest — ' + formatDateNice(today) + ' (' + counts.total + ' events, ' + recentChanges.length + ' updated)',
      html: html,
    });

    console.log('[digest] Email sent! ID: ' + (result.data ? result.data.id : 'unknown'));
  } catch (err) {
    console.error('[digest] Email send failed: ' + err.message);
    process.exit(1);
  }

  console.log('\n[digest] Done.');
}

main().catch(function (err) {
  console.error('[digest] Fatal error:', err);
  process.exit(1);
});
