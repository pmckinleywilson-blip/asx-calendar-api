#!/usr/bin/env node
// ============================================================
// IR Scrape Diagnostic Test
//
// Tests every step of the IR scraping pipeline to find failures:
//   1. HTTP fetch — can we reach the IR page?
//   2. Content quality — does the page return real content or a bot block?
//   3. LLM extraction — does the LLM find events in the content?
//   4. Ground truth — do extracted dates match known real dates?
//
// Usage:
//   node scripts/test-ir-scrape.js                    # Test all IR URLs
//   node scripts/test-ir-scrape.js TNE CBA WBC        # Test specific tickers
//   node scripts/test-ir-scrape.js --fetch-only        # Skip LLM, just test HTTP
//   node scripts/test-ir-scrape.js --with-llm TNE      # Full pipeline test for TNE
//
// Required env vars (for --with-llm): OPENROUTER_API_KEY
// ============================================================

const https = require('https');
const http = require('http');
const { IR_URLS } = require('./lib/ir-pages');

const USER_AGENT = 'ASXCalendarAPI/1.0 (events calendar)';
const FETCH_TIMEOUT_MS = 15000;

// Known ground-truth events for validation.
// Update these when you know the real dates from company websites.
const GROUND_TRUTH = {
  TNE: { event: 'HY2026 Half Year Results', date: '2026-05-19', source: 'technology1.com IR page' },
  // Add more as you discover them:
  // CBA: { event: 'FY2026 Full Year Results', date: '2026-08-13', source: 'commbank.com.au' },
};

// ---------------------------------------------------------------------------
// ANSI colours for terminal output
// ---------------------------------------------------------------------------

const C = {
  red: (s) => '\x1b[31m' + s + '\x1b[0m',
  green: (s) => '\x1b[32m' + s + '\x1b[0m',
  yellow: (s) => '\x1b[33m' + s + '\x1b[0m',
  cyan: (s) => '\x1b[36m' + s + '\x1b[0m',
  dim: (s) => '\x1b[2m' + s + '\x1b[0m',
  bold: (s) => '\x1b[1m' + s + '\x1b[0m',
};

// ---------------------------------------------------------------------------
// HTTP fetch with redirect following
// ---------------------------------------------------------------------------

