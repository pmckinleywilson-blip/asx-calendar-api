// ============================================================
// Estimated Events Generator
//
// Seeds the database with estimated HY/FY earnings dates for
// ALL ASX companies based on standard Australian reporting
// calendar patterns. This is the FOUNDATION layer — every
// company gets at least 2 estimated events.
//
// These estimates use status='estimated', source='estimated'
// (lowest priority), so they get automatically upgraded when
// real dates arrive from IR pages or ASX announcements.
//
// Required env vars: DATABASE_URL
// Usage: node scripts/estimate.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

// ---------------------------------------------------------------------------
// Fiscal year end overrides for companies with non-standard FY ends.
// Default for all others: June 30 (standard Australian financial year).
// ---------------------------------------------------------------------------

const FY_END = {
  // September 30 FY end — major banks and some financials
  WBC: 'sep30', NAB: 'sep30', ANZ: 'sep30', BEN: 'sep30',
  BOQ: 'sep30', ADB: 'sep30', ALL: 'sep30', TNE: 'sep30',
  PNI: 'sep30', HUB: 'sep30', NWL: 'sep30',

  // March 31 FY end
  MQG: 'mar31', XRO: 'mar31', JHX: 'mar31',

  // December 31 FY end — mostly dual-listed / international
  NEM: 'dec31', RMD: 'dec31', JHG: 'dec31',
};

// ---------------------------------------------------------------------------
// Reporting calendar: typical announcement month/day for each FY end pattern.
// These are mid-range estimates — most companies announce within ±2 weeks.
// ---------------------------------------------------------------------------

const CALENDAR = {
  jun30: {
    hy: { month: 2, day: 15 },   // HY results (Dec period) → mid-Feb
    fy: { month: 8, day: 20 },   // FY results (Jun period) → mid-Aug
  },
  sep30: {
    hy: { month: 5, day: 8 },    // HY results (Mar period) → early May
    fy: { month: 11, day: 5 },   // FY results (Sep period) → early Nov
  },
  mar31: {
    hy: { month: 11, day: 15 },  // HY results (Sep period) → mid-Nov
    fy: { month: 5, day: 15 },   // FY results (Mar period) → mid-May
  },
  dec31: {
    hy: { month: 8, day: 20 },   // HY results (Jun period) → mid-Aug
    fy: { month: 2, day: 20 },   // FY results (Dec period) → mid-Feb
  },
};

