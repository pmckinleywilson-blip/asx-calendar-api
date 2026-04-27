#!/usr/bin/env node
// ============================================================
// Announcement Detection Diagnostic Test
//
// Tests the ASX announcement fetching and LLM classification pipeline:
//   1. ASX API fetch — can we reach the announcement feed?
//   2. Announcement volume — are we getting announcements?
//   3. LLM classification — does the LLM correctly flag event announcements?
//   4. LLM extraction �� does it extract correct event details?
//   5. Database state — what's currently in the DB for each ticker?
//
// Usage:
//   node scripts/test-detect.js TNE CBA BHP     # Test specific tickers
//   node scripts/test-detect.js --api-only       # Just test ASX API fetch
//   node scripts/test-detect.js --with-llm TNE   # Full pipeline with LLM
//
// Required env vars (for --with-llm): OPENROUTER_API_KEY
// Optional env vars: DATABASE_URL (for DB comparison)
// ============================================================

const { fetchAnnouncements } = require('./lib/asx-api');

const C = {
  red: (s) => '\x1b[31m' + s + '\x1b[0m',
  green: (s) => '\x1b[32m' + s + '\x1b[0m',
  yellow: (s) => '\x1b[33m' + s + '\x1b[0m',
  cyan: (s) => '\x1b[36m' + s + '\x1b[0m',
  dim: (s) => '\x1b[2m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m',
};

// Top 20 tickers for default testing
const DEFAULT_TICKERS = [
  'CBA', 'BHP', 'WBC', 'NAB', 'ANZ', 'WES', 'MQG', 'CSL', 'WDS', 'FMG',
  'RIO', 'TLS', 'GMG', 'WOW', 'TCL', 'QBE', 'TNE', 'COL', 'ALL', 'EVN',
];

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function checkDatabase(ticker) {
  if (!process.env.DATABASE_URL) return null;
  try {
    var { neon } = require('@neondatabase/serverless');
    var sql = neon(process.env.DATABASE_URL);
    var rows = await sql`
      SELECT event_date, event_type, status, source, title, webcast_url
      FROM events
      WHERE ticker = ${ticker}
        AND event_date >= CURRENT_DATE
      ORDER BY event_date ASC
    `;
    return rows;
  } catch (err) {
    return null;
  }
}

