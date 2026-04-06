// ============================================================
// ASX Announcements API Client
// Fetches company announcements and their content from the ASX.
// ============================================================

const https = require('https');
const http = require('http');

const USER_AGENT = 'ASXCalendarAPI/1.0 (events calendar)';
const REQUEST_DELAY_MS = 500;

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

  // Try market-sensitive announcements first, then all announcements
  const urls = [
    'https://www.asx.com.au/asx/1/company/' + ticker + '/announcements?count=20&market_sensitive=true',
    'https://www.asx.com.au/asx/1/company/' + ticker + '/announcements?count=20',
  ];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const raw = await fetchURL(url);
      const data = JSON.parse(raw);
      const items = data.data || data || [];

      if (!Array.isArray(items)) continue;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);

      for (let j = 0; j < items.length; j++) {
        const item = items[j];
        const id = item.id || item.document_id || (ticker + '_' + j);

        if (seen.has(id)) continue;
        seen.add(id);

        const dateStr = item.document_date || item.date || '';
        const itemDate = new Date(dateStr);
        if (itemDate < cutoff) continue;

        announcements.push({
          id: String(id),
          title: item.header || item.title || 'Untitled',
          date: dateStr.substring(0, 10),
          url: item.url || ('https://www.asx.com.au/asx/statistics/displayAnnouncement.do?display=pdf&idsId=' + id),
          market_sensitive: !!item.market_sensitive,
        });
      }
    } catch (err) {
      console.log('  [asx-api] Warning: failed to fetch ' + url + ' — ' + err.message);
    }

    // Respect rate limits between requests
    if (i < urls.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
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

async function fetchAnnouncementsForTier(companies, tier) {
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

  for (let i = 0; i < filtered.length; i++) {
    const company = filtered[i];
    console.log('  [' + (i + 1) + '/' + filtered.length + '] ' + company.code + ' — ' + company.company_name);

    const anns = await fetchAnnouncements(company.code);

    for (let j = 0; j < anns.length; j++) {
      anns[j].ticker = company.code;
      anns[j].company_name = company.company_name;
    }

    allAnnouncements.push.apply(allAnnouncements, anns);

    // Delay between companies
    if (i < filtered.length - 1) {
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
