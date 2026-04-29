#!/usr/bin/env node
// ============================================================
// IR Pages Health Report
//
// Prints a status report of every IR URL tracked in the ir_pages table:
//   - Which URLs are healthy (recent ok scrapes with events)
//   - Which are stale (consecutive HTTP errors or zero-event runs)
//   - Which were auto-rediscovered and when
//
// Optional --rediscover flag: actively re-runs discovery against any URL
// flagged as stale and updates the table.
//
// Usage:
//   node scripts/ir-health.js                        # Report only
//   node scripts/ir-health.js --rediscover           # Report + rediscover stale
//   node scripts/ir-health.js --rediscover-all       # Try discovery for every ticker
//   node scripts/ir-health.js --filter=ok|stale|new  # Filter the report
//
// Required env: DATABASE_URL
// Optional env: OPENROUTER_API_KEY (only needed for the underlying scrape;
//               discovery itself uses the Markit API and HTML heuristics — no LLM)
// ============================================================

const { neon } = require('@neondatabase/serverless');
const { ensureIRPagesTable, loadIRPages, rediscoverStale } = require('./lib/ir-pages');
const { discoverIRUrl } = require('./lib/ir-discovery');

// ---------------------------------------------------------------------------
// ANSI colours
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  red: function (s) { return '\x1b[31m' + s + '\x1b[0m'; },
  green: function (s) { return '\x1b[32m' + s + '\x1b[0m'; },
  yellow: function (s) { return '\x1b[33m' + s + '\x1b[0m'; },
  cyan: function (s) { return '\x1b[36m' + s + '\x1b[0m'; },
  dim: function (s) { return '\x1b[2m' + s + '\x1b[0m'; },
  bold: function (s) { return '\x1b[1m' + s + '\x1b[0m'; },
};

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatAge(ts) {
  if (!ts) return 'never';
  var d = new Date(ts);
  var ms = Date.now() - d.getTime();
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's ago';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function statusBadge(row) {
  var f = row.consecutive_failures || 0;
  var z = row.consecutive_no_events || 0;
  var s = row.last_status;

  if (s === 'ok') return C.green('OK    ');
  if (f >= 3) return C.red('STALE ');
  if (f > 0) return C.yellow('FLAKY ');
  if (z >= 8) return C.red('EMPTY ');
  if (z > 0) return C.yellow('QUIET ');
  if (!s) return C.dim('NEW   ');
  return C.dim('?     ');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function printReport(sql, filter) {
  var rows = await sql`
    SELECT ticker, url, last_checked_at, last_status, last_http_code,
           last_event_count, consecutive_failures, consecutive_no_events,
           discovered_via, rediscovered_at, previous_url, created_at
    FROM ir_pages
    ORDER BY
      CASE WHEN consecutive_failures >= 3 THEN 0
           WHEN consecutive_no_events >= 8 THEN 1
           WHEN last_status = 'ok' THEN 3
           ELSE 2 END,
      ticker
  `;

  if (rows.length === 0) {
    console.log(C.dim('No IR pages tracked yet. Run verify.js first to populate.'));
    return rows;
  }

  // Headline counts
  var ok = 0, stale = 0, flaky = 0, empty = 0, quiet = 0, never = 0, rediscovered = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.last_status === 'ok') ok++;
    else if ((r.consecutive_failures || 0) >= 3) stale++;
    else if ((r.consecutive_failures || 0) > 0) flaky++;
    else if ((r.consecutive_no_events || 0) >= 8) empty++;
    else if ((r.consecutive_no_events || 0) > 0) quiet++;
    else if (!r.last_status) never++;
    if (r.rediscovered_at) rediscovered++;
  }

  console.log('');
  console.log(C.bold('IR Pages Health — ' + rows.length + ' tickers tracked'));
  console.log('  ' + C.green('OK ' + ok) + '  ' + C.red('STALE ' + stale) + '  ' + C.yellow('FLAKY ' + flaky) +
              '  ' + C.red('EMPTY ' + empty) + '  ' + C.yellow('QUIET ' + quiet) +
              '  ' + C.dim('NEVER ' + never));
  console.log('  ' + C.cyan('Rediscovered URLs: ' + rediscovered));
  console.log('');

  // Filter
  var filtered = rows;
  if (filter === 'ok') {
    filtered = rows.filter(function (r) { return r.last_status === 'ok'; });
  } else if (filter === 'stale') {
    filtered = rows.filter(function (r) {
      return (r.consecutive_failures || 0) >= 3 || (r.consecutive_no_events || 0) >= 8;
    });
  } else if (filter === 'new') {
    filtered = rows.filter(function (r) { return !r.last_status; });
  }

  if (filter && filtered.length === 0) {
    console.log(C.dim('No rows match filter "' + filter + '".'));
    return rows;
  }

  // Print rows: TICKER  STATUS  fails/zero  last-checked  url
  console.log(C.dim('  TICKER STATUS    F  Z  LAST CHECK   URL'));
  console.log(C.dim('  ' + '-'.repeat(78)));
  for (var k = 0; k < filtered.length; k++) {
    var rr = filtered[k];
    var t = (rr.ticker + '       ').substring(0, 6);
    var f = String(rr.consecutive_failures || 0).padStart(2, ' ');
    var z = String(rr.consecutive_no_events || 0).padStart(2, ' ');
    var checked = (formatAge(rr.last_checked_at) + '            ').substring(0, 12);
    var u = rr.url.length > 70 ? rr.url.substring(0, 67) + '...' : rr.url;
    console.log('  ' + t + ' ' + statusBadge(rr) + ' ' + f + ' ' + z + ' ' + checked + ' ' + u);
    if (rr.rediscovered_at && rr.previous_url) {
      console.log('         ' + C.dim('was: ' + (rr.previous_url.length > 70 ? rr.previous_url.substring(0, 67) + '...' : rr.previous_url)));
    }
  }
  console.log('');
  return rows;
}

