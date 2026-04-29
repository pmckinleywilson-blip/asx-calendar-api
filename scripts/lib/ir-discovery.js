// ============================================================
// IR URL Discovery
//
// When a hardcoded IR URL goes stale (404 or returns 0 events repeatedly),
// try to find a fresh one automatically:
//
//   1. Markit Digital /companies/{TICKER}/about → canonical websiteUrl
//   2. Fetch the company homepage
//   3. Heuristic search for IR-ish links (regex on href/text)
//   4. Return the most likely IR URL, or null if nothing plausible
//
// No LLM is used — discovery has to be cheap because the pipeline runs
// every ~4 hours. If heuristics fail, we keep the existing (broken) URL
// and the next session can update it manually or extend this module.
//
// Exports: discoverIRUrl, fetchCanonicalWebsite, findIRLinkInHTML
// ============================================================

const https = require('https');
const http = require('http');

// Use a realistic User-Agent — some company sites (CSL, TNE) block obvious bots.
const USER_AGENT = 'Mozilla/5.0 (compatible; ASXCalendarBot/1.0; +https://asx-calendar-api.vercel.app)';
const FETCH_TIMEOUT_MS = 15000;

const MARKIT_BASE = 'https://asx.api.markitdigital.com/asx-research/1.0';

// ---------------------------------------------------------------------------
// HTTP fetch with redirect following and body capture
// ---------------------------------------------------------------------------

