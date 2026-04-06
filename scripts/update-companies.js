// scripts/update-companies.js
// Fetches the full list of ASX-listed companies and writes to src/data/asx-companies.csv
// Run with: node scripts/update-companies.js

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// GICS Industry Group -> Sector mapping (inlined from src/lib/gics.ts)
// ---------------------------------------------------------------------------
const GICS_MAP = {
  // Energy
  'energy equipment & services': 'Energy',
  'oil gas & consumable fuels': 'Energy',
  'energy': 'Energy',

  // Materials
  'materials': 'Materials',
  'chemicals': 'Materials',
  'construction materials': 'Materials',
  'containers & packaging': 'Materials',
  'metals & mining': 'Materials',
  'paper & forest products': 'Materials',

  // Industrials
  'capital goods': 'Industrials',
  'commercial & professional services': 'Industrials',
  'transportation': 'Industrials',

  // Consumer Discretionary
  'automobiles & components': 'Consumer Discretionary',
  'consumer durables & apparel': 'Consumer Discretionary',
  'consumer services': 'Consumer Discretionary',
  'consumer discretionary distribution & retail': 'Consumer Discretionary',
  'retailing': 'Consumer Discretionary',

  // Consumer Staples
  'food & staples retailing': 'Consumer Staples',
  'food beverage & tobacco': 'Consumer Staples',
  'household & personal products': 'Consumer Staples',
  'consumer staples distribution & retail': 'Consumer Staples',

  // Health Care
  'health care equipment & services': 'Health Care',
  'pharmaceuticals, biotechnology & life sciences': 'Health Care',

  // Financials
  'banks': 'Financials',
  'diversified financials': 'Financials',
  'insurance': 'Financials',
  'financial services': 'Financials',

  // Information Technology
  'software & services': 'Information Technology',
  'technology hardware & equipment': 'Information Technology',
  'semiconductors & semiconductor equipment': 'Information Technology',

  // Communication Services
  'media & entertainment': 'Communication Services',
  'telecommunication services': 'Communication Services',

  // Utilities
  'utilities': 'Utilities',

  // Real Estate
  'equity real estate investment trusts (reits)': 'Real Estate',
  'equity real estate investment trusts': 'Real Estate',
  'real estate management & development': 'Real Estate',
};

function mapIndustryToSector(raw) {
  if (!raw) return 'Other';
  const cleaned = raw.trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  const key = cleaned.toLowerCase();

  // 1. Exact match
  if (GICS_MAP[key]) return GICS_MAP[key];

  // 2. Try replacing "and" with "&"
  const withAmp = key.replace(/\band\b/g, '&');
  if (GICS_MAP[withAmp]) return GICS_MAP[withAmp];

  // 3. Fuzzy substring
  for (const [mapKey, sector] of Object.entries(GICS_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) return sector;
  }

  return 'Other';
}

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
          i++; // skip escaped quote
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
// HTTP fetch helper (follows redirects, handles both http and https)
// ---------------------------------------------------------------------------
function fetchURL(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;
  return new Promise(function (resolve, reject) {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));

    var mod = url.startsWith('https') ? https : http;
    var req = mod.get(url, function (res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var next = res.headers.location;
        if (!next.startsWith('http')) {
          var parsed = new URL(url);
          next = parsed.origin + next;
        }
        res.resume(); // discard body
        return resolve(fetchURL(next, maxRedirects - 1));
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
    req.setTimeout(30000, function () { req.destroy(new Error('Timeout fetching ' + url)); });
  });
}

// ---------------------------------------------------------------------------
// Filtering helpers
// ---------------------------------------------------------------------------
const ETF_FUND_KEYWORDS = [
  'etf', ' fund', 'managed fund', 'index fund',
];

function isETFOrFund(name) {
  var lower = name.toLowerCase();

  // REITs are okay - they contain "trust" but are legitimate companies
  var isREIT = lower.includes('reit') ||
    lower.includes('real estate investment trust') ||
    lower.includes('property trust') ||
    lower.includes('property group');

  // Check for ETF keywords
  for (var i = 0; i < ETF_FUND_KEYWORDS.length; i++) {
    if (lower.includes(ETF_FUND_KEYWORDS[i])) return true;
  }

  // "Trust" alone (without REIT context) likely means managed fund / investment trust
  if (lower.includes('trust') && !isREIT) {
    // But allow specific trusts that are operating companies
    // Common pattern: "XYZ Trust" that's actually a stapled security / REIT
    // If the GICS says Real Estate, we let the GICS filter handle it
    return true;
  }

  return false;
}

