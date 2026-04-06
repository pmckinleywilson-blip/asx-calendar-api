// ============================================================
// Event Detection Pipeline
// Scans ASX announcements and extracts teleconference/webcast events
// using a two-pass LLM approach via Groq.
//
// Required env vars: GROQ_API_KEY, DATABASE_URL
// Usage: node scripts/detect.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { fetchAnnouncementsForTier, fetchAnnouncementContent } = require('./lib/asx-api');
const { classifyAnnouncements, extractEventDetails } = require('./lib/groq-classify');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GROQ_DELAY_MS = 1000;
const CONTENT_FETCH_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// CSV parsing (handles quoted fields with commas)
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
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
  const csvPath = path.resolve(__dirname, '..', 'src', 'data', 'asx-companies.csv');
  console.log('[detect] Loading companies from ' + csvPath);

  const raw = fs.readFileSync(csvPath, 'utf-8');
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Parse header
  const header = parseCSVLine(lines[0]);
  const colMap = {};
  for (let i = 0; i < header.length; i++) {
    colMap[header[i].trim().toLowerCase()] = i;
  }

  const codeIdx = colMap['code'] !== undefined ? colMap['code'] : 0;
  const nameIdx = colMap['company_name'] !== undefined ? colMap['company_name'] : 1;
  const sectorIdx = colMap['gics_sector'] !== undefined ? colMap['gics_sector'] : 2;
  const rankIdx = colMap['market_cap_rank'] !== undefined ? colMap['market_cap_rank'] : 4;

  const companies = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const code = (fields[codeIdx] || '').trim();
    const name = (fields[nameIdx] || '').trim();
    const sector = (fields[sectorIdx] || '').trim();
    const rank = parseInt(fields[rankIdx] || '0', 10);

    if (!code || !name) continue;

    companies.push({
      code: code,
      company_name: name,
      gics_sector: sector,
      market_cap_rank: rank || 9999,
    });
  }

  console.log('[detect] Loaded ' + companies.length + ' companies');
  return companies;
}

// ---------------------------------------------------------------------------
// Determine which tiers to process based on day of week
// ---------------------------------------------------------------------------

function getTiersForToday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  console.log('[detect] Today is ' + dayNames[day] + ' (' + now.toISOString().substring(0, 10) + ')');

  const tiers = [];

  // ASX 100: Monday-Friday
  if (day >= 1 && day <= 5) {
    tiers.push('asx100');
  }

  // ASX 101-300: Monday, Wednesday, Friday
  if (day === 1 || day === 3 || day === 5) {
    tiers.push('asx101-300');
  }

  // ASX 301-500: Monday, Thursday
  if (day === 1 || day === 4) {
    tiers.push('asx301-500');
  }

  if (tiers.length === 0) {
    console.log('[detect] No tiers scheduled for today (weekend)');
  } else {
    console.log('[detect] Tiers to process: ' + tiers.join(', '));
  }

  return tiers;
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// Database upsert
// ---------------------------------------------------------------------------