async function main() {
  var args = process.argv.slice(2);
  var apiOnly = args.includes('--api-only');
  var withLLM = args.includes('--with-llm');
  var tickers = args.filter(function (a) { return !a.startsWith('--'); });

  if (tickers.length === 0) tickers = DEFAULT_TICKERS;
  tickers = tickers.map(function (t) { return t.toUpperCase(); });

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  ASX Calendar — Announcement Detection Diagnostic'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('  Date:    ' + new Date().toISOString().substring(0, 10));
  console.log('  Tickers: ' + tickers.join(', '));
  console.log('  Mode:    ' + (withLLM ? 'Full (fetch + classify + extract)' : apiOnly ? 'API only' : 'Fetch + analysis'));
  console.log('');

  if (withLLM && !process.env.OPENROUTER_API_KEY) {
    console.log(C.red('  ERROR: --with-llm requires OPENROUTER_API_KEY env var\n'));
    process.exit(1);
  }

  var stats = {
    total: tickers.length,
    api_ok: 0,
    api_fail: 0,
    total_announcements: 0,
    tickers_with_5: 0,
    classified: 0,
    relevant: 0,
    events_found: 0,
  };

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var prefix = '[' + (i + 1) + '/' + tickers.length + '] ' + ticker;

    // Step 1: Fetch announcements from ASX API
    var announcements;
    try {
      announcements = await fetchAnnouncements(ticker);
      stats.api_ok++;
    } catch (err) {
      stats.api_fail++;
      console.log(prefix + ' — ' + C.red('ASX API FAILED: ' + err.message));
      continue;
    }

    var count = announcements.length;
    stats.total_announcements += count;

    var countColor = count === 0 ? C.yellow : count >= 5 ? C.red : C.green;
    if (count >= 5) stats.tickers_with_5++;

    console.log(prefix + ' — ' + countColor(count + ' announcements') +
      (count >= 5 ? C.red(' ⚠ AT API CAP — may be missing announcements') : ''));

    // Show announcement titles
    if (!apiOnly && count > 0) {
      announcements.forEach(function (ann) {
        var dateStr = ann.date || ann.announcement_date || '';
        console.log('         ' + C.dim(dateStr + ' — ' + (ann.title || 'no title').substring(0, 100)));
      });
    }

    // Step 2: LLM classification (if requested)
    if (withLLM && count > 0) {
      try {
        var { classifyAnnouncements, extractEventDetails } = require('./lib/llm-classify');

        // Tag announcements with ticker info
        var tagged = announcements.map(function (a) {
          a.ticker = ticker;
          a.company_name = ticker; // simplified
          return a;
        });

        var relevant = await classifyAnnouncements(tagged, process.env.OPENROUTER_API_KEY);
        stats.classified += count;
        stats.relevant += relevant.length;

        if (relevant.length > 0) {
          relevant.forEach(function (ann) {
            console.log('         ' + C.cyan('RELEVANT: ' + ann.title + ' [' + ann.classification + ']'));
          });

          // Step 3: Extract event details from relevant announcements
          var { fetchAnnouncementContent } = require('./lib/asx-api');
          for (var j = 0; j < relevant.length; j++) {
            var ann = relevant[j];
            try {
              var content = await fetchAnnouncementContent(ann.url);
              if (content) {
                var event = await extractEventDetails(ann, content, process.env.OPENROUTER_API_KEY);
                if (event) {
                  stats.events_found++;
                  console.log('         ' + C.green('EVENT: ' + event.event_date +
                    (event.event_time ? ' ' + event.event_time : '') +
                    ' — ' + event.title +
                    (event.webcast_url ? ' [HAS WEBCAST]' : '') +
                    ' [' + event.event_type + ']'));
                } else {
                  console.log('         ' + C.yellow('  → classified as relevant but no event extracted'));
                }
              }
            } catch (err) {
              console.log('         ' + C.red('  → extraction error: ' + err.message));
            }
            await delay(500);
          }
        } else {
          console.log('         ' + C.dim('(no event-related announcements)'));
        }
      } catch (err) {
        console.log('         ' + C.red('LLM ERROR: ' + err.message));
      }
    }

    // Step 3: Database state
    if (process.env.DATABASE_URL) {
      var dbEvents = await checkDatabase(ticker);
      if (dbEvents && dbEvents.length > 0) {
        dbEvents.forEach(function (e) {
          var dateStr = e.event_date.toString().substring(0, 10);
          var webcast = e.webcast_url ? C.green(' [webcast]') : '';
          console.log('         ' + C.dim('DB: ' + dateStr + ' ' + e.status + ' [' + e.source + '] ' + e.title) + webcast);
        });
      }
    }

    if (i < tickers.length - 1) await delay(300);
  }

  // Summary
  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  RESULTS SUMMARY'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('');
  console.log('  Tickers tested:        ' + stats.total);
  console.log('  ' + C.green('API success:           ' + stats.api_ok));
  console.log('  ' + C.red('API failures:          ' + stats.api_fail));
  console.log('  Total announcements:   ' + stats.total_announcements);
  console.log('  ' + C.red('Tickers at 5-cap:      ' + stats.tickers_with_5));

  if (withLLM) {
    console.log('');
    console.log('  Classified:            ' + stats.classified);
    console.log('  Relevant:              ' + stats.relevant);
    console.log('  ' + C.green('Events found:          ' + stats.events_found));
  }

  if (stats.tickers_with_5 > 0) {
    console.log('');
    console.log(C.yellow('  ⚠ ' + stats.tickers_with_5 + ' ticker(s) returned exactly 5 announcements (the API cap).'));
    console.log(C.yellow('    These companies may have announcements we\'re not seeing.'));
    console.log(C.yellow('    The continuous poller is needed to catch these.'));
  }

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════\n'));
}

main().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
