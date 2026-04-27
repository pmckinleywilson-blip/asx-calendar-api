// ============================================================
// IR Page Calendar Script
// Scrapes company Investor Relations pages to extract upcoming
// event DATES from financial calendars. IR calendars provide dates
// early (HY/FY results, AGM) but usually NOT webcast/dial-in details.
// ASX announcements (higher priority) enrich with webcast details later.
//
// Schedule logic:
//   ASX 1-50:   every run
//   ASX 51-100: Mon / Wed / Fri
//   ASX 101-200: Mon / Thu
//
// Required env vars: OPENROUTER_API_KEY, DATABASE_URL
// Usage: node scripts/verify.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { getIRUrl, scrapeIRPage, isIRDailyLimitReached } = require('./lib/ir-pages');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRAPE_DELAY_MS = 1000;

// Time budget: verify.js runs after detect.js in the pipeline.
// The GitHub Actions job has a 45-minute timeout, and detect.js uses up to 35 minutes.
// Verify.js gets whatever is left. Accept a VERIFY_TIME_BUDGET_MS env var from pipeline.js,
// or default to 8 minutes (leaving buffer for notify.js).
const TIME_BUDGET_MS = parseInt(process.env.VERIFY_TIME_BUDGET_MS || '0', 10) || 8 * 60 * 1000;

// ---------------------------------------------------------------------------
// CSV parsing (handles quoted fields with commas)
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  var fields = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Load companies from CSV
// ---------------------------------------------------------------------------

function loadCompanies() {
  var csvPath = path.resolve(__dirname, '..', 'src', 'data', 'asx-companies.csv');
  console.log('[verify] Loading companies from ' + csvPath);

  var raw = fs.readFileSync(csvPath, 'utf-8');
  var lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Parse header
  var header = parseCSVLine(lines[0]);
  var colMap = {};
  for (var i = 0; i < header.length; i++) {
    colMap[header[i].trim().toLowerCase()] = i;
  }

  var codeIdx = colMap['code'] !== undefined ? colMap['code'] : 0;
  var nameIdx = colMap['company_name'] !== undefined ? colMap['company_name'] : 1;
  var rankIdx = colMap['market_cap_rank'] !== undefined ? colMap['market_cap_rank'] : 4;

  var companies = [];
  for (var j = 1; j < lines.length; j++) {
    var line = lines[j].trim();
    if (!line) continue;

    var fields = parseCSVLine(line);
    var code = (fields[codeIdx] || '').trim();
    var name = (fields[nameIdx] || '').trim();
    var rank = parseInt(fields[rankIdx] || '0', 10);

    if (!code || !name) continue;

    companies.push({
      code: code,
      company_name: name,
      market_cap_rank: rank || 9999,
    });
  }

  console.log('[verify] Loaded ' + companies.length + ' companies');
  return companies;
}

// ---------------------------------------------------------------------------
// Determine which tickers to verify based on day of week and rank
// ---------------------------------------------------------------------------

