// ============================================================
// Continuous Announcement Poller
//
// Sweeps all 500 ASX All Ords companies every ~5 seconds,
// deduplicates against seen_announcements table, and sends
// only genuinely new announcements through the full Groq
// reasoning pipeline.
//
// Designed to run as a persistent process on Railway.app (free tier).
// Sleeps outside ASX filing hours (before 7am / after 8pm AEST).
// Sleeps on weekends.
//
// Required env vars: DATABASE_URL, OPENROUTER_API_KEY (or GROQ_API_KEY)
// Optional env vars: RESEND_API_KEY, INVITE_FROM_EMAIL
// Usage: node scripts/poller.js
// ============================================================

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');
const { fetchAnnouncements } = require('./lib/asx-api');
const { classifyAnnouncements, extractEventDetails } = require('./lib/groq-classify');
const { fetchAnnouncementContent } = require('./lib/asx-api');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONCURRENCY = 50;          // API calls in parallel per batch
const SWEEP_PAUSE_MS = 2000;     // Pause between full sweeps
const GROQ_DELAY_MS = 1000;      // Delay between Groq calls
const BATCH_DELAY_MS = 200;      // Delay between concurrent batches
const CLEANUP_INTERVAL_H = 24;   // Hours between seen_announcements cleanup
const SEEN_RETENTION_DAYS = 90;  // Keep seen IDs for 90 days

// ASX filing hours (AEST = UTC+10)
const FILING_START_HOUR_AEST = 7;   // 7:00am AEST
const FILING_END_HOUR_AEST = 20;    // 8:00pm AEST (buffer past 7:30pm)

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
  var raw = fs.readFileSync(csvPath, 'utf-8');
  var lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

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

    companies.push({ code: code, company_name: name, market_cap_rank: rank || 9999 });
  }

  return companies;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function nowAEST() {
  // Get current time in AEST (UTC+10)
  var now = new Date();
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 10 * 3600000);
}

function isFilingHours() {
  var aest = nowAEST();
  var day = aest.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  var hour = aest.getHours();
  return hour >= FILING_START_HOUR_AEST && hour < FILING_END_HOUR_AEST;
}

function formatAEST(date) {
  var h = date.getHours().toString().padStart(2, '0');
  var m = date.getMinutes().toString().padStart(2, '0');
  var s = date.getSeconds().toString().padStart(2, '0');
  return h + ':' + m + ':' + s + ' AEST';
}

// ---------------------------------------------------------------------------
// Database: seen announcements
// ---------------------------------------------------------------------------

async function loadSeenKeys(sql) {
  var rows = await sql`SELECT document_key FROM seen_announcements`;
  var set = new Set();
  for (var i = 0; i < rows.length; i++) {
    set.add(rows[i].document_key);
  }
  return set;
}

async function markSeen(sql, announcements) {
  if (announcements.length === 0) return;

  // Batch insert, ignore duplicates
  for (var i = 0; i < announcements.length; i++) {
    var a = announcements[i];
    try {
      await sql`
        INSERT INTO seen_announcements (document_key, ticker, title, announcement_date)
        VALUES (${a.id}, ${a.ticker}, ${a.title}, ${a.date})
        ON CONFLICT (document_key) DO NOTHING
      `;
    } catch (err) {
      // Ignore insert errors for individual items
    }
  }
}