// Map FY end → fiscal year label logic.
// The fiscal year label is the CALENDAR year the FY ends in.
// e.g. FY ending Jun 2026 → FY2026, HY ending Dec 2025 of FY2026 → HY2026
function getFiscalLabels(fyEnd, eventYear, isHY) {
  if (fyEnd === 'jun30') {
    // FY2026 = Jul 2025 – Jun 2026. FY results Aug 2026 → FY2026
    // HY of FY2026 = Jul–Dec 2025. HY results Feb 2026 → HY2026
    // But if HY is in Feb of year Y, that's HY of FY ending Jun Y → HY{Y}
    // If FY is in Aug of year Y, that's FY ending Jun Y → FY{Y}
    return isHY ? 'HY' + eventYear : 'FY' + eventYear;
  }
  if (fyEnd === 'sep30') {
    // FY2026 = Oct 2025 – Sep 2026. FY results Nov 2026 → FY2026
    // HY of FY2026 = Oct 2025 – Mar 2026. HY results May 2026 → HY2026
    return isHY ? 'HY' + eventYear : 'FY' + eventYear;
  }
  if (fyEnd === 'mar31') {
    // FY2026 = Apr 2025 – Mar 2026. FY results May 2026 → FY2026
    // HY of FY2027 = Apr–Sep 2026. HY results Nov 2026 → HY2027
    return isHY ? 'HY' + (eventYear + 1) : 'FY' + eventYear;
  }
  if (fyEnd === 'dec31') {
    // FY2025 = Jan–Dec 2025. FY results Feb 2026 → FY2025
    // HY of FY2026 = Jan–Jun 2026. HY results Aug 2026 → HY2026
    return isHY ? 'HY' + eventYear : 'FY' + (eventYear - 1);
  }
  return isHY ? 'HY' + eventYear : 'FY' + eventYear;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  var fields = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

function loadCompanies() {
  var csvPath = path.resolve(__dirname, '..', 'src', 'data', 'asx-companies.csv');
  var raw = fs.readFileSync(csvPath, 'utf-8');
  var lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  var header = parseCSVLine(lines[0]);
  var colMap = {};
  for (var i = 0; i < header.length; i++) {
    colMap[header[i].trim().toLowerCase()] = i;
  }

  var codeIdx = colMap['code'] !== undefined ? colMap['code'] : 0;
  var nameIdx = colMap['company_name'] !== undefined ? colMap['company_name'] : 1;

  var companies = [];
  for (var j = 1; j < lines.length; j++) {
    var line = lines[j].trim();
    if (!line) continue;
    var fields = parseCSVLine(line);
    var code = (fields[codeIdx] || '').trim();
    var name = (fields[nameIdx] || '').trim();
    if (!code || !name) continue;
    companies.push({ code: code, company_name: name });
  }

  return companies;
}

// ---------------------------------------------------------------------------
// Generate estimated events for a single company
// ---------------------------------------------------------------------------

function generateEstimates(company, fromDate) {
  var fyEnd = FY_END[company.code] || 'jun30';
  var cal = CALENDAR[fyEnd];
  var events = [];

  // Generate candidates for this year and next year
  var baseYear = fromDate.getFullYear();

  for (var y = baseYear; y <= baseYear + 1; y++) {
    // HY results
    var hyDate = new Date(y, cal.hy.month - 1, cal.hy.day);
    if (hyDate > fromDate) {
      var hyLabel = getFiscalLabels(fyEnd, y, true);
      events.push({
        ticker: company.code,
        company_name: company.company_name,
        event_type: 'earnings',
        event_date: formatDate(hyDate),
        event_time: null,
        title: hyLabel + ' Half Year Results',
        description: 'Estimated date based on typical reporting calendar',
        fiscal_period: hyLabel,
        source: 'estimated',
        status: 'estimated',
      });
    }

    // FY results
    var fyDate = new Date(y, cal.fy.month - 1, cal.fy.day);
    if (fyDate > fromDate) {
      var fyLabel = getFiscalLabels(fyEnd, y, false);
      events.push({
        ticker: company.code,
        company_name: company.company_name,
        event_type: 'earnings',
        event_date: formatDate(fyDate),
        event_time: null,
        title: fyLabel + ' Full Year Results',
        description: 'Estimated date based on typical reporting calendar',
        fiscal_period: fyLabel,
        source: 'estimated',
        status: 'estimated',
      });
    }
  }

  // Return next 2 events only
  events.sort(function (a, b) { return a.event_date.localeCompare(b.event_date); });
  return events.slice(0, 2);
}

function formatDate(d) {
  var yyyy = d.getFullYear();
  var mm = String(d.getMonth() + 1).padStart(2, '0');
  var dd = String(d.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
}

// ---------------------------------------------------------------------------
// Database upsert — lowest priority, never overwrites real data
// ---------------------------------------------------------------------------

async function upsertEstimatedEvent(sql, event) {
  try {
    var rows = await sql`
      INSERT INTO events (
        ticker, company_name, event_type, event_date, event_time,
        timezone, title, description, webcast_url, replay_url,
        phone_number, phone_passcode, fiscal_period,
        source, source_url, ir_verified, status, updated_at
      ) VALUES (
        ${event.ticker}, ${event.company_name}, ${event.event_type},
        ${event.event_date}, ${null}, ${'Australia/Sydney'},
        ${event.title}, ${event.description}, ${null}, ${null},
        ${null}, ${null}, ${event.fiscal_period},
        ${'estimated'}, ${null}, ${false}, ${'estimated'},
        ${new Date().toISOString()}
      )
      ON CONFLICT (ticker, event_date, event_type)
      DO UPDATE SET
        company_name = CASE WHEN events.source = 'estimated' THEN EXCLUDED.company_name ELSE events.company_name END,
        title        = CASE WHEN events.source = 'estimated' THEN EXCLUDED.title ELSE events.title END,
        description  = CASE WHEN events.source = 'estimated' THEN EXCLUDED.description ELSE events.description END,
        updated_at   = CASE WHEN events.source = 'estimated' THEN NOW() ELSE events.updated_at END
      RETURNING id, ticker, event_date, event_type,
        (xmax = 0) AS was_inserted
    `;

    if (rows && rows.length > 0) return rows[0];
    return null;
  } catch (err) {
    // Silently skip constraint violations — they mean a real event already exists
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  var startTime = Date.now();

  console.log('==========================================================');
  console.log('ASX Estimated Events Generator');
  console.log('Started: ' + new Date().toISOString());
  console.log('==========================================================\n');

  var databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[estimate] FATAL: DATABASE_URL not set');
    process.exit(1);
  }

  var sql = neon(databaseUrl);

  // Load all companies
  var companies = loadCompanies();
  console.log('[estimate] Loaded ' + companies.length + ' companies');

  var now = new Date();
  var totalGenerated = 0;
  var totalInserted = 0;
  var totalSkipped = 0;

  // Generate and upsert estimated events for every company
  for (var i = 0; i < companies.length; i++) {
    var company = companies[i];
    var estimates = generateEstimates(company, now);

    for (var j = 0; j < estimates.length; j++) {
      totalGenerated++;
      var result = await upsertEstimatedEvent(sql, estimates[j]);

      if (result && result.was_inserted) {
        totalInserted++;
      } else {
        totalSkipped++; // Already had a real event for this slot
      }
    }

    // Progress log every 200 companies
    if ((i + 1) % 200 === 0 || i === companies.length - 1) {
      console.log('[estimate] Progress: ' + (i + 1) + '/' + companies.length +
        ' companies — ' + totalInserted + ' inserted, ' + totalSkipped + ' skipped');
    }
  }

  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n==========================================================');
  console.log('Estimated Events Complete');
  console.log('==========================================================');
  console.log('  Duration:          ' + elapsed + 's');
  console.log('  Companies:         ' + companies.length);
  console.log('  Events generated:  ' + totalGenerated);
  console.log('  Events inserted:   ' + totalInserted);
  console.log('  Events skipped:    ' + totalSkipped + ' (real data already exists)');
  console.log('  Finished: ' + new Date().toISOString());
  console.log('==========================================================\n');
}

main().catch(function (err) {
  console.error('[estimate] Fatal error:', err);
  process.exit(1);
});
