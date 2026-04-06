'use client';

import { useState, useEffect, useCallback } from 'react';

// ---- Types (mirrored from lib/types.ts for client) ----

interface CalendarEvent {
  id: string;
  companyCode: string;
  companyName: string;
  eventType: string;
  title: string;
  date: string;
  time?: string;
  description?: string;
  source?: string;
  confirmed: boolean;
}

interface Company {
  code: string;
  name: string;
  sector: string;
  industryGroup: string;
  marketCapRank: number;
  indices: string[];
}

interface FiltersData {
  indices: string[];
  sectors: string[];
  industries: string[];
  eventTypes: string[];
  dateRange: { earliest: string; latest: string } | null;
}

// ---- Helpers ----

const INDEX_LABELS: Record<string, string> = {
  asx20: 'ASX 20',
  asx50: 'ASX 50',
  asx100: 'ASX 100',
  asx200: 'ASX 200',
  asx300: 'ASX 300',
  'all-ords': 'All Ords',
  'small-ords': 'Small Ords',
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  earnings: 'Earnings',
  agm: 'AGM',
  egm: 'EGM',
  'ex-dividend': 'Ex-Dividend',
  'dividend-payment': 'Dividend Payment',
  ipo: 'IPO',
  'trading-halt': 'Trading Halt',
  'capital-raise': 'Capital Raise',
  other: 'Other',
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  earnings: 'bg-blue-100 text-blue-800',
  agm: 'bg-purple-100 text-purple-800',
  egm: 'bg-violet-100 text-violet-800',
  'ex-dividend': 'bg-amber-100 text-amber-800',
  'dividend-payment': 'bg-green-100 text-green-800',
  ipo: 'bg-pink-100 text-pink-800',
  'trading-halt': 'bg-red-100 text-red-800',
  'capital-raise': 'bg-cyan-100 text-cyan-800',
  other: 'bg-gray-100 text-gray-800',
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// ---- Main Component ----

export default function Home() {
  const [filters, setFilters] = useState<FiltersData | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [selectedIndex, setSelectedIndex] = useState('');
  const [selectedSector, setSelectedSector] = useState('');
  const [selectedIndustry, setSelectedIndustry] = useState('');
  const [selectedType, setSelectedType] = useState('');
  const [searchCode, setSearchCode] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Tab: 'events' | 'companies'
  const [tab, setTab] = useState<'events' | 'companies'>('events');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companiesTotal, setCompaniesTotal] = useState(0);

  // Load filter options
  useEffect(() => {
    fetch('/api/filters')
      .then((r) => r.json())
      .then(setFilters)
      .catch(console.error);
  }, []);

  // Fetch events
  const fetchEvents = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedIndex) params.set('index', selectedIndex);
    if (selectedSector) params.set('sector', selectedSector);
    if (selectedIndustry) params.set('industry', selectedIndustry);
    if (selectedType) params.set('type', selectedType);
    if (searchCode) params.set('code', searchCode.toUpperCase());
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    params.set('limit', '200');

    fetch(`/api/events?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setEvents(data.data ?? []);
        setTotal(data.meta?.total ?? 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [selectedIndex, selectedSector, selectedIndustry, selectedType, searchCode, fromDate, toDate]);

  // Fetch companies
  const fetchCompanies = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (selectedIndex) params.set('index', selectedIndex);
    if (selectedSector) params.set('sector', selectedSector);
    if (selectedIndustry) params.set('industry', selectedIndustry);
    if (searchCode) params.set('search', searchCode);
    params.set('limit', '200');

    fetch(`/api/companies?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setCompanies(data.data ?? []);
        setCompaniesTotal(data.meta?.total ?? 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [selectedIndex, selectedSector, selectedIndustry, searchCode]);

  useEffect(() => {
    if (tab === 'events') fetchEvents();
    else fetchCompanies();
  }, [tab, fetchEvents, fetchCompanies]);

  const clearFilters = () => {
    setSelectedIndex('');
    setSelectedSector('');
    setSelectedIndustry('');
    setSelectedType('');
    setSearchCode('');
    setFromDate('');
    setToDate('');
  };

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <h1 className="text-3xl font-bold text-gray-900">
            ASX Calendar API
          </h1>
          <p className="mt-1 text-gray-500">
            Corporate events calendar for all ASX-listed companies.
            Earnings, AGMs, dividends &amp; more.
          </p>
          <div className="mt-3 flex gap-3 text-sm">
            <a
              href="/openapi.json"
              className="text-blue-600 hover:underline"
              target="_blank"
            >
              OpenAPI Spec
            </a>
            <span className="text-gray-300">|</span>
            <a
              href="/.well-known/ai-plugin.json"
              className="text-blue-600 hover:underline"
              target="_blank"
            >
              AI Plugin Manifest
            </a>
            <span className="text-gray-300">|</span>
            <a
              href="/api/health"
              className="text-blue-600 hover:underline"
              target="_blank"
            >
              Health Check
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-6">
          <button
            onClick={() => setTab('events')}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              tab === 'events'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            Events Calendar
          </button>
          <button
            onClick={() => setTab('companies')}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors ${
              tab === 'companies'
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-100'
            }`}
          >
            Companies
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-700 text-sm uppercase tracking-wide">
              Filters
            </h2>
            <button
              onClick={clearFilters}
              className="text-xs text-blue-600 hover:underline"
            >
              Clear all
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            {/* Index */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Index
              </label>
              <select
                value={selectedIndex}
                onChange={(e) => setSelectedIndex(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
              >
                <option value="">All</option>
                {filters?.indices.map((idx) => (
                  <option key={idx} value={idx}>
                    {INDEX_LABELS[idx] ?? idx}
                  </option>
                ))}
              </select>
            </div>

            {/* Sector */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Sector
              </label>
              <select
                value={selectedSector}
                onChange={(e) => setSelectedSector(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
              >
                <option value="">All</option>
                {filters?.sectors.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            {/* Industry */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Industry
              </label>
              <select
                value={selectedIndustry}
                onChange={(e) => setSelectedIndustry(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
              >
                <option value="">All</option>
                {filters?.industries.map((ind) => (
                  <option key={ind} value={ind}>
                    {ind}
                  </option>
                ))}
              </select>
            </div>

            {/* Event Type (events tab only) */}
            {tab === 'events' && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Event Type
                </label>
                <select
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
                >
                  <option value="">All</option>
                  {filters?.eventTypes.map((t) => (
                    <option key={t} value={t}>
                      {EVENT_TYPE_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Company Code / Search */}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                {tab === 'events' ? 'Code(s)' : 'Search'}
              </label>
              <input
                type="text"
                value={searchCode}
                onChange={(e) => setSearchCode(e.target.value)}
                placeholder={tab === 'events' ? 'BHP,CBA' : 'Name or code'}
                className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm"
              />
            </div>

            {/* Date range (events tab only) */}
            {tab === 'events' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    From
                  </label>
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    To
                  </label>
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm"
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Results count */}
        <div className="mb-4 text-sm text-gray-500">
          {loading ? (
            'Loading...'
          ) : tab === 'events' ? (
            <>
              Showing {events.length} of {total} events
            </>
          ) : (
            <>
              Showing {companies.length} of {companiesTotal} companies
            </>
          )}
        </div>

        {/* Events Table */}
        {tab === 'events' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Date
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Code
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Company
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Type
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Title
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {events.map((event) => (
                    <tr key={event.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 whitespace-nowrap text-gray-900 font-medium">
                        {formatDate(event.date)}
                        {event.time && (
                          <span className="text-gray-400 ml-1 text-xs">
                            {event.time}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-blue-700">
                        {event.companyCode}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {event.companyName}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            EVENT_TYPE_COLORS[event.eventType] ??
                            'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {EVENT_TYPE_LABELS[event.eventType] ??
                            event.eventType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{event.title}</td>
                      <td className="px-4 py-3">
                        {event.confirmed ? (
                          <span className="text-green-600 text-xs font-medium">
                            Confirmed
                          </span>
                        ) : (
                          <span className="text-amber-500 text-xs font-medium">
                            Estimated
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {events.length === 0 && !loading && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-12 text-center text-gray-400"
                      >
                        No events match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Companies Table */}
        {tab === 'companies' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Rank
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Code
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Company
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Sector
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Industry Group
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600">
                      Indices
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {companies.map((co) => (
                    <tr key={co.code} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                        #{co.marketCapRank}
                      </td>
                      <td className="px-4 py-3 font-mono font-bold text-blue-700">
                        {co.code}
                      </td>
                      <td className="px-4 py-3 text-gray-900">{co.name}</td>
                      <td className="px-4 py-3 text-gray-700">{co.sector}</td>
                      <td className="px-4 py-3 text-gray-700">
                        {co.industryGroup}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {co.indices.map((idx) => (
                            <span
                              key={idx}
                              className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-100 text-gray-600"
                            >
                              {INDEX_LABELS[idx] ?? idx}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {companies.length === 0 && !loading && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-12 text-center text-gray-400"
                      >
                        No companies match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* API usage hint */}
        <div className="mt-8 bg-gray-800 text-gray-200 rounded-lg p-6 text-sm font-mono">
          <p className="text-gray-400 mb-2"># Example API calls</p>
          <p className="mb-1">
            <span className="text-green-400">GET</span>{' '}
            /api/events?index=asx200&amp;type=earnings&amp;from=2026-08-01&amp;to=2026-08-31
          </p>
          <p className="mb-1">
            <span className="text-green-400">GET</span>{' '}
            /api/events?sector=Materials&amp;type=ex-dividend
          </p>
          <p className="mb-1">
            <span className="text-green-400">GET</span>{' '}
            /api/companies?index=asx100&amp;sector=Financials
          </p>
          <p className="mb-1">
            <span className="text-green-400">GET</span>{' '}
            /api/events?code=BHP,CBA,CSL
          </p>
          <p>
            <span className="text-green-400">GET</span> /api/filters
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-gray-200 mt-12 py-6 text-center text-xs text-gray-400">
        ASX Calendar API v1.0.0 &middot; Data is indicative only &middot;{' '}
        <a
          href="/openapi.json"
          className="text-blue-500 hover:underline"
          target="_blank"
        >
          OpenAPI Spec
        </a>
      </footer>
    </main>
  );
}