// ---------------------------------------------------------------------------
// Rediscovery sweep
// ---------------------------------------------------------------------------

async function rediscoverSweep(sql, mode) {
  // mode: 'stale' | 'all'
  var rows;
  if (mode === 'all') {
    rows = await sql`SELECT ticker FROM ir_pages ORDER BY ticker`;
  } else {
    rows = await sql`
      SELECT ticker FROM ir_pages
      WHERE consecutive_failures >= 3 OR consecutive_no_events >= 8
      ORDER BY ticker
    `;
  }

  if (rows.length === 0) {
    console.log(C.green('Nothing to rediscover — all tracked URLs are healthy.'));
    return;
  }

  console.log(C.bold('Rediscovering ' + rows.length + ' ticker(s) (' + mode + ' mode)...'));
  var updated = 0, unchanged = 0, failed = 0;
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i].ticker;
    process.stdout.write('  [' + (i + 1) + '/' + rows.length + '] ' + t + '...');

    try {
      var newUrl = await rediscoverStale(sql, t);
      if (newUrl) {
        process.stdout.write(' ' + C.green('updated') + ' -> ' + newUrl + '\n');
        updated++;
      } else {
        process.stdout.write(' ' + C.dim('unchanged') + '\n');
        unchanged++;
      }
    } catch (err) {
      process.stdout.write(' ' + C.red('error: ' + err.message) + '\n');
      failed++;
    }

    // Polite delay between Markit + homepage requests
    if (i < rows.length - 1) {
      await new Promise(function (r) { setTimeout(r, 600); });
    }
  }
  console.log('');
  console.log(C.bold('Rediscovery complete:') + '  ' +
    C.green(updated + ' updated') + '  ' +
    C.dim(unchanged + ' unchanged') + '  ' +
    C.red(failed + ' errors'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  var args = { rediscover: false, rediscoverAll: false, filter: null };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--rediscover') args.rediscover = true;
    else if (a === '--rediscover-all') args.rediscoverAll = true;
    else if (a.indexOf('--filter=') === 0) args.filter = a.substring(9);
  }
  return args;
}

async function main() {
  var args = parseArgs(process.argv);
  var databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
  }

  var sql = neon(databaseUrl);

  // Make sure the table + seed are in place
  await ensureIRPagesTable(sql);
  await loadIRPages(sql);

  // Run pre-report
  await printReport(sql, args.filter);

  // Optional rediscovery sweep
  if (args.rediscover || args.rediscoverAll) {
    console.log('');
    await rediscoverSweep(sql, args.rediscoverAll ? 'all' : 'stale');
    console.log('');
    console.log(C.bold('Post-rediscovery state:'));
    await printReport(sql, args.filter);
  }
}

main().catch(function (err) {
  console.error('[ir-health] Fatal error:', err);
  process.exit(1);
});
