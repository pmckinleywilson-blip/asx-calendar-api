"use client";

import { useState, useEffect, useCallback } from "react";
import EventsTable from "@/components/EventsTable";
import ActionBar from "@/components/ActionBar";
import Filters from "@/components/Filters";
import WatchlistUpload from "@/components/WatchlistUpload";
import type { EventItem } from "@/lib/types";

export default function Home() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  // Filters
  const [index, setIndex] = useState("");
  const [sector, setSector] = useState("");
  const [eventType, setEventType] = useState("");
  const [confirmedOnly, setConfirmedOnly] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Search
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Timezone — default to AEST, persisted in localStorage
  const [timezone, setTimezone] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("aw_timezone") || "AEST";
    }
    return "AEST";
  });
  const handleTimezoneChange = (tz: string) => {
    setTimezone(tz);
    if (typeof window !== "undefined") {
      localStorage.setItem("aw_timezone", tz);
    }
  };

  // Watchlist
  const [watchlistTickers, setWatchlistTickers] = useState<string[] | null>(
    null
  );

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput.trim().toUpperCase());
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ per_page: "5000" });
      if (index) params.set("index", index);
      if (sector) params.set("sector", sector);
      if (eventType) params.set("type", eventType);
      if (confirmedOnly) params.set("confirmed_only", "true");
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo) params.set("date_to", dateTo);
      if (watchlistTickers) params.set("ticker", watchlistTickers.join(","));
      if (searchQuery) params.set("q", searchQuery);

      const res = await fetch(`/api/events?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setEvents(data.events || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [index, sector, eventType, confirmedOnly, dateFrom, dateTo, watchlistTickers, searchQuery]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleWatchlistUpload = async (file: File) => {
    try {
      const text = await file.text();
      const lines = text.split("\n");
      if (lines.length < 2) return;

      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const tickerCol = headers.findIndex(
        (h) =>
          h === "ticker" ||
          h === "symbol" ||
          h === "code" ||
          h === "asx code" ||
          h === "asx_code" ||
          h === "stock"
      );
      if (tickerCol === -1) {
        setError("CSV must have a 'ticker', 'code', or 'asx code' column");
        return;
      }

      const tickers = lines
        .slice(1)
        .map((line) => {
          const cells = line.split(",");
          return cells[tickerCol]
            ?.trim()
            .replace(/[^A-Za-z0-9.]/g, "")
            .toUpperCase();
        })
        .filter((t) => t && t.length <= 10);

      if (tickers.length === 0) {
        setError("No valid tickers found in CSV");
        return;
      }

      setWatchlistTickers([...new Set(tickers)] as string[]);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // KPI stats
  const totalEvents = events.length;
  const confirmedCount = events.filter((e) => e.status === "confirmed").length;
  const tentativeCount = totalEvents - confirmedCount;
  const withWebcast = events.filter((e) => e.webcast_url).length;

  return (
    <div>
      {/* KPI Row */}
      <div className="flex items-center gap-4 py-1.5 mb-2 border-b border-[#ddd] text-[10px] c-muted">
        <span>
          EVENTS: <strong className="text-[#1b1b1b]">{totalEvents}</strong>
        </span>
        <span>
          CONFIRMED:{" "}
          <strong className="c-green">{confirmedCount}</strong>
        </span>
        <span>
          TENTATIVE:{" "}
          <strong className="c-amber">{tentativeCount}</strong>
        </span>
        <span>
          WEBCAST: <strong className="c-blue">{withWebcast}</strong>
        </span>
        <span className="ml-auto">
          <WatchlistUpload
            onUpload={handleWatchlistUpload}
            onClear={() => setWatchlistTickers(null)}
            isActive={!!watchlistTickers}
            tickerCount={watchlistTickers?.length}
          />
        </span>
      </div>

      {/* Subscribe CTA */}
      <a
        href="/subscribe"
        className="block mb-2 px-3 py-2 bg-[#1b1b1b] text-white no-underline hover:bg-[#333]"
      >
        <span className="text-[10px] tracking-[1px]">
          SUBSCRIBE FOR AUTO-INVITES
        </span>
        <span className="text-[9px] ml-2 px-1.5 py-0.5 bg-white/15 tracking-wider">
          FREE / NO ACCOUNT
        </span>
        <br />
        <span className="text-[9px] text-[#999] mt-0.5 inline-block">
          Enter watchlist and email once. Calendar invites sent directly as
          events are confirmed — with webcast links and dial-in details.
        </span>
      </a>

      {/* Filters */}
      <Filters
        index={index}
        onIndexChange={setIndex}
        sector={sector}
        onSectorChange={setSector}
        eventType={eventType}
        onEventTypeChange={setEventType}
        confirmedOnly={confirmedOnly}
        onConfirmedOnlyChange={setConfirmedOnly}
        dateFrom={dateFrom}
        onDateFromChange={setDateFrom}
        dateTo={dateTo}
        onDateToChange={setDateTo}
        timezone={timezone}
        onTimezoneChange={handleTimezoneChange}
      />

      {/* Tentative warning */}
      <div className="mb-2 px-2 py-1 border-l-2 border-[#9a6700] text-[9px] c-muted bg-[#fffbe6]">
        <strong className="c-amber">TENTATIVE </strong> events may not have final
        times or webcast details. Adding individually creates a snapshot that
        won&apos;t auto-update.{" "}
        <a href="/subscribe" className="c-blue hover:underline">
          Subscribe
        </a>{" "}
        for auto-updating invites.
      </div>

      {/* Error */}
      {error && (
        <div className="mb-2 px-2 py-1 border-l-2 border-[#cf222e] text-[9px] c-red">
          {error}{" "}
          <button
            className="c-muted hover:underline"
            onClick={() => setError(null)}
          >
            [dismiss]
          </button>
        </div>
      )}

      {/* Loading / Table */}
      {loading ? (
        <div className="text-center py-8 c-muted text-[10px]">
          LOADING EVENTS...
        </div>
      ) : (
        <EventsTable
          events={events}
          onSelectionChange={setSelectedIds}
          watchlistTickers={watchlistTickers}
          searchValue={searchInput}
          onSearchChange={setSearchInput}
          timezone={timezone}
        />
      )}

      {/* Sticky action bar */}
      <ActionBar
        selectedIds={selectedIds}
      />

      {/* Schema.org structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "ASX Wire",
            url: "https://asx-calendar-api.vercel.app",
            description:
              "Free ASX events calendar with webcast links and calendar invites for all ASX-listed companies",
          }),
        }}
      />
    </div>
  );
}
