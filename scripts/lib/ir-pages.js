// ============================================================
// IR (Investor Relations) Page Scraper
// Fetches and extracts upcoming investor events from company
// IR webpages. Highest-priority data source (company_ir=5).
//
// Exports: getIRUrl, scrapeIRPage, scrapeIRPages
// ============================================================

const https = require('https');
const http = require('http');
const { createClient, getModel } = require('./llm-client');

const USER_AGENT = 'ASXCalendarAPI/1.0 (events calendar)';
const MAX_RETRIES = 3;
const SCRAPE_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// IR page URLs for top ASX companies
// These are the public investor-relations / results / presentations pages
// where companies list upcoming webcasts, briefings, and dial-in details.
// ---------------------------------------------------------------------------

const IR_URLS = {
  // ASX Top 10
  CBA:  'https://www.commbank.com.au/about-us/investors.html',
  BHP:  'https://www.bhp.com/investors',  // may timeout — large site, keep for retry
  WBC:  'https://www.westpac.com.au/about-westpac/investor-centre/',
  NAB:  'https://www.nab.com.au/about-us/shareholder-centre/financial-calendar',
  ANZ:  'https://www.anz.com/shareholder/centre/calendar-events/financial-calendar/',
  WES:  'https://www.wesfarmers.com.au/investor-centre/results-and-presentations',
  MQG:  'https://www.macquarie.com/au/en/investors.html',
  CSL:  'https://investors.csl.com/',
  WDS:  'https://www.woodside.com/investors',
  FMG:  'https://investors.fortescue.com/en',

  // ASX 11-20
  RIO:  'https://www.riotinto.com/invest/reports',
  TLS:  'https://www.telstra.com.au/aboutus/investors/financial-results',
  GMG:  'https://www.goodman.com/investor-centre',
  WOW:  'https://www.woolworthsgroup.com.au/au/en/investors.html',
  TCL:  'https://www.transurban.com/investor-centre',
  QBE:  'https://www.qbe.com/investor-relations',
  NST:  'https://www.nsrltd.com/investors/',
  COL:  'https://www.colesgroup.com.au/investors/',
  ALL:  'https://ir.aristocrat.com/',
  EVN:  'https://evolutionmining.com/investor-centre/',

  // ASX 21-30
  AMC:  'https://www.amcor.com/investors',
  STO:  'https://www.santos.com/investors/',
  ORG:  'https://www.originenergy.com.au/about/investors-media/',
  REA:  'https://www.rea-group.com/investor-centre/',
  S32:  'https://www.south32.net/investors',
  SUN:  'https://www.suncorpgroup.com.au/investors',
  IAG:  'https://www.iag.com.au/investor-centre',
  PLS:  'https://pls.com/investors/',
  JHX:  'https://ir.jameshardie.com/financial-information/quarterly-results/default.aspx',
  WTC:  'https://www.wisetechglobal.com/investors/welcome/',

  // ASX 31-50
  XRO:  'https://www.xero.com/au/investors/',
  QAN:  'https://investor.qantas.com/',
  PME:  'https://www.promed.com.au/investors/',
  BXB:  'https://www.brambles.com/investor-centre',
  RMD:  'https://investor.resmed.com/',
  SCG:  'https://www.scentregroup.com/investors',
  CPU:  'https://www.computershare.com/corporate/investor-relations',  // may 404
  SOL:  'https://soulpatts.com.au/investor-centre/investor-overview',
  APA:  'https://www.apa.com.au/investors-centre',
  MIN:  'https://www.mineralresources.com.au/investor-centre/',

  // ASX 51-70
  MPL:  'https://www.medibank.com.au/about/investor-centre/',
  BSL:  'https://www.bluescope.com/investors/',
  COH:  'https://www.cochlear.com/au/en/corporate/investors',
  NXT:  'https://www.nextdc.com/investor-centre',
  ALQ:  'https://www.alsglobal.com/en/investor-relations',
  ASX:  'https://www.asx.com.au/about/asx-shareholders',
  SHL:  'https://investors.sonichealthcare.com/',
  ORI:  'https://www.orica.com/investors',
  TNE:  'https://www.technology1.com/company/investors/financial-calendar',
  RHC:  'https://www.ramsayhealth.com/en/investors/',
  CAR:  'https://www.cargroup.com.au/investor-centre',
  JBH:  'https://investors.jbhifi.com.au/',
  ALD:  'https://www.ampol.com.au/about-ampol/investors',
  TPG:  'https://www.tpgtelecom.com.au/investor-relations',
  WHC:  'https://whitehavencoal.com.au/investors/',
  QUB:  'https://qube.com.au/investor/',
  GPT:  'https://www.gpt.com.au/investor-centre',
  REH:  'https://group.reece.com/investors',
  SGP:  'https://www.stockland.com.au/investor-centre',
  CHC:  'https://www.charterhall.com.au/investor-centre',

  // ASX 71-100
  HUB:  'https://www.hub24.com.au/investors',
  APE:  'https://www.eagersautomotive.com.au/corporate-information/',
  MGR:  'https://www.mirvac.com/investor-centre',
  A2M:  'https://thea2milkcompany.com/investor-centre',
  AZJ:  'https://www.aurizon.com.au/investors',
  AGL:  'https://www.agl.com.au/about-agl/investors',
  DXS:  'https://www.dexus.com/investing.html',
  IGO:  'https://www.igo.com.au/site/investor-center',
  HVN:  'https://www.harveynormanholdings.com.au/pages/reports-announcements',
  BEN:  'https://www.bendigoadelaide.com.au/investor-centre/',
  EDV:  'https://www.endeavourgroup.com.au/investor-relations',
  CGF:  'https://www.challenger.com.au/about-us/shareholder-centre',
  WOR:  'https://www.worley.com/en/investor-relations/',
  NWL:  'https://www.netwealth.com.au/web/about-netwealth/shareholders/',
  VCX:  'https://www.vicinity.com.au/investors',
  SFR:  'https://www.sandfire.com.au/investors/',
  LOV:  'https://www.lovisa.com/pages/investor-centre',
  DMP:  'https://investors.dominos.com.au/',
};