function getTickersForToday(companies) {
  var now = new Date();
  var day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  console.log('[verify] Today is ' + dayNames[day] + ' (' + now.toISOString().substring(0, 10) + ')');

  // Weekend: skip everything
  if (day === 0 || day === 6) {
    console.log('[verify] Weekend — no IR verification scheduled');
    return [];
  }

  var tickers = [];

  for (var i = 0; i < companies.length; i++) {
    var c = companies[i];
    var rank = c.market_cap_rank;

    // ASX 1-50: every weekday run
    if (rank >= 1 && rank <= 50) {
      tickers.push(c.code);
      continue;
    }

    // ASX 51-100: Mon / Wed / Fri
    if (rank >= 51 && rank <= 100) {
      if (day === 1 || day === 3 || day === 5) {
        tickers.push(c.code);
      }
      continue;
    }

    // ASX 101-200: Mon / Thu
    if (rank >= 101 && rank <= 200) {
      if (day === 1 || day === 4) {
        tickers.push(c.code);
      }
      continue;
    }
  }

  // Filter to only tickers that have IR URLs configured
  var withIR = [];
  var withoutIR = 0;
  for (var j = 0; j < tickers.length; j++) {
    if (getIRUrl(tickers[j])) {
      withIR.push(tickers[j]);
    } else {
      withoutIR++;
    }
  }

  console.log('[verify] Tickers to verify: ' + withIR.length + ' (with IR URL) + ' + withoutIR + ' skipped (no IR URL)');
  return withIR;
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// Database upsert — uses company_ir source.
// IR calendars provide DATES early but usually NOT webcast/dial-in details.
// ASX announcements (higher priority) provide the rich details later.
// So IR events use COALESCE to fill dates without overwriting ASX details.
// ---------------------------------------------------------------------------

async function upsertIREvent(sql, event) {
  try {
    var rows = await sql`
      INSERT INTO events (
        ticker, company_name, event_type, event_date, event_time,
        timezone, title, description, webcast_url, replay_url, phone_number,
        phone_passcode, fiscal_period, source, source_url,
        ir_verified, status, updated_at
      ) VALUES (
        ${event.ticker},
        ${event.company_name || event.ticker},
        ${event.event_type},
        ${event.event_date},
        ${event.event_time},
        ${'Australia/Sydney'},
        ${event.title},
        ${event.description},
        ${event.webcast_url},
        ${event.replay_url || null},
        ${event.phone_number},
        ${event.phone_passcode},
        ${event.fiscal_period},
        ${'company_ir'},
        ${event.source_url},
        ${true},
        ${'date_confirmed'},
        ${new Date().toISOString()}
      )
      ON CONFLICT (ticker, event_date, event_type)
      DO UPDATE SET
        company_name   = COALESCE(EXCLUDED.company_name, events.company_name),
        event_time     = COALESCE(events.event_time, EXCLUDED.event_time),
        title          = COALESCE(events.title, EXCLUDED.title),
        description    = COALESCE(events.description, EXCLUDED.description),
        webcast_url    = COALESCE(events.webcast_url, EXCLUDED.webcast_url),
        replay_url     = COALESCE(events.replay_url, EXCLUDED.replay_url),
        phone_number   = COALESCE(events.phone_number, EXCLUDED.phone_number),
        phone_passcode = COALESCE(events.phone_passcode, EXCLUDED.phone_passcode),
        fiscal_period  = COALESCE(EXCLUDED.fiscal_period, events.fiscal_period),
        source         = CASE WHEN events.source = 'asx_announcement' THEN events.source ELSE 'company_ir' END,
        source_url     = COALESCE(events.source_url, EXCLUDED.source_url),
        ir_verified    = true,
        status         = CASE
          WHEN events.webcast_url IS NOT NULL AND events.event_time IS NOT NULL THEN 'confirmed'
          ELSE 'date_confirmed'
        END,
        updated_at     = NOW()
      RETURNING id, ticker, event_date, event_type
    `;

    if (rows && rows.length > 0) {
      return rows[0];
    }
    return null;
  } catch (err) {
    console.log('  [db] Error upserting IR event for ' + event.ticker + ' ' + event.event_date + ': ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main verification pipeline
// ---------------------------------------------------------------------------

async function main() {
  var startTime = Date.now();

  console.log('==========================================================');
  console.log('ASX IR Page Verification Pipeline');
  console.log('Started: ' + new Date().toISOString());
  console.log('==========================================================\n');

  // Validate environment
  var llmApiKey = process.env.OPENROUTER_API_KEY;
  if (!llmApiKey) {
    console.error('[verify] FATAL: OPENROUTER_API_KEY not set');
    process.exit(1);
  }

  var databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[verify] FATAL: DATABASE_URL not set');
    process.exit(1);
  }

  var sql = neon(databaseUrl);

  // Step 1: Load companies from CSV
  var companies = loadCompanies();

  // Step 2: Determine which tickers to verify today
  var tickers = getTickersForToday(companies);
  if (tickers.length === 0) {
    console.log('\n[verify] Nothing to verify today. Exiting.');
    process.exit(0);
  }

  // Build a lookup for company names
  var nameMap = {};
  for (var k = 0; k < companies.length; k++) {
    nameMap[companies[k].code] = companies[k].company_name;
  }

  // Step 3: Scrape IR pages and extract events
  var totalScraped = 0;
  var totalEventsFound = 0;
  var totalEventsUpserted = 0;
  var errors = 0;

  console.log('\n[verify] Starting IR page scraping for ' + tickers.length + ' tickers...\n');

  for (var i = 0; i < tickers.length; i++) {
    // Check time budget before each ticker
    var elapsedMs = Date.now() - startTime;
    if (elapsedMs > TIME_BUDGET_MS) {
      console.log('\n[verify] Time budget reached (' + (elapsedMs / 1000).toFixed(0) + 's). Completed ' + i + '/' + tickers.length + ' tickers.');
      break;
    }

    // Check if LLM daily token budget is exhausted
    if (isIRDailyLimitReached()) {
      console.log('\n[verify] LLM daily token limit reached. Stopping after ' + i + '/' + tickers.length + ' tickers.');
      break;
    }

    var ticker = tickers[i];
    console.log('[' + (i + 1) + '/' + tickers.length + '] ' + ticker);

    try {
      var events = await scrapeIRPage(ticker, llmApiKey);
      totalScraped++;

      if (events.length === 0) {
        continue;
      }

      totalEventsFound += events.length;

      // Step 4: Upsert each event to database
      for (var j = 0; j < events.length; j++) {
        var event = events[j];

        // Attach company name from CSV
        event.company_name = nameMap[ticker] || ticker;

        var result = await upsertIREvent(sql, event);
        if (result) {
          totalEventsUpserted++;
          console.log('    Upserted: ' + event.event_type + ' on ' + event.event_date + ' (id=' + result.id + ')');
        }
      }
    } catch (err) {
      errors++;
      console.log('  [verify] Error processing ' + ticker + ': ' + err.message);
    }

    // Polite delay between tickers
    if (i < tickers.length - 1) {
      await delay(SCRAPE_DELAY_MS);
    }
  }

  // Step 5: Summary
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n==========================================================');
  console.log('IR Verification Complete');
  console.log('==========================================================');
  console.log('  Duration:              ' + elapsed + 's');
  console.log('  Tickers scraped:       ' + totalScraped);
  console.log('  Events found:          ' + totalEventsFound);
  console.log('  Events upserted to DB: ' + totalEventsUpserted);
  console.log('  Errors:                ' + errors);
  console.log('  Finished: ' + new Date().toISOString());
  console.log('==========================================================\n');
}

main().catch(function (err) {
  console.error('[verify] Fatal error:', err);
  process.exit(1);
});