async function cleanupSeen(sql) {
  var cutoff = new Date(Date.now() - SEEN_RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  var rows = await sql`
    DELETE FROM seen_announcements WHERE first_seen_at < ${cutoff} RETURNING document_key
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Database: event upsert (same as detect.js)
// ---------------------------------------------------------------------------

async function upsertEvent(sql, event) {
  try {
    var rows = await sql`
      INSERT INTO events (
        ticker, company_name, event_type, event_date, event_time,
        timezone, title, description, webcast_url, replay_url, phone_number,
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
        ${event.replay_url || null},
        ${event.phone_number},
        ${event.phone_passcode},
        ${event.fiscal_period},
        ${'asx-announcement-llm'},
        ${event.source_url},
        ${false},
        ${(event.webcast_url && event.event_time) ? 'confirmed' : 'date_confirmed'},
        ${new Date().toISOString()}
      )
      ON CONFLICT (ticker, event_date, event_type)
      DO UPDATE SET
        company_name   = EXCLUDED.company_name,
        event_time     = COALESCE(EXCLUDED.event_time, events.event_time),
        title          = COALESCE(EXCLUDED.title, events.title),
        description    = COALESCE(EXCLUDED.description, events.description),
        webcast_url    = COALESCE(EXCLUDED.webcast_url, events.webcast_url),
        replay_url     = COALESCE(EXCLUDED.replay_url, events.replay_url),
        phone_number   = COALESCE(EXCLUDED.phone_number, events.phone_number),
        phone_passcode = COALESCE(EXCLUDED.phone_passcode, events.phone_passcode),
        fiscal_period  = COALESCE(EXCLUDED.fiscal_period, events.fiscal_period),
        source_url     = COALESCE(EXCLUDED.source_url, events.source_url),
        status         = CASE
          WHEN COALESCE(EXCLUDED.webcast_url, events.webcast_url) IS NOT NULL
           AND COALESCE(EXCLUDED.event_time, events.event_time) IS NOT NULL
          THEN 'confirmed' ELSE 'date_confirmed' END,
        updated_at     = NOW()
      RETURNING id, ticker, event_date, event_type
    `;

    if (rows && rows.length > 0) return rows[0];
    return null;
  } catch (err) {
    console.log('  [db] Upsert error: ' + event.ticker + ' ' + event.event_date + ': ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single sweep: fetch all companies, find new announcements
// ---------------------------------------------------------------------------

async function sweep(companies, seenKeys, sql) {
  var allNew = [];

  // Fire all companies in batches of CONCURRENCY
  for (var i = 0; i < companies.length; i += CONCURRENCY) {
    var batch = companies.slice(i, i + CONCURRENCY);

    var results = await Promise.allSettled(
      batch.map(function (company) {
        return fetchAnnouncements(company.code, 30).then(function (anns) {
          for (var j = 0; j < anns.length; j++) {
            anns[j].ticker = company.code;
            anns[j].company_name = company.company_name;
          }
          return anns;
        });
      })
    );

    for (var r = 0; r < results.length; r++) {
      if (results[r].status !== 'fulfilled' || !results[r].value) continue;
      var anns = results[r].value;
      for (var a = 0; a < anns.length; a++) {
        if (!seenKeys.has(anns[a].id)) {
          allNew.push(anns[a]);
        }
      }
    }

    if (i + CONCURRENCY < companies.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  return allNew;
}

// ---------------------------------------------------------------------------
// Process new announcements through the Groq reasoning pipeline
// ---------------------------------------------------------------------------

async function processNewAnnouncements(newAnns, sql, groqApiKey) {
  if (newAnns.length === 0) return { classified: 0, extracted: 0, upserted: 0 };

  var stats = { classified: newAnns.length, extracted: 0, upserted: 0 };

  // Step 1: Classify — let Groq reason about which are event-related
  var relevant = await classifyAnnouncements(newAnns, groqApiKey);

  if (relevant.length === 0) return stats;

  // Step 2: Deep extract from relevant announcements
  for (var i = 0; i < relevant.length; i++) {
    var ann = relevant[i];

    var content = await fetchAnnouncementContent(ann.url);
    if (!content) continue;

    await delay(GROQ_DELAY_MS);

    var event = await extractEventDetails(ann, content, groqApiKey);
    if (!event) continue;

    stats.extracted++;
    console.log('    EVENT: ' + event.ticker + ' ' + event.event_type + ' on ' + event.event_date +
      (event.event_time ? ' at ' + event.event_time : '') +
      (event.webcast_url ? ' [webcast]' : ''));

    var result = await upsertEvent(sql, event);
    if (result) {
      stats.upserted++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  console.log('============================================================');
  console.log('  ASX Continuous Announcement Poller');
  console.log('  Started: ' + new Date().toISOString());
  console.log('============================================================');
  console.log('');

  // Validate env — accept either OpenRouter (preferred) or Groq
  var databaseUrl = process.env.DATABASE_URL;
  var groqApiKey = process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY;

  if (!databaseUrl) { console.error('FATAL: DATABASE_URL not set'); process.exit(1); }
  if (!groqApiKey) { console.error('FATAL: No LLM API key set. Set OPENROUTER_API_KEY or GROQ_API_KEY'); process.exit(1); }

  var sql = neon(databaseUrl);

  // Ensure seen_announcements table exists
  await sql`
    CREATE TABLE IF NOT EXISTS seen_announcements (
      document_key  TEXT PRIMARY KEY,
      ticker        TEXT NOT NULL,
      title         TEXT,
      announcement_date DATE,
      first_seen_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Load companies
  var companies = loadCompanies();
  console.log('[poller] Loaded ' + companies.length + ' companies (All Ords 500)');

  // Load seen keys into memory for fast dedup
  var seenKeys = await loadSeenKeys(sql);
  console.log('[poller] Loaded ' + seenKeys.size + ' seen announcement keys');
  console.log('');

  // Stats
  var totalSweeps = 0;
  var totalNew = 0;
  var totalEvents = 0;
  var lastCleanup = Date.now();

  // ── Main loop ──────────────────────────────────────────────
  while (true) {
    // Check if we're in filing hours
    if (!isFilingHours()) {
      var aest = nowAEST();
      var day = aest.getDay();
      var hour = aest.getHours();

      // Calculate sleep duration
      var sleepMs;
      if (day === 6) {
        // Saturday → sleep until Monday 7am
        sleepMs = ((24 - hour) + 24 + FILING_START_HOUR_AEST) * 3600 * 1000;
      } else if (day === 0) {
        // Sunday → sleep until Monday 7am
        sleepMs = ((24 - hour) + FILING_START_HOUR_AEST) * 3600 * 1000;
      } else if (hour >= FILING_END_HOUR_AEST) {
        // After hours → sleep until tomorrow 7am (or Monday if Friday)
        var hoursUntilTomorrow = 24 - hour + FILING_START_HOUR_AEST;
        if (day === 5) hoursUntilTomorrow += 48; // Friday evening → Monday
        sleepMs = hoursUntilTomorrow * 3600 * 1000;
      } else {
        // Before hours → sleep until 7am
        sleepMs = (FILING_START_HOUR_AEST - hour) * 3600 * 1000;
      }

      // Cap sleep at 1 hour chunks so we re-check
      sleepMs = Math.min(sleepMs, 3600 * 1000);

      console.log('[poller] Outside filing hours (' + formatAEST(aest) + '). Sleeping ' + Math.round(sleepMs / 60000) + ' min...');
      await delay(sleepMs);
      continue;
    }

    // ── Sweep ──────────────────────────────────────────────
    var sweepStart = Date.now();
    totalSweeps++;

    var newAnns = await sweep(companies, seenKeys, sql);

    var sweepMs = Date.now() - sweepStart;

    if (newAnns.length > 0) {
      totalNew += newAnns.length;

      console.log('[sweep ' + totalSweeps + '] ' + (sweepMs / 1000).toFixed(1) + 's — ' +
        newAnns.length + ' NEW announcement(s):');

      for (var i = 0; i < newAnns.length; i++) {
        console.log('  + ' + newAnns[i].ticker + ': ' + newAnns[i].title.substring(0, 80));
      }

      // Mark as seen immediately (so next sweep doesn't re-process)
      for (var j = 0; j < newAnns.length; j++) {
        seenKeys.add(newAnns[j].id);
      }
      await markSeen(sql, newAnns);

      // Process through Groq reasoning pipeline
      var stats = await processNewAnnouncements(newAnns, sql, groqApiKey);
      totalEvents += stats.upserted;

      if (stats.upserted > 0) {
        console.log('  → Classified: ' + stats.classified + ', Extracted: ' + stats.extracted + ', Upserted: ' + stats.upserted);
      }
    } else {
      // Periodic status log (every 100 sweeps ≈ every ~8 minutes)
      if (totalSweeps % 100 === 0) {
        console.log('[sweep ' + totalSweeps + '] ' + (sweepMs / 1000).toFixed(1) + 's — no new. ' +
          formatAEST(nowAEST()) + ' | total new today: ' + totalNew + ' | events: ' + totalEvents);
      }
    }

    // Periodic cleanup of old seen entries
    if (Date.now() - lastCleanup > CLEANUP_INTERVAL_H * 3600 * 1000) {
      var cleaned = await cleanupSeen(sql);
      if (cleaned > 0) console.log('[poller] Cleaned up ' + cleaned + ' old seen entries');

      // Reload seen keys (in case another process added some)
      seenKeys = await loadSeenKeys(sql);
      lastCleanup = Date.now();
    }

    // Brief pause between sweeps
    await delay(SWEEP_PAUSE_MS);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGTERM', function () {
  console.log('\n[poller] SIGTERM received. Shutting down gracefully...');
  console.log('[poller] Total sweeps: ' + 0 + ', Total new: ' + 0);
  process.exit(0);
});

process.on('SIGINT', function () {
  console.log('\n[poller] SIGINT received. Shutting down...');
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch(function (err) {
  console.error('[poller] Fatal error:', err);
  process.exit(1);
});
