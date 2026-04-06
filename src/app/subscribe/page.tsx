"use client";

import { useState } from "react";

const inputClass =
  "w-full px-2 py-1.5 border border-[#ccc] bg-white text-[11px] font-mono focus:outline-none focus:border-[#0550ae]";

export default function SubscribePage() {
  const [email, setEmail] = useState("");
  const [tickers, setTickers] = useState("");
  const [calendarType, setCalendarType] = useState("outlook");
  const [feedUrl, setFeedUrl] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setMessage("");

    try {
      let tickerList: string[] = [];

      if (csvFile) {
        const text = await csvFile.text();
        const lines = text.split("\n");
        if (lines.length >= 2) {
          const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
          const tickerCol = headers.findIndex(
            (h) =>
              h === "ticker" || h === "symbol" || h === "code" ||
              h === "asx code" || h === "asx_code" || h === "stock"
          );
          if (tickerCol >= 0) {
            tickerList = lines
              .slice(1)
              .map((line) => {
                const cells = line.split(",");
                return cells[tickerCol]?.trim().replace(/[^A-Za-z0-9.]/g, "").toUpperCase();
              })
              .filter((t): t is string => !!t && t.length <= 10);
          }
        }
        if (tickerList.length === 0) {
          setError("No valid tickers found in CSV. Ensure it has a 'ticker', 'code', or 'asx code' column.");
          setLoading(false);
          return;
        }
      } else {
        tickerList = tickers
          .split(/[,\s\n]+/)
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean);

        if (tickerList.length === 0) {
          setError("Enter at least one ASX code");
          setLoading(false);
          return;
        }
      }

      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          tickers: [...new Set(tickerList)],
          calendar_type: calendarType,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Request failed" }));
        throw new Error(err.detail || err.message || "Subscribe failed");
      }

      const data = await res.json();
      setFeedUrl(data.feed_url || "");
      setMessage(data.message);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg">
      <div className="text-[12px] font-medium tracking-[1px] mb-1">
        SUBSCRIBE FOR AUTO-INVITES
      </div>
      <div className="text-[10px] c-muted mb-4">
        Enter your watchlist and email. Calendar invites sent directly as events
        are confirmed — with webcast links and dial-in details. Free, no account
        needed.
      </div>

      {message ? (
        <div>
          {/* Confirmation */}
          <div className="border-l-2 border-[#1a7f37] px-3 py-2 mb-3 bg-[#f0fff0]">
            <div className="text-[10px] tracking-[1px] c-green mb-1">
              SUBSCRIBED
            </div>
            <div className="text-[10px] text-[#1b1b1b] mb-2">
              You don&apos;t need to do anything else. We&apos;ll email you
              calendar invites directly as events are confirmed — they&apos;ll
              appear in your{" "}
              {calendarType === "outlook" ? "Outlook" : "Google"} calendar
              automatically.
            </div>
            <div className="text-[10px] c-muted">{message}</div>
            <div className="text-[9px] c-muted mt-2">
              Every email includes an unsubscribe link.
            </div>
          </div>

          {/* Calendar URL (collapsed) */}
          {feedUrl && (
            <details className="border border-[#ccc] text-[10px]">
              <summary className="px-3 py-1.5 cursor-pointer c-muted hover:bg-[#f7f7f7]">
                Advanced: Subscribe via calendar URL instead
              </summary>
              <div className="px-3 pb-2">
                <div className="c-muted mb-1.5">
                  Links your calendar directly to your watchlist — events appear
                  without email invites. Paste this URL into your calendar app
                  once and it stays synced.
                </div>
                <input
                  type="text"
                  readOnly
                  value={feedUrl}
                  className={inputClass}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <div className="text-[9px] c-muted mt-1">
                  Outlook: File &rarr; Account Settings &rarr; Internet
                  Calendars &rarr; paste URL
                  <br />
                  Gmail: Settings &rarr; Add calendar &rarr; From URL &rarr;
                  paste URL
                </div>
              </div>
            </details>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          {/* Email */}
          <div>
            <label className="block text-[9px] c-muted uppercase tracking-wider mb-0.5">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="analyst@firm.com"
              className={inputClass}
            />
          </div>

          {/* Calendar type */}
          <div>
            <label className="block text-[9px] c-muted uppercase tracking-wider mb-0.5">
              Calendar
            </label>
            <div className="flex gap-2">
              <label
                className={`px-3 py-1 border cursor-pointer text-[10px] ${
                  calendarType === "outlook"
                    ? "border-[#0550ae] c-blue bg-[#f0f4ff]"
                    : "border-[#ccc] c-muted"
                }`}
              >
                <input
                  type="radio"
                  name="calendarType"
                  value="outlook"
                  checked={calendarType === "outlook"}
                  onChange={() => setCalendarType("outlook")}
                  className="sr-only"
                />
                OUTLOOK
              </label>
              <label
                className={`px-3 py-1 border cursor-pointer text-[10px] ${
                  calendarType === "gmail"
                    ? "border-[#0550ae] c-blue bg-[#f0f4ff]"
                    : "border-[#ccc] c-muted"
                }`}
              >
                <input
                  type="radio"
                  name="calendarType"
                  value="gmail"
                  checked={calendarType === "gmail"}
                  onChange={() => setCalendarType("gmail")}
                  className="sr-only"
                />
                GMAIL
              </label>
            </div>
          </div>

          {/* Tickers */}
          <div>
            <label className="block text-[9px] c-muted uppercase tracking-wider mb-0.5">
              Watchlist — ASX Codes
            </label>
            {csvFile ? (
              <div className="px-2 py-1.5 border border-[#0550ae] bg-[#f0f4ff] text-[10px] c-blue">
                {csvFile.name}{" "}
                <button
                  type="button"
                  onClick={() => setCsvFile(null)}
                  className="c-red hover:underline ml-2"
                >
                  [remove]
                </button>
              </div>
            ) : (
              <>
                <textarea
                  value={tickers}
                  onChange={(e) => setTickers(e.target.value)}
                  placeholder="BHP, CBA, CSL, WES, NAB..."
                  rows={3}
                  className={inputClass}
                />
                <div className="text-[9px] c-muted mt-0.5">
                  Or{" "}
                  <label className="c-blue cursor-pointer hover:underline">
                    upload a CSV file
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setCsvFile(f);
                      }}
                    />
                  </label>
                </div>
              </>
            )}
          </div>

          {error && (
            <div className="border-l-2 border-[#cf222e] px-2 py-1 text-[10px] c-red">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-1.5 bg-[#1b1b1b] text-white text-[10px] font-mono tracking-[1px] hover:bg-[#333] disabled:opacity-50"
          >
            {loading ? "SUBSCRIBING..." : "SUBSCRIBE"}
          </button>

          <div className="text-[9px] c-muted">
            Direct calendar invites for confirmed events. Unsubscribe anytime.
            Email never shared.
          </div>
        </form>
      )}
    </div>
  );
}