function fetchURL(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;

  return new Promise(function (resolve, reject) {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    const mod = url.startsWith('https') ? https : http;
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html, application/json, */*',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
    }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next = res.headers.location;
        if (!next.startsWith('http')) next = parsed.origin + next;
        res.resume();
        return resolve(fetchURL(next, maxRedirects - 1));
      }

      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          finalUrl: url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, function () {
      req.destroy(new Error('Timeout fetching ' + url));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// fetchCanonicalWebsite — Look up a company's canonical website URL via the
// Markit Digital ASX research API. Returns the websiteUrl (normalised to https
// when possible) or null if not found.
// ---------------------------------------------------------------------------

async function fetchCanonicalWebsite(ticker) {
  if (!ticker) return null;
  const t = String(ticker).toUpperCase().trim();
  const url = MARKIT_BASE + '/companies/' + encodeURIComponent(t) + '/about';

  try {
    const r = await fetchURL(url);
    if (r.status !== 200) return null;
    const json = JSON.parse(r.body);
    const data = json && json.data;
    if (!data || !data.websiteUrl) return null;

    let site = String(data.websiteUrl).trim();
    // Normalise: Markit often returns http:// — try https:// first as a courtesy.
    if (site.startsWith('http://')) site = 'https://' + site.substring(7);
    return site;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// findIRLinkInHTML — Scan an HTML string for anchors that plausibly link to
// the company's investor relations / financial calendar page.
//
// Returns an array of { href, text, score } sorted by score descending.
// Higher score = more likely to be the IR landing page.
// ---------------------------------------------------------------------------

const IR_PATH_RE = /\/(investor[s]?(?:[-_]centre|[-_]center|[-_]relations)?|shareholder[s]?(?:[-_]centre|[-_]center)?|ir(?:[/?#]|$)|investing|investments?|results[-_]and[-_]presentations|financial[-_]calendar|financial[-_]information|key[-_]dates)/i;
const IR_TEXT_RE = /(investor centre|investor center|investor relations|shareholder|financial calendar|key dates|results.{0,15}presentations|annual report)/i;
const NEGATIVE_TEXT_RE = /(invest with|invest in|investment opportunit|investing in|customer[s]?|loan|deposit|rate[s]?|insurance|product[s]?|news|career|contact us|sitemap)/i;
const NEGATIVE_PATH_RE = /\/(products?|services?|news|careers?|contact|legal|privacy|terms|cookie|sitemap|search|login|signin|register|cart|customer)/i;

function scoreLink(href, text) {
  let score = 0;
  if (IR_PATH_RE.test(href)) score += 5;
  if (IR_TEXT_RE.test(text)) score += 3;
  if (NEGATIVE_TEXT_RE.test(text)) score -= 4;
  if (NEGATIVE_PATH_RE.test(href)) score -= 3;
  // Prefer shorter, cleaner paths (less query-string noise)
  if (href.indexOf('?') === -1) score += 1;
  if (href.indexOf('#') === -1) score += 1;
  // Strong preference for paths ending in /investors or /investor-centre
  if (/\/investor(s|[-_]centre|[-_]center|[-_]relations)\/?$/i.test(href.split('?')[0].split('#')[0])) score += 3;
  return score;
}

function findIRLinkInHTML(html, baseOrigin) {
  if (!html) return [];

  const re = /<a\s+[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  const seen = new Set();
  const candidates = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    let href = m[2].trim();
    // Strip any HTML inside the anchor text
    const text = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Skip non-http(s) (mailto:, javascript:, tel:, #anchors)
    if (href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('tel:') || href.startsWith('#')) continue;

    // Resolve relative URLs against baseOrigin
    let absolute = href;
    if (!href.match(/^https?:\/\//i)) {
      if (href.startsWith('//')) absolute = 'https:' + href;
      else if (href.startsWith('/')) absolute = baseOrigin + href;
      else absolute = baseOrigin + '/' + href;
    }

    // Only keep links on the same registrable domain as baseOrigin (avoid third-party links)
    let baseHost, candHost;
    try {
      baseHost = new URL(baseOrigin).hostname.toLowerCase();
      candHost = new URL(absolute).hostname.toLowerCase();
    } catch (_) { continue; }
    // Match if either is a suffix of the other (allows subdomains like ir.example.com vs www.example.com)
    const baseRoot = baseHost.replace(/^www\./, '');
    const candRoot = candHost.replace(/^www\./, '');
    if (!candRoot.endsWith(baseRoot) && !baseRoot.endsWith(candRoot)) continue;

    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const score = scoreLink(absolute, text);
    if (score < 4) continue; // require at least path OR text match

    candidates.push({ href: absolute, text: text.substring(0, 100), score: score });
  }

  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates;
}

// ---------------------------------------------------------------------------
// discoverIRUrl — Top-level: given a ticker, find a plausible IR page URL.
//
// Returns { url, websiteUrl, candidates, method } on success, or null.
// method: 'markit_about' (canonical website found, IR link extracted from it).
// ---------------------------------------------------------------------------

async function discoverIRUrl(ticker, options) {
  const opts = options || {};
  const log = opts.log || function () {};

  const t = String(ticker || '').toUpperCase().trim();
  if (!t) return null;

  // Step 1: get canonical website via Markit
  const websiteUrl = await fetchCanonicalWebsite(t);
  if (!websiteUrl) {
    log('  [ir-discover] ' + t + ': Markit /about returned no websiteUrl');
    return null;
  }
  log('  [ir-discover] ' + t + ': canonical website = ' + websiteUrl);

  // Step 2: fetch homepage
  let homepage;
  try {
    homepage = await fetchURL(websiteUrl);
  } catch (err) {
    log('  [ir-discover] ' + t + ': could not fetch homepage (' + err.message + ')');
    return null;
  }
  if (homepage.status !== 200 || !homepage.body) {
    log('  [ir-discover] ' + t + ': homepage returned HTTP ' + homepage.status);
    return null;
  }

  // Step 3: heuristic IR link search
  const baseOrigin = new URL(websiteUrl).origin;
  const candidates = findIRLinkInHTML(homepage.body, baseOrigin);

  if (candidates.length === 0) {
    log('  [ir-discover] ' + t + ': no IR-ish links found on homepage');
    return null;
  }

  const best = candidates[0];
  log('  [ir-discover] ' + t + ': found ' + candidates.length + ' candidate(s), best = ' + best.href + ' (score ' + best.score + ')');

  return {
    url: best.href,
    websiteUrl: websiteUrl,
    candidates: candidates,
    method: 'markit_about',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  discoverIRUrl: discoverIRUrl,
  fetchCanonicalWebsite: fetchCanonicalWebsite,
  findIRLinkInHTML: findIRLinkInHTML,
};
