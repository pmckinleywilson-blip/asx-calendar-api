export default function DocsPage() {
  return (
    <div className="max-w-2xl">
      <div className="text-[12px] font-medium tracking-[1px] mb-1">
        API DOCUMENTATION
      </div>
      <div className="text-[10px] c-muted mb-4">
        All endpoints return JSON. No authentication required. CORS enabled for
        all origins.
      </div>

      {/* Events */}
      <section className="mb-4">
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          GET /api/events
        </div>
        <div className="text-[10px] c-muted mb-2">
          List upcoming teleconference and webcast events for ASX-listed
          companies.
        </div>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 mb-2 overflow-x-auto">
{`Parameters:
  q              Search ticker or company name
  ticker         Comma-separated ASX codes (e.g. BHP,CBA,CSL)
  index          asx20|asx50|asx100|asx200|asx300|all-ords|small-ords
  sector         GICS sector (partial, case-insensitive)
  type           earnings|investor_day|conference|ad_hoc
  confirmed_only true to exclude tentative events
  date_from      YYYY-MM-DD
  date_to        YYYY-MM-DD
  per_page       Results per page (default 5000, max 5000)
  page           Page number (default 1)`}
        </pre>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 overflow-x-auto">
{`Example:
  GET /api/events?index=asx200&type=earnings&date_from=2026-08-01

Response:
  {
    "events": [{ "id": 1, "ticker": "BHP", ... }],
    "total": 34, "page": 1, "per_page": 5000, "pages": 1
  }`}
        </pre>
      </section>

      {/* Calendar */}
      <section className="mb-4">
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          CALENDAR DOWNLOADS
        </div>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 mb-2 overflow-x-auto">
{`GET  /api/calendar/{id}.ics      Single event .ics download
GET  /api/calendar/{id}/gmail     Google Calendar add URL
POST /api/calendar/bulk.ics       Bulk .ics (body: [1, 2, 3])`}
        </pre>
      </section>

      {/* Companies */}
      <section className="mb-4">
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          GET /api/companies
        </div>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 overflow-x-auto">
{`Parameters:
  index          Filter by ASX index
  sector         Filter by GICS sector
  industry       Filter by GICS industry group
  search         Search by name or code
  limit          Max results (default 100)
  offset         Pagination offset`}
        </pre>
      </section>

      {/* Subscribe */}
      <section className="mb-4">
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          POST /api/subscribe
        </div>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 overflow-x-auto">
{`Body (JSON):
  {
    "email": "analyst@firm.com",
    "tickers": ["BHP", "CBA", "CSL"],
    "calendar_type": "outlook"   // or "gmail"
  }

Response:
  {
    "feed_url": "https://.../.ics",
    "message": "Subscribed to 3 ASX codes..."
  }`}
        </pre>
      </section>

      {/* Other */}
      <section className="mb-4">
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          OTHER ENDPOINTS
        </div>
        <pre className="text-[9px] bg-[#f2f2f2] p-2 overflow-x-auto">
{`GET /api/filters                Available filter values
GET /api/health                 API status & data counts
GET /.well-known/ai-plugin.json AI agent discovery manifest
GET /openapi.json               OpenAPI 3.1 specification`}
        </pre>
      </section>

      {/* Rate limits */}
      <section>
        <div className="text-[10px] font-medium tracking-[1px] mb-1 border-b border-[#ddd] pb-0.5">
          RATE LIMITS
        </div>
        <div className="text-[10px] c-muted">
          60 requests per minute per IP. All read endpoints are unauthenticated.
        </div>
      </section>
    </div>
  );
}