function fetchURL(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;

  return new Promise(function (resolve, reject) {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    var mod = url.startsWith('https') ? https : http;
    var parsed = new URL(url);

    var req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html, application/xhtml+xml, */*',
      },
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = res.headers.location;
        if (!next.startsWith('http')) next = parsed.origin + next;
        res.resume();
        return resolve(fetchURL(next, maxRedirects - 1).then(function (result) {
          result.redirected_from = url;
          return result;
        }));
      }

      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          url: url,
          final_url: url,
          body: body,
          redirected_from: null,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, function () {
      req.destroy();
      reject(new Error('Timeout after ' + FETCH_TIMEOUT_MS + 'ms'));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Content analysis
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function analyzeContent(body) {
  var result = {
    raw_length: body.length,
    text_length: 0,
    is_cloudflare_block: false,
    is_bot_block: false,
    is_spa_shell: false,
    has_date_content: false,
    date_snippets: [],
    quality: 'unknown',
  };

  // Detect Cloudflare challenge
  if (body.includes('Just a moment') && body.includes('Enable JavaScript')) {
    result.is_cloudflare_block = true;
    result.quality = 'blocked_cloudflare';
    return result;
  }

  // Detect other bot blocks
  if (body.includes('Access Denied') || body.includes('captcha') || body.includes('verify you are human')) {
    result.is_bot_block = true;
    result.quality = 'blocked_bot';
    return result;
  }

  var text = stripHtml(body);
  result.text_length = text.length;

  // Detect SPA shell (minimal text, mostly JavaScript)
  if (text.length < 200 && body.includes('__NEXT_DATA__') || body.includes('id="__nuxt"') || body.includes('id="app"')) {
    result.is_spa_shell = true;
    result.quality = 'spa_no_content';
    return result;
  }

  if (text.length < 100) {
    result.quality = 'empty';
    return result;
  }

  // Look for date/event-related content
  var datePatterns = [
    /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/gi,
    /\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)/gi,
    /\d{1,2}\/\d{1,2}\/\d{2,4}/g,
    /\d{4}-\d{2}-\d{2}/g,
  ];

  var eventKeywords = /(?:results|half.?year|full.?year|agm|annual.?general|investor.?day|webcast|presentation|briefing|earnings|conference.?call|financial.?calendar|key.?dates)/gi;

  var keywordMatches = text.match(eventKeywords);
  result.has_date_content = keywordMatches && keywordMatches.length > 0;

  // Extract date-related snippets for inspection
  var snippetPattern = /(?:results|half.?year|full.?year|agm|annual|investor|webcast|earnings|financial|calendar|key.?dates)[^.]{0,150}/gi;
  var snippets = text.match(snippetPattern);
  if (snippets) {
    result.date_snippets = snippets.slice(0, 5).map(function (s) { return s.trim(); });
  }

  if (result.has_date_content && text.length > 500) {
    result.quality = 'good';
  } else if (text.length > 500) {
    result.quality = 'content_no_dates';
  } else {
    result.quality = 'thin';
  }

  return result;
}

// ---------------------------------------------------------------------------
// LLM extraction test (reuses the actual scrapeIRPage function)
// ---------------------------------------------------------------------------

async function testLLMExtraction(ticker, llmApiKey) {
  var { scrapeIRPage } = require('./lib/ir-pages');

  try {
    var events = await scrapeIRPage(ticker, llmApiKey);
    return { success: true, events: events };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Ground truth comparison
// ---------------------------------------------------------------------------

function checkGroundTruth(ticker, extractedEvents) {
  var truth = GROUND_TRUTH[ticker];
  if (!truth) return null;

  // Check if any extracted event matches the known date
  for (var i = 0; i < extractedEvents.length; i++) {
    if (extractedEvents[i].event_date === truth.date) {
      return { match: true, expected: truth, got: extractedEvents[i] };
    }
  }

  // Check what we got instead
  var earningsEvents = extractedEvents.filter(function (e) {
    return e.event_type === 'earnings';
  });

  return {
    match: false,
    expected: truth,
    got: earningsEvents.length > 0 ? earningsEvents[0] : null,
    all_dates: extractedEvents.map(function (e) { return e.event_date + ' (' + e.title + ')'; }),
  };
}

// ---------------------------------------------------------------------------
// Database comparison — check what's in the DB vs what we find
// ---------------------------------------------------------------------------

async function checkDatabase(ticker) {
  if (!process.env.DATABASE_URL) return null;

  try {
    var { neon } = require('@neondatabase/serverless');
    var sql = neon(process.env.DATABASE_URL);
    var rows = await sql`
      SELECT event_date, event_type, status, source, title
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

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

async function main() {
  var args = process.argv.slice(2);
  var fetchOnly = args.includes('--fetch-only');
  var withLLM = args.includes('--with-llm');
  var tickers = args.filter(function (a) { return !a.startsWith('--'); });

  // If no tickers specified, test all IR URLs
  if (tickers.length === 0) {
    tickers = Object.keys(IR_URLS);
  } else {
    tickers = tickers.map(function (t) { return t.toUpperCase(); });
  }

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  ASX Calendar — IR Scrape Diagnostic Test'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('  Date:    ' + new Date().toISOString().substring(0, 10));
  console.log('  Tickers: ' + tickers.length);
  console.log('  Mode:    ' + (withLLM ? 'Full (fetch + LLM)' : fetchOnly ? 'Fetch only' : 'Fetch + analysis'));
  if (withLLM && !process.env.OPENROUTER_API_KEY) {
    console.log(C.red('\n  ERROR: --with-llm requires OPENROUTER_API_KEY env var'));
    process.exit(1);
  }
  console.log('');

  // Counters
  var stats = {
    total: tickers.length,
    fetch_ok: 0,
    fetch_fail: 0,
    blocked_cloudflare: 0,
    blocked_bot: 0,
    spa_no_content: 0,
    empty: 0,
    good_content: 0,
    content_no_dates: 0,
    llm_tested: 0,
    llm_found_events: 0,
    llm_failed: 0,
    ground_truth_match: 0,
    ground_truth_mismatch: 0,
  };

  var results = [];

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var url = IR_URLS[ticker];
    var prefix = '[' + (i + 1) + '/' + tickers.length + '] ' + ticker;

    if (!url) {
      console.log(prefix + ' — ' + C.dim('no IR URL configured'));
      continue;
    }

    // Step 1: Fetch
    var fetchResult;
    try {
      fetchResult = await fetchURL(url);
      stats.fetch_ok++;
    } catch (err) {
      stats.fetch_fail++;
      console.log(prefix + ' — ' + C.red('FETCH FAILED: ' + err.message));
      results.push({ ticker: ticker, url: url, status: 'fetch_failed', error: err.message });
      continue;
    }

    // Report redirects
    var redirectNote = '';
    if (fetchResult.redirected_from) {
      redirectNote = C.yellow(' (redirected)');
    }

    // Step 2: Analyze content
    var analysis = analyzeContent(fetchResult.body);

    var statusIcon;
    switch (analysis.quality) {
      case 'good':
        statusIcon = C.green('✓ GOOD');
        stats.good_content++;
        break;
      case 'content_no_dates':
        statusIcon = C.yellow('⚠ NO DATES');
        stats.content_no_dates++;
        break;
      case 'blocked_cloudflare':
        statusIcon = C.red('✗ CLOUDFLARE BLOCK');
        stats.blocked_cloudflare++;
        break;
      case 'blocked_bot':
        statusIcon = C.red('✗ BOT BLOCK');
        stats.blocked_bot++;
        break;
      case 'spa_no_content':
        statusIcon = C.red('✗ SPA (JS required)');
        stats.spa_no_content++;
        break;
      case 'empty':
        statusIcon = C.red('✗ EMPTY');
        stats.empty++;
        break;
      default:
        statusIcon = C.yellow('? ' + analysis.quality);
    }

    var httpStatus = fetchResult.status !== 200
      ? C.yellow(' HTTP ' + fetchResult.status)
      : '';

    console.log(prefix + ' — ' + statusIcon + httpStatus + redirectNote +
      C.dim(' (' + analysis.text_length + ' chars)'));

    if (analysis.date_snippets.length > 0 && !fetchOnly) {
      analysis.date_snippets.forEach(function (s) {
        console.log('         ' + C.dim('→ ' + s.substring(0, 120)));
      });
    }

    // Step 3: LLM extraction (if requested)
    if (withLLM && analysis.quality === 'good') {
      stats.llm_tested++;
      var llmResult = await testLLMExtraction(ticker, process.env.OPENROUTER_API_KEY);
      if (llmResult.success && llmResult.events.length > 0) {
        stats.llm_found_events++;
        llmResult.events.forEach(function (ev) {
          console.log('         ' + C.cyan('LLM: ' + ev.event_date + ' — ' + ev.title + ' [' + ev.event_type + ']'));
        });

        // Ground truth check
        var truthCheck = checkGroundTruth(ticker, llmResult.events);
        if (truthCheck) {
          if (truthCheck.match) {
            stats.ground_truth_match++;
            console.log('         ' + C.green('✓ GROUND TRUTH MATCH: ' + truthCheck.expected.date));
          } else {
            stats.ground_truth_mismatch++;
            console.log('         ' + C.red('✗ GROUND TRUTH MISMATCH'));
            console.log('           Expected: ' + truthCheck.expected.date + ' (' + truthCheck.expected.event + ')');
            if (truthCheck.got) {
              console.log('           Got:      ' + truthCheck.got.event_date + ' (' + truthCheck.got.title + ')');
            } else {
              console.log('           Got:      no earnings events extracted');
            }
          }
        }
      } else if (llmResult.success) {
        console.log('         ' + C.yellow('LLM: no events found in content'));
      } else {
        stats.llm_failed++;
        console.log('         ' + C.red('LLM ERROR: ' + llmResult.error));
      }
    }

    // Step 4: Database comparison (if requested and DB available)
    if (withLLM && process.env.DATABASE_URL) {
      var dbEvents = await checkDatabase(ticker);
      if (dbEvents && dbEvents.length > 0) {
        console.log('         ' + C.dim('DB:  ' + dbEvents.map(function (e) {
          return e.event_date.toString().substring(0, 10) + ' ' + e.status + ' [' + e.source + ']';
        }).join(', ')));
      }
    }

    results.push({
      ticker: ticker,
      url: url,
      http_status: fetchResult.status,
      quality: analysis.quality,
      text_length: analysis.text_length,
      has_dates: analysis.has_date_content,
      redirected: !!fetchResult.redirected_from,
    });

    // Small delay between fetches to be polite
    if (i < tickers.length - 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
    }
  }

  // Summary
  console.log('\n' + C.bold('═══════════════════════════════════════════════════════'));
  console.log(C.bold('  RESULTS SUMMARY'));
  console.log(C.bold('═══════════════════════════════════════════════════════'));
  console.log('');
  console.log('  Total IR URLs tested:    ' + stats.total);
  console.log('');
  console.log(C.bold('  Fetch results:'));
  console.log('    ' + C.green('Fetch OK:              ' + stats.fetch_ok));
  console.log('    ' + C.red('Fetch failed:          ' + stats.fetch_fail));
  console.log('');
  console.log(C.bold('  Content quality:'));
  console.log('    ' + C.green('Good (has dates):      ' + stats.good_content));
  console.log('    ' + C.yellow('Content but no dates:  ' + stats.content_no_dates));
  console.log('    ' + C.red('Cloudflare blocked:    ' + stats.blocked_cloudflare));
  console.log('    ' + C.red('Bot blocked:           ' + stats.blocked_bot));
  console.log('    ' + C.red('SPA (needs JS):        ' + stats.spa_no_content));
  console.log('    ' + C.red('Empty/thin:            ' + stats.empty));

  if (withLLM) {
    console.log('');
    console.log(C.bold('  LLM extraction:'));
    console.log('    Tested:                ' + stats.llm_tested);
    console.log('    ' + C.green('Found events:          ' + stats.llm_found_events));
    console.log('    ' + C.red('Failed:                ' + stats.llm_failed));
    if (stats.ground_truth_match + stats.ground_truth_mismatch > 0) {
      console.log('');
      console.log(C.bold('  Ground truth:'));
      console.log('    ' + C.green('Matches:               ' + stats.ground_truth_match));
      console.log('    ' + C.red('Mismatches:            ' + stats.ground_truth_mismatch));
    }
  }

  // List failures for action
  var blocked = results.filter(function (r) {
    return r.quality === 'blocked_cloudflare' || r.quality === 'blocked_bot' || r.quality === 'spa_no_content';
  });
  if (blocked.length > 0) {
    console.log('');
    console.log(C.bold('  ⚠ BLOCKED / UNREACHABLE IR PAGES (need alternative approach):'));
    blocked.forEach(function (r) {
      console.log('    ' + r.ticker + ': ' + r.quality + ' — ' + r.url);
    });
  }

  var failed = results.filter(function (r) { return r.status === 'fetch_failed'; });
  if (failed.length > 0) {
    console.log('');
    console.log(C.bold('  ✗ FETCH FAILURES:'));
    failed.forEach(function (r) {
      console.log('    ' + r.ticker + ': ' + r.error + ' — ' + r.url);
    });
  }

  var noDatePages = results.filter(function (r) { return r.quality === 'content_no_dates'; });
  if (noDatePages.length > 0) {
    console.log('');
    console.log(C.bold('  ? CONTENT BUT NO DATE KEYWORDS (may need different page URL):'));
    noDatePages.forEach(function (r) {
      console.log('    ' + r.ticker + ': ' + r.text_length + ' chars — ' + r.url);
    });
  }

  console.log('\n' + C.bold('═══════════════════════════════════════════════════════\n'));

  // Exit with failure code if significant issues found
  var failRate = (stats.blocked_cloudflare + stats.blocked_bot + stats.spa_no_content + stats.fetch_fail + stats.empty) / stats.total;
  if (failRate > 0.3) {
    console.log(C.red('FAIL: ' + (failRate * 100).toFixed(0) + '% of IR pages are unreachable. Pipeline is significantly degraded.\n'));
    process.exit(1);
  }
}

main().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