// ---------------------------------------------------------------------------
// HTTP fetch helper (follows redirects, handles both http and https)
// ---------------------------------------------------------------------------

function fetchURL(url, options) {
  var maxRedirects = (options && options.maxRedirects !== undefined) ? options.maxRedirects : 5;
  var timeoutMs = (options && options.timeout) || 30000;

  return new Promise(function (resolve, reject) {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    var mod = url.startsWith('https') ? https : http;
    var parsed = new URL(url);

    var reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html, application/xhtml+xml, */*',
      },
    };

    var req = mod.request(reqOptions, function (res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = res.headers.location;
        if (!next.startsWith('http')) {
          next = parsed.origin + next;
        }
        res.resume();
        return resolve(fetchURL(next, { maxRedirects: maxRedirects - 1, timeout: timeoutMs }));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }

      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, function () { req.destroy(new Error('Timeout fetching ' + url)); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Delay helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// Strip HTML tags and collapse whitespace
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// LLM API call with retry and exponential backoff
// ---------------------------------------------------------------------------

// Track daily token limit for IR page scraping
var _irDailyLimitReached = false;

function isIRDailyLimitReached() {
  return _irDailyLimitReached;
}

async function callLLM(client, messages, attempt) {
  if (attempt === undefined) attempt = 1;

  // Fail fast if daily limit already hit
  if (_irDailyLimitReached) {
    throw new Error('LLM daily token limit reached — skipping');
  }

  try {
    var completion = await client.chat.completions.create({
      model: getModel(),
      temperature: 0,
      messages: messages,
    });

    var content = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : null;

    return content || '';
  } catch (err) {
    var status = err.status || 0;
    var msg = err.message || String(err);
    var isRateLimit = status === 429 || msg.includes('429');

    // Non-retryable errors — fail immediately, don't waste time
    if (status === 404 || status === 401 || status === 403) {
      console.log('  [ir-pages] Non-retryable error (' + status + ') — check model name and API key');
      throw err;
    }

    // Daily limit (OpenRouter free-models-per-day) — don't retry
    if (isRateLimit && (msg.includes('tokens per day') || msg.includes('TPD') || msg.includes('free-models-per-day'))) {
      _irDailyLimitReached = true;
      console.log('  [ir-pages] DAILY LIMIT reached — aborting remaining IR scraping');
      throw err;
    }

    if (attempt < MAX_RETRIES) {
      var backoffMs = isRateLimit
        ? Math.min(2000 * Math.pow(2, attempt), 30000)
        : 1000 * attempt;

      console.log('  [ir-pages] Retry ' + attempt + '/' + MAX_RETRIES + ' after ' + backoffMs + 'ms — ' + (msg.substring(0, 200)));
      await delay(backoffMs);
      return callLLM(client, messages, attempt + 1);
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSON parsing helper — tolerates markdown fences and preamble text
// ---------------------------------------------------------------------------

function parseJsonFromLLM(raw) {
  var cleaned = raw.trim();

  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try parsing as-is first
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Fall through
  }

  // Find the outermost [ ... ] or { ... }
  var arrayStart = cleaned.indexOf('[');
  var objStart = cleaned.indexOf('{');

  if (arrayStart !== -1) {
    var end = cleaned.lastIndexOf(']');
    if (end > arrayStart) {
      try {
        return JSON.parse(cleaned.slice(arrayStart, end + 1));
      } catch (_) {
        // Fall through
      }
    }
  }

  if (objStart !== -1) {
    var end2 = cleaned.lastIndexOf('}');
    if (end2 > objStart) {
      try {
        return JSON.parse(cleaned.slice(objStart, end2 + 1));
      } catch (_) {
        // Fall through
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// IR extraction system prompt
// ---------------------------------------------------------------------------

function buildIRSystemPrompt(today) {
  return 'You are extracting upcoming investor event DATES from an Australian company\'s Investor Relations webpage.\n\n' +
    'Australian companies typically publish a "Financial Calendar" or "Key Dates" section on their IR page early in the year.\n' +
    'This calendar provides SCHEDULED DATES for major events but usually does NOT include webcast or dial-in details yet.\n' +
    'Those details come later via ASX announcements closer to the event date.\n\n' +
    'Look for:\n' +
    '- Half year results / interim results dates\n' +
    '- Full year results / annual results dates\n' +
    '- Annual General Meeting (AGM) dates\n' +
    '- Investor days or strategy days (if listed)\n' +
    '- Capital markets days\n' +
    '- Quarterly updates or production reports (if they mention a briefing/call)\n\n' +
    'For each event found, return a JSON object with:\n' +
    '- event_type: "earnings" | "investor_day" | "conference" | "ad_hoc"\n' +
    '  (Use "earnings" for half year and full year results briefings)\n' +
    '- event_date: "YYYY-MM-DD" (the date of the event/briefing, NOT the reporting period end date)\n' +
    '- event_time: "HH:MM" (24h AEST) or null (usually null on IR calendars)\n' +
    '- title: descriptive title (e.g. "FY2026 Full Year Results")\n' +
    '- webcast_url: null (IR calendars rarely have this — it comes from ASX announcements later)\n' +
    '- phone_number: null\n' +
    '- phone_passcode: null\n' +
    '- fiscal_period: "HY2026" or "FY2026" or null\n' +
    '- description: brief description or null\n\n' +
    'IMPORTANT:\n' +
    '- The event_date is the date of the BRIEFING/PRESENTATION, not the end of the reporting period.\n' +
    '  For example, "Half year results to 30 Sep 2026, announced 12 Nov 2026" → event_date = "2026-11-12"\n' +
    '- If the page only shows a month (e.g. "August 2026"), use the 15th of that month as the date\n' +
    '  and set confidence to "low"\n' +
    '- Include AGM dates only if the page indicates there will be a webcast or virtual attendance option\n' +
    '- If webcast URLs or dial-in details ARE present (rare), include them\n\n' +
    'Return a JSON array of event objects. If no upcoming events found, return [].\n' +
    'Only include FUTURE events (after today\'s date which is ' + today + ').\n' +
    'Return ONLY JSON, no markdown or explanation.';
}

// ---------------------------------------------------------------------------
// getIRUrl — Return the IR page URL for a given ASX ticker, or null
// ---------------------------------------------------------------------------

function getIRUrl(ticker) {
  if (!ticker) return null;
  var key = ticker.toUpperCase().trim();
  return IR_URLS[key] || null;
}

// ---------------------------------------------------------------------------
// scrapeIRPage — Scrape a single company's IR page and extract events
// ---------------------------------------------------------------------------

async function scrapeIRPage(ticker, llmApiKey) {
  var normalTicker = ticker.toUpperCase().trim();
  var url = getIRUrl(normalTicker);

  if (!url) {
    return [];
  }

  console.log('  [ir-pages] Scraping IR page for ' + normalTicker + ': ' + url);

  // Step 1: Fetch the IR page HTML
  var html;
  try {
    html = await fetchURL(url, { timeout: 30000 });
  } catch (err) {
    console.log('  [ir-pages] Failed to fetch IR page for ' + normalTicker + ': ' + err.message);
    return [];
  }

  // Step 2: Strip HTML to text and truncate
  var text = stripHtml(html);
  if (!text || text.length < 50) {
    console.log('  [ir-pages] IR page for ' + normalTicker + ' had no useful text');
    return [];
  }
  text = text.substring(0, 8000);

  // Step 3: Send to LLM for extraction
  var today = new Date().toISOString().substring(0, 10);
  var client = createClient(llmApiKey);

  var userPrompt = 'Company: ' + normalTicker + ' (ASX-listed)\n' +
    'IR Page URL: ' + url + '\n\n' +
    '--- IR Page Content ---\n' +
    text + '\n' +
    '--- End of Content ---';

  var raw;
  try {
    raw = await callLLM(client, [
      { role: 'system', content: buildIRSystemPrompt(today) },
      { role: 'user', content: userPrompt },
    ]);
  } catch (err) {
    console.log('  [ir-pages] LLM extraction failed for ' + normalTicker + ': ' + err.message);
    return [];
  }

  // Step 4: Parse and validate the response
  var parsed = parseJsonFromLLM(raw);

  if (!Array.isArray(parsed)) {
    // If we got a single object, wrap in array
    if (parsed && typeof parsed === 'object' && parsed.event_date) {
      parsed = [parsed];
    } else {
      console.log('  [ir-pages] Could not parse LLM response for ' + normalTicker);
      return [];
    }
  }

  // Validate and normalise each event
  var validTypes = ['earnings', 'investor_day', 'conference', 'ad_hoc'];
  var events = [];

  for (var i = 0; i < parsed.length; i++) {
    var ev = parsed[i];
    if (!ev || typeof ev !== 'object') continue;

    // Validate event_date
    if (!ev.event_date || !/^\d{4}-\d{2}-\d{2}$/.test(ev.event_date)) {
      console.log('  [ir-pages] Skipping event with invalid date: ' + ev.event_date);
      continue;
    }

    // Ensure the event is in the future
    if (ev.event_date <= today) {
      continue;
    }

    // Validate event_type
    var eventType = ev.event_type;
    if (!validTypes.includes(eventType)) {
      eventType = 'ad_hoc';
    }

    // Validate event_time format
    var eventTime = ev.event_time || null;
    if (eventTime && !/^\d{2}:\d{2}$/.test(eventTime)) {
      eventTime = null;
    }

    events.push({
      ticker: normalTicker,
      event_type: eventType,
      event_date: ev.event_date,
      event_time: eventTime,
      title: ev.title || (normalTicker + ' Investor Event'),
      webcast_url: ev.webcast_url || null,
      phone_number: ev.phone_number || null,
      phone_passcode: ev.phone_passcode || null,
      fiscal_period: ev.fiscal_period || null,
      description: ev.description || null,
      source: 'company_ir',
      source_url: url,
      ir_verified: true,
    });
  }

  if (events.length > 0) {
    console.log('  [ir-pages] Found ' + events.length + ' upcoming event(s) for ' + normalTicker);
  } else {
    console.log('  [ir-pages] No upcoming events found for ' + normalTicker);
  }

  return events;
}

// ---------------------------------------------------------------------------
// scrapeIRPages — Batch process multiple tickers with polite delays
// ---------------------------------------------------------------------------

async function scrapeIRPages(tickers, llmApiKey) {
  if (!tickers || tickers.length === 0) return [];

  var allEvents = [];
  var scraped = 0;
  var skipped = 0;

  console.log('[ir-pages] Scraping IR pages for ' + tickers.length + ' ticker(s)');

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];

    // Skip tickers without IR URLs
    if (!getIRUrl(ticker)) {
      skipped++;
      continue;
    }

    var events = await scrapeIRPage(ticker, llmApiKey);
    for (var j = 0; j < events.length; j++) {
      allEvents.push(events[j]);
    }
    scraped++;

    // Polite delay between requests
    if (i < tickers.length - 1) {
      await delay(SCRAPE_DELAY_MS);
    }
  }

  console.log('[ir-pages] Scraping complete: ' + scraped + ' scraped, ' + skipped + ' skipped (no IR URL), ' + allEvents.length + ' total events found');
  return allEvents;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getIRUrl: getIRUrl,
  scrapeIRPage: scrapeIRPage,
  scrapeIRPages: scrapeIRPages,
  isIRDailyLimitReached: isIRDailyLimitReached,
  IR_URLS: IR_URLS,
};