async function upsertEvent(sql, event) {
  try {
    const rows = await sql`
      INSERT INTO events (
        ticker, company_name, event_type, event_date, event_time,
        timezone, title, description, webcast_url, phone_number,
        phone_passcode, fiscal_period, source, source_url,
        ir_verified, status, updated_at
      ) VALUES (
        ${event.ticker},
        ${event.company_name},
        ${event.event_type},
        ${event.event_date},
        ${event.event_time},
        ${'Australia/Sydney'},
        ${event.title},
        ${event.description},
        ${event.webcast_url},
        ${event.phone_number},
        ${event.phone_passcode},
        ${event.fiscal_period},
        ${'asx-announcement-llm'},
        ${event.source_url},
        ${false},
        ${event.confidence === 'high' ? 'confirmed' : 'tentative'},
        ${new Date().toISOString()}
      )
      ON CONFLICT (ticker, event_date, event_type)
      DO UPDATE SET
        company_name   = EXCLUDED.company_name,
        event_time     = COALESCE(EXCLUDED.event_time, events.event_time),
        title          = COALESCE(EXCLUDED.title, events.title),
        description    = COALESCE(EXCLUDED.description, events.description),
        webcast_url    = COALESCE(EXCLUDED.webcast_url, events.webcast_url),
        phone_number   = COALESCE(EXCLUDED.phone_number, events.phone_number),
        phone_passcode = COALESCE(EXCLUDED.phone_passcode, events.phone_passcode),
        fiscal_period  = COALESCE(EXCLUDED.fiscal_period, events.fiscal_period),
        source_url     = COALESCE(EXCLUDED.source_url, events.source_url),
        updated_at     = NOW()
      RETURNING id, ticker, event_date, event_type
    `;

    if (rows && rows.length > 0) {
      return rows[0];
    }
    return null;
  } catch (err) {
    console.log('  [db] Error upserting event for ' + event.ticker + ' ' + event.event_date + ': ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main detection pipeline
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log('==========================================================');
  console.log('ASX Event Detection Pipeline');
  console.log('Started: ' + new Date().toISOString());
  console.log('==========================================================\n');

  // Validate environment
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.error('[detect] FATAL: GROQ_API_KEY not set');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[detect] FATAL: DATABASE_URL not set');
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  // Step 1: Load companies
  const companies = loadCompanies();

  // Step 2: Determine tiers
  const tiers = getTiersForToday();
  if (tiers.length === 0) {
    console.log('\n[detect] Nothing to do today. Exiting.');
    process.exit(0);
  }

  // Tracking stats
  let totalCompaniesScanned = 0;
  let totalAnnouncementsFetched = 0;
  let totalClassified = 0;
  let totalRelevant = 0;
  let totalEventsDetected = 0;
  let totalEventsUpserted = 0;

  // Step 3-6: Process each tier
  for (let t = 0; t < tiers.length; t++) {
    const tier = tiers[t];
    console.log('\n----------------------------------------------------------');
    console.log('Processing tier: ' + tier);
    console.log('----------------------------------------------------------\n');

    // Step 3: Fetch announcements
    const announcements = await fetchAnnouncementsForTier(companies, tier);
    const tierCompanyCount = new Set(announcements.map(function (a) { return a.ticker; })).size;

    totalCompaniesScanned += tierCompanyCount;
    totalAnnouncementsFetched += announcements.length;

    if (announcements.length === 0) {
      console.log('[detect] No announcements found for tier ' + tier + '. Skipping.');
      continue;
    }

    // Step 4: Batch classify with Groq
    console.log('\n[detect] Pass 1: Classifying ' + announcements.length + ' announcements...');
    const relevant = await classifyAnnouncements(announcements, groqApiKey);

    totalClassified += announcements.length;
    totalRelevant += relevant.length;

    if (relevant.length === 0) {
      console.log('[detect] No relevant announcements found for tier ' + tier + '. Skipping extraction.');
      continue;
    }

    // Step 5: Deep extract from relevant announcements
    console.log('\n[detect] Pass 2: Deep extraction from ' + relevant.length + ' announcements...');

    for (let i = 0; i < relevant.length; i++) {
      const ann = relevant[i];
      console.log('  [' + (i + 1) + '/' + relevant.length + '] ' + ann.ticker + ' — ' + ann.title + ' [' + ann.classification + ']');

      // Fetch the full announcement content
      const content = await fetchAnnouncementContent(ann.url);

      if (!content) {
        console.log('    Skipped: could not fetch content');
        continue;
      }

      // Wait before calling Groq
      await delay(GROQ_DELAY_MS);

      // Extract event details
      const event = await extractEventDetails(ann, content, groqApiKey);

      if (!event) {
        console.log('    No event found');
        continue;
      }

      totalEventsDetected++;
      console.log('    DETECTED: ' + event.event_type + ' on ' + event.event_date + (event.event_time ? ' at ' + event.event_time : '') + ' [' + event.confidence + ']');

      // Step 6: Upsert to database
      const result = await upsertEvent(sql, event);
      if (result) {
        totalEventsUpserted++;
        console.log('    Upserted: event id=' + result.id);
      }

      // Delay between content fetches
      if (i < relevant.length - 1) {
        await delay(CONTENT_FETCH_DELAY_MS);
      }
    }
  }

  // Step 7: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n==========================================================');
  console.log('Detection Pipeline Complete');
  console.log('==========================================================');
  console.log('  Duration:                 ' + elapsed + 's');
  console.log('  Companies scanned:        ' + totalCompaniesScanned);
  console.log('  Announcements fetched:    ' + totalAnnouncementsFetched);
  console.log('  Announcements classified: ' + totalClassified);
  console.log('  Flagged for extraction:   ' + totalRelevant);
  console.log('  Events detected:          ' + totalEventsDetected);
  console.log('  Events upserted to DB:    ' + totalEventsUpserted);
  console.log('  Finished: ' + new Date().toISOString());
  console.log('==========================================================\n');
}

main().catch(function (err) {
  console.error('[detect] Fatal error:', err);
  process.exit(1);
});
