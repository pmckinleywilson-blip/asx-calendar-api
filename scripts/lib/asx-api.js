// ============================================================
// ASX Announcements API Client
// Fetches company announcements and their content from the ASX.
// ============================================================

const https = require('https');
const http = require('http');

const USER_AGENT = 'ASXCalendarAPI/1.0 (events calendar)';
const REQUEST_DELAY_MS = 300;
const CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// HTTP fetch helper (follows redirects, handles both http and https)
// ---------------------------------------------------------------------------

function fetchURL(url, options) {
  const maxRedirects = (options && options.maxRedirects !== undefined) ? options.maxRedirects : 5;
  const timeoutMs = (options && options.timeout) || 30000;

  return new Promise(function (resolve, reject) {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/html, */*',
      },
    };

    const req = mod.request(reqOptions, function (res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next = res.headers.location;
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

      const chunks = [];
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
// fetchAnnouncements — Fetch recent announcements for a single company
// ---------------------------------------------------------------------------

async function fetchAnnouncements(ticker, days) {
  if (days === undefined) days = 30;

  const announcements = [];
  const seen = new Set();

  // Use the Markit Digital API (the current working ASX data endpoint)
  // Fetch 50 items so we see past high-volume noise (substantial-holder notices, etc.)
  // No market_sensitive filter — we want ALL announcements including price-sensitive results
  const apiUrl = 'https://asx.api.markitdigital.com/asx-research/1.0/companies/' + ticker +
    '/announcements?count=50';

  try {
    const raw = await fetchURL(apiUrl);
    const data = JSON.parse(raw);
    const items = (data.data && data.data.items) || [];

    if (!Array.isArray(items)) {
      console.log('  [asx-api] No items array for ' + ticker);
      return announcements;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      const docKey = item.documentKey || (ticker + '_' + j);

      if (seen.has(docKey)) continue;
      seen.add(docKey);

      const dateStr = item.date || '';
      const itemDate = new Date(dateStr);
      if (itemDate < cutoff) continue;

      // Build the announcement PDF URL from documentKey
      // documentKey format: "2924-03075061-3A690687" → idsId is the middle segment "03075061"
      var idsId = '';
      var parts = docKey.split('-');
      if (parts.length >= 2) idsId = parts[1];

      var pdfUrl = item.url ||
        ('https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=' + idsId);

      announcements.push({
        id: String(docKey),
        title: item.headline || item.header || 'Untitled',
        date: dateStr.substring(0, 10),
        url: pdfUrl,
        market_sensitive: !!item.isPriceSensitive,
        announcement_type: item.announcementType || '',
      });
    }
  } catch (err) {
    console.log('  [asx-api] Warning: failed to fetch announcements for ' + ticker + ' — ' + err.message);
  }

  return announcements;
}

// ---------------------------------------------------------------------------
// fetchAnnouncementContent — Fetch and extract text from an announcement page
// ---------------------------------------------------------------------------

async function fetchAnnouncementContent(url) {
  try {
    const raw = await fetchURL(url, { timeout: 20000 });
    const text = stripHtml(raw);
    // Limit to first 6000 characters to stay within LLM context budget
    return text.substring(0, 6000) || null;
  } catch (err) {
    console.log('  [asx-api] Warning: failed to fetch content from ' + url + ' — ' + err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// fetchAnnouncementsForTier — Fetch announcements for a tier of companies
// ---------------------------------------------------------------------------

async function fetchAnnouncementsForTier(companies, tier, timeBudgetMs) {
  // Determine rank range for each tier
  const tierRanges = {
    'asx100':    { min: 1, max: 100 },
    'asx101-300': { min: 101, max: 300 },
    'asx301-500': { min: 301, max: 500 },
  };

  const range = tierRanges[tier];
  if (!range) {
    console.log('[asx-api] Unknown tier: ' + tier);
    return [];
  }

  const filtered = companies.filter(function (c) {
    return c.market_cap_rank >= range.min && c.market_cap_rank <= range.max;
  });

  console.log('[asx-api] Fetching announcements for ' + filtered.length + ' companies in tier ' + tier + ' (ranks ' + range.min + '-' + range.max + ')');

  const allAnnouncements = [];
  const tierStart = Date.now();

  // Process companies in concurrent batches of CONCURRENCY
  for (let i = 0; i < filtered.length; i += CONCURRENCY) {
    // Check time budget if provided
    if (timeBudgetMs && (Date.now() - tierStart) > timeBudgetMs) {
      console.log('[asx-api] Time budget reached for tier ' + tier + ' after ' + i + '/' + filtered.length + ' companies');
      break;
    }

    const batch = filtered.slice(i, i + CONCURRENCY);
    const batchEnd = Math.min(i + CONCURRENCY, filtered.length);
    console.log('  [' + (i + 1) + '-' + batchEnd + '/' + filtered.length + '] ' + batch.map(function (c) { return c.code; }).join(', '));

    // Fetch all companies in the batch concurrently
    const results = await Promise.allSettled(
      batch.map(function (company) {
        return fetchAnnouncements(company.code).then(function (anns) {
          for (var j = 0; j < anns.length; j++) {
            anns[j].ticker = company.code;
            anns[j].company_name = company.company_name;
          }
          return anns;
        });
      })
    );

    for (var r = 0; r < results.length; r++) {
      if (results[r].status === 'fulfilled' && results[r].value) {
        allAnnouncements.push.apply(allAnnouncements, results[r].value);
      }
    }

    // Brief delay between batches (not between individual companies)
    if (i + CONCURRENCY < filtered.length) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  console.log('[asx-api] Total announcements fetched for tier ' + tier + ': ' + allAnnouncements.length);
  return allAnnouncements;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fetchAnnouncements: fetchAnnouncements,
  fetchAnnouncementContent: fetchAnnouncementContent,
  fetchAnnouncementsForTier: fetchAnnouncementsForTier,
};