function cleanCompanyName(name) {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\.+$/, '');
}

function isValidGICS(group) {
  if (!group) return false;
  var lower = group.trim().toLowerCase();
  if (lower === '' || lower === 'not applic' || lower === 'not applicable') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Parse the Markit Digital CSV (primary source)
// Columns: "ASX code","Company name","GICS industry group","Listing date","Market Cap"
// ---------------------------------------------------------------------------
function parseMarkitCSV(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Find the header line (may have some preamble lines)
  var headerIdx = -1;
  for (var i = 0; i < Math.min(lines.length, 10); i++) {
    var lower = lines[i].toLowerCase();
    if (lower.includes('asx code') || lower.includes('company name') || lower.includes('"asx code"')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    // Fall back: assume first line is header
    headerIdx = 0;
  }

  var header = parseCSVLine(lines[headerIdx]);
  var colMap = {};
  for (var c = 0; c < header.length; c++) {
    var h = header[c].trim().toLowerCase().replace(/"/g, '');
    colMap[h] = c;
  }

  // Determine column indices
  var codeIdx = colMap['asx code'] !== undefined ? colMap['asx code'] : 0;
  var nameIdx = colMap['company name'] !== undefined ? colMap['company name'] : 1;
  var gicsIdx = colMap['gics industry group'] !== undefined ? colMap['gics industry group'] : 2;
  var mcapIdx = colMap['market cap'] !== undefined ? colMap['market cap'] : -1;

  var companies = [];
  for (var r = headerIdx + 1; r < lines.length; r++) {
    var line = lines[r].trim();
    if (!line) continue;

    var fields = parseCSVLine(line);
    var code = (fields[codeIdx] || '').replace(/"/g, '').trim().toUpperCase();
    var name = (fields[nameIdx] || '').replace(/"/g, '').trim();
    var gics = (fields[gicsIdx] || '').replace(/"/g, '').trim();
    var mcap = mcapIdx >= 0 ? parseFloat((fields[mcapIdx] || '').replace(/"/g, '').replace(/,/g, '').trim()) : NaN;

    if (!code || !name) continue;

    companies.push({
      code: code,
      name: cleanCompanyName(name),
      gicsIndustryGroup: gics.trim().replace(/\s+/g, ' ').replace(/\.+$/, ''),
      marketCap: isNaN(mcap) ? 0 : mcap,
    });
  }

  return companies;
}

// ---------------------------------------------------------------------------
// Parse the simpler ASX CSV (fallback source)
// Columns: "Company name","ASX code","GICS industry group"
// Has 2-line preamble (title + blank line) before header
// ---------------------------------------------------------------------------
function parseSimpleCSV(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  var headerIdx = -1;
  for (var i = 0; i < Math.min(lines.length, 10); i++) {
    var lower = lines[i].toLowerCase();
    if (lower.includes('company name') || lower.includes('"company name"')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) headerIdx = 0;

  var header = parseCSVLine(lines[headerIdx]);
  var colMap = {};
  for (var c = 0; c < header.length; c++) {
    var h = header[c].trim().toLowerCase().replace(/"/g, '');
    colMap[h] = c;
  }

  var nameIdx = colMap['company name'] !== undefined ? colMap['company name'] : 0;
  var codeIdx = colMap['asx code'] !== undefined ? colMap['asx code'] : 1;
  var gicsIdx = colMap['gics industry group'] !== undefined ? colMap['gics industry group'] : 2;

  var companies = [];
  for (var r = headerIdx + 1; r < lines.length; r++) {
    var line = lines[r].trim();
    if (!line) continue;

    var fields = parseCSVLine(line);
    var code = (fields[codeIdx] || '').replace(/"/g, '').trim().toUpperCase();
    var name = (fields[nameIdx] || '').replace(/"/g, '').trim();
    var gics = (fields[gicsIdx] || '').replace(/"/g, '').trim();

    if (!code || !name) continue;

    companies.push({
      code: code,
      name: cleanCompanyName(name),
      gicsIndustryGroup: gics.trim().replace(/\s+/g, ' ').replace(/\.+$/, ''),
      marketCap: 0, // no market cap from this source
    });
  }

  return companies;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  var PRIMARY_URL = 'https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file?access_token=83ff96335c2d45a094df02a206a39ff4';
  var FALLBACK_URL = 'https://www.asx.com.au/asx/research/ASXListedCompanies.csv';

  var outputPath = path.resolve(__dirname, '..', 'src', 'data', 'asx-companies.csv');

  console.log('Fetching ASX company directory...');

  var companies = [];
  var source = '';

  // Try primary URL first
  try {
    console.log('Trying primary API: ' + PRIMARY_URL.substring(0, 70) + '...');
    var csv = await fetchURL(PRIMARY_URL);
    companies = parseMarkitCSV(csv);
    source = 'Markit Digital API';
    console.log('Primary API returned ' + companies.length + ' entries');
  } catch (err) {
    console.log('Primary API failed: ' + err.message);
    console.log('Trying fallback URL...');
    try {
      var csv = await fetchURL(FALLBACK_URL);
      companies = parseSimpleCSV(csv);
      source = 'ASX fallback CSV';
      console.log('Fallback returned ' + companies.length + ' entries');
    } catch (err2) {
      console.error('Both sources failed!');
      console.error('Primary error: ' + err.message);
      console.error('Fallback error: ' + err2.message);
      process.exit(1);
    }
  }

  var totalFetched = companies.length;
  console.log('\nTotal companies fetched: ' + totalFetched + ' (source: ' + source + ')');

  // Filter out invalid GICS
  var beforeGICS = companies.length;
  companies = companies.filter(function (c) { return isValidGICS(c.gicsIndustryGroup); });
  var filteredGICS = beforeGICS - companies.length;
  console.log('Filtered out ' + filteredGICS + ' entries with invalid/empty GICS');

  // Filter out ETFs and managed funds
  var beforeETF = companies.length;
  companies = companies.filter(function (c) {
    // Don't filter out Real Estate entries even if they contain "Trust"
    var sector = mapIndustryToSector(c.gicsIndustryGroup);
    if (sector === 'Real Estate') return true;
    return !isETFOrFund(c.name);
  });
  var filteredETF = beforeETF - companies.length;
  console.log('Filtered out ' + filteredETF + ' ETFs/managed funds/trusts');

  // Map GICS sectors
  companies.forEach(function (c) {
    c.gicsSector = mapIndustryToSector(c.gicsIndustryGroup);
  });

  // Sort by market cap descending (if available), else alphabetically by code
  var hasMarketCap = companies.some(function (c) { return c.marketCap > 0; });

  if (hasMarketCap) {
    companies.sort(function (a, b) {
      if (b.marketCap !== a.marketCap) return b.marketCap - a.marketCap;
      return a.code.localeCompare(b.code);
    });
    console.log('Sorted by market cap descending');
  } else {
    companies.sort(function (a, b) { return a.code.localeCompare(b.code); });
    console.log('No market cap data available - sorted alphabetically by code');
  }

  // Assign ranks
  companies.forEach(function (c, i) { c.rank = i + 1; });

  // Build output CSV
  var lines = ['code,company_name,gics_sector,gics_industry_group,market_cap_rank'];
  companies.forEach(function (c) {
    var name = c.name;
    var gicsGroup = c.gicsIndustryGroup;

    // Quote fields that contain commas
    if (name.includes(',')) name = '"' + name.replace(/"/g, '""') + '"';
    if (gicsGroup.includes(',')) gicsGroup = '"' + gicsGroup.replace(/"/g, '""') + '"';

    lines.push(c.code + ',' + name + ',' + c.gicsSector + ',' + gicsGroup + ',' + c.rank);
  });

  var output = lines.join('\n') + '\n';

  // Write output
  var dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');

  console.log('\nWrote ' + companies.length + ' companies to ' + outputPath);

  // Summary stats
  var sectors = {};
  companies.forEach(function (c) {
    sectors[c.gicsSector] = (sectors[c.gicsSector] || 0) + 1;
  });
  console.log('\nSector breakdown:');
  Object.keys(sectors).sort().forEach(function (s) {
    console.log('  ' + s + ': ' + sectors[s]);
  });

  if (hasMarketCap) {
    console.log('\nTop 10 by market cap:');
    companies.slice(0, 10).forEach(function (c) {
      var mcapStr = c.marketCap >= 1e9
        ? '$' + (c.marketCap / 1e9).toFixed(1) + 'B'
        : c.marketCap >= 1e6
          ? '$' + (c.marketCap / 1e6).toFixed(0) + 'M'
          : '$' + c.marketCap.toLocaleString();
      console.log('  ' + c.rank + '. ' + c.code + ' - ' + c.name + ' (' + mcapStr + ')');
    });
  }
}

main().catch(function (err) {
  console.error('Fatal error:', err);
  process.exit(1);
});
