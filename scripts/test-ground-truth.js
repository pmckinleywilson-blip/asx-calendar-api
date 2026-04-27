#!/usr/bin/env node
// ============================================================
// Ground Truth Cross-Reference Test
//
// Compares our database event dates against Yahoo Finance earnings
// dates to find mismatches. Yahoo Finance is used ONLY for testing —
// it is NOT a data source for the pipeline.
//
// Usage:
//   node scripts/test-ground-truth.js                # Test top 50 ASX companies
//   node scripts/test-ground-truth.js TNE CBA WBC    # Test specific tickers
//   node scripts/test-ground-truth.js --all           # Test all companies with DB events
//
// Required env vars: DATABASE_URL
// Optional: none (yahoo-finance2 is a devDependency)
// ============================================================

const C = {
  red: (s) => '\x1b[31m' + s + '\x1b[0m',
  green: (s) => '\x1b[32m' + s + '\x1b[0m',
  yellow: (s) => '\x1b[33m' + s + '\x1b[0m',
  cyan: (s) => '\x1b[36m' + s + '\x1b[0m',
  dim: (s) => '\x1b[2m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m',
};

// Top 50 ASX companies by market cap for default testing
const TOP_50 = [
  'CBA','BHP','WBC','NAB','ANZ','WES','MQG','CSL','WDS','FMG',
  'RIO','TLS','GMG','WOW','TCL','QBE','NST','COL','ALL','EVN',
  'AMC','STO','ORG','REA','S32','SUN','IAG','PLS','JHX','WTC',
  'XRO','QAN','PME','BXB','RMD','SCG','CPU','SOL','APA','MIN',
  'MPL','BSL','COH','NXT','ALQ','ASX','SHL','ORI','TNE','RHC',
];

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function main() {
  var args = process.argv.slice(2);
  var testAll = args.includes('--all');
  var tickers = args.filter(function (a) { return !a.startsWith('--'); });

  // Validate dependencies
  var YahooFinance;
  try {
    YahooFinance = require('yahoo-finance2').default;
  } catch (e) {
    console.log(C.red('\n  ERROR: yahoo-finance2 not installed. Run: npm install --save-dev yahoo-finance2\n'));
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.log(C.red('\n  ERROR: DATABASE_URL env var required\n'));
    process.exit(1);
  }

  var { neon } = require('@neondatabase/serverless');
  var sql = neon(process.env.DATABASE_URL);
  var yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

  // Determine which tickers to test
  if (tickers.length === 0 && !testAll) {
    tickers = TOP_50;
  }

  if (testAll) {
    // Get all tickers that have future events in the DB
    var dbTickers = await sql`
      SELECT DISTINCT ticker FROM events
      WHERE event_date >= CURRENT_DATE
      ORDER BY ticker
    `;
    tickers = dbTickers.map(function (r) { return r.ticker; });
  }

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  ASX Calendar — Ground Truth Cross-Reference'));
  console.log(C.bold('  Yahoo Finance vs. Our Database'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('  Date:    ' + new Date().toISOString().substring(0, 10));
  console.log('  Tickers: ' + tickers.length);
  console.log('');

  var stats = {
    tested: 0,
    yahoo_has_date: 0,
    yahoo_no_date: 0,
    yahoo_error: 0,
    db_has_match: 0,
    exact_match: 0,
    close_match: 0,   // within 7 days
    mismatch: 0,
    db_missing: 0,    // yahoo has date, DB doesn't have event near that date
    db_only_estimated: 0,
    past_dates: 0,    // yahoo date is in the past (already reported)
  };

  var mismatches = [];
  var today = new Date().toISOString().substring(0, 10);

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    stats.tested++;

    // Step 1: Get Yahoo Finance earnings date
    var yahooDate = null;
    try {
      var r = await yf.quoteSummary(ticker + '.AX', { modules: ['calendarEvents'] });
      var dates = (r.calendarEvents?.earnings?.earningsDate || [])
        .map(function (d) { return d instanceof Date ? d.toISOString().substring(0, 10) : String(d); });
      yahooDate = dates[0] || null;
    } catch (e) {
      stats.yahoo_error++;
      if (tickers.length <= 10) {
        console.log(C.dim('[' + (i + 1) + '/' + tickers.length + '] ' + ticker + ' — Yahoo error: ' + e.message.substring(0, 60)));
      }
      continue;
    }

    if (!yahooDate) {
      stats.yahoo_no_date++;
      continue;
    }

    stats.yahoo_has_date++;

    // Skip past dates (company already reported, Yahoo hasn't updated)
    if (yahooDate < today) {
      stats.past_dates++;
      continue;
    }

    // Step 2: Get our DB events for this ticker around the Yahoo date
    var dbEvents;
    try {
      dbEvents = await sql`
        SELECT event_date, event_type, status, source, title
        FROM events
        WHERE ticker = ${ticker}
          AND event_type = 'earnings'
          AND event_date >= CURRENT_DATE
        ORDER BY event_date ASC
      `;
    } catch (e) {
      continue;
    }

    // Step 3: Compare
    var prefix = '[' + (i + 1) + '/' + tickers.length + '] ' + ticker;

    if (dbEvents.length === 0) {
      stats.db_missing++;
      console.log(prefix + ' — ' + C.red('MISSING') +
        '  Yahoo: ' + yahooDate + '  DB: no future earnings events');
      mismatches.push({
        ticker: ticker,
        yahoo: yahooDate,
        db: null,
        db_status: null,
        issue: 'missing_from_db',
      });
      continue;
    }

    // Find closest DB event to Yahoo date
    var closestEvent = null;
    var closestDiff = Infinity;

    for (var j = 0; j < dbEvents.length; j++) {
      var dbDate = dbEvents[j].event_date instanceof Date
        ? dbEvents[j].event_date.toISOString().substring(0, 10)
        : String(dbEvents[j].event_date).substring(0, 10);

      var diff = Math.abs(
        (new Date(yahooDate).getTime() - new Date(dbDate).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (diff < closestDiff) {
        closestDiff = diff;
        closestEvent = dbEvents[j];
        closestEvent._date = dbDate;
        closestEvent._diff = diff;
      }
    }

    if (closestDiff === 0) {
      // Exact match
      stats.exact_match++;
      if (tickers.length <= 20) {
        console.log(prefix + ' — ' + C.green('✓ EXACT MATCH') +
          '  ' + yahooDate + '  [' + closestEvent.status + ', ' + closestEvent.source + ']');
      }
    } else if (closestDiff <= 7) {
      // Close match (within a week — might be different event or slight date difference)
      stats.close_match++;
      console.log(prefix + ' — ' + C.yellow('~ CLOSE') +
        '  Yahoo: ' + yahooDate + '  DB: ' + closestEvent._date +
        ' (' + closestDiff + 'd off)' +
        '  [' + closestEvent.status + ', ' + closestEvent.source + ']');
      mismatches.push({
        ticker: ticker,
        yahoo: yahooDate,
        db: closestEvent._date,
        db_status: closestEvent.status,
        db_source: closestEvent.source,
        diff_days: closestDiff,
        issue: 'close_mismatch',
      });
    } else {
      // Significant mismatch
      stats.mismatch++;
      console.log(prefix + ' — ' + C.red('✗ MISMATCH') +
        '  Yahoo: ' + yahooDate + '  DB: ' + closestEvent._date +
        ' (' + closestDiff + 'd off)' +
        '  [' + closestEvent.status + ', ' + closestEvent.source + ']');
      mismatches.push({
        ticker: ticker,
        yahoo: yahooDate,
        db: closestEvent._date,
        db_status: closestEvent.status,
        db_source: closestEvent.source,
        diff_days: closestDiff,
        issue: 'mismatch',
      });

      if (closestEvent.status === 'estimated') {
        stats.db_only_estimated++;
      }
    }

    // Rate limit: Yahoo Finance can handle ~2 req/s
    if (i < tickers.length - 1) {
      await delay(500);
    }
  }

  // Summary
  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  RESULTS SUMMARY'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('');
  console.log('  Tickers tested:          ' + stats.tested);
  console.log('  Yahoo has future date:   ' + (stats.yahoo_has_date - stats.past_dates));
  console.log('  Yahoo date in past:      ' + stats.past_dates + C.dim(' (already reported, skipped)'));
  console.log('  Yahoo no date/error:     ' + (stats.yahoo_no_date + stats.yahoo_error));
  console.log('');
  console.log(C.bold('  Accuracy (future events only):'));
  console.log('    ' + C.green('Exact match:           ' + stats.exact_match));
  console.log('    ' + C.yellow('Close (≤7 days off):   ' + stats.close_match));
  console.log('    ' + C.red('Mismatch (>7 days):    ' + stats.mismatch));
  console.log('    ' + C.red('Missing from DB:       ' + stats.db_missing));

  var futureCount = stats.yahoo_has_date - stats.past_dates;
  if (futureCount > 0) {
    var accuracy = ((stats.exact_match / futureCount) * 100).toFixed(0);
    var closeAccuracy = (((stats.exact_match + stats.close_match) / futureCount) * 100).toFixed(0);
    console.log('');
    console.log('    Exact accuracy:        ' + (accuracy >= 80 ? C.green(accuracy + '%') : accuracy >= 50 ? C.yellow(accuracy + '%') : C.red(accuracy + '%')));
    console.log('    Within-a-week accuracy: ' + closeAccuracy + '%');
  }

  if (stats.db_only_estimated > 0) {
    console.log('');
    console.log(C.yellow('  ⚠ ' + stats.db_only_estimated + ' mismatched events are "estimated" status —'));
    console.log(C.yellow('    the IR scraper or announcements never corrected these dates.'));
  }

  if (mismatches.length > 0) {
    console.log('');
    console.log(C.bold('  MISMATCHED / MISSING EVENTS:'));
    console.log('');
    console.log('  Ticker  Yahoo Date   DB Date      Diff   Status      Source');
    console.log('  ' + '─'.repeat(70));
    mismatches.forEach(function (m) {
      var diffStr = m.diff_days ? m.diff_days + 'd' : '-';
      var dbDate = m.db || 'MISSING';
      var status = m.db_status || '-';
      var source = m.db_source || '-';
      var color = m.issue === 'mismatch' ? C.red : m.issue === 'missing_from_db' ? C.red : C.yellow;
      console.log('  ' + color(
        m.ticker.padEnd(8) +
        m.yahoo.padEnd(13) +
        dbDate.padEnd(13) +
        diffStr.padEnd(7) +
        status.padEnd(16) +
        source
      ));
    });
  }

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════\n'));

  // Exit with failure if accuracy is poor
  if (futureCount > 0 && stats.exact_match / futureCount < 0.5) {
    process.exit(1);
  }
}

main().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
