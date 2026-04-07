'use client';

import { useMemo, useState, useCallback } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  ColumnDef,
  SortingState,
} from '@tanstack/react-table';
import type { EventItem } from '@/lib/types';

// ── Timezone offsets from AEST (UTC+10) ──────────────────────
export const TZ_OFFSETS: Record<string, number> = {
  AEST: 0,
  AEDT: 1,
  NZST: 2,
  NZDT: 3,
  JST: -1,
  SGT: -2,
  'GMT+8': -2,
  CET: -9,
  GMT: -10,
  ET: -15,
  CT: -16,
  PT: -18,
};

// ── Helpers ──────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  earnings: 'EARN',
  investor_day: 'INV',
  conference: 'CONF',
  ad_hoc: 'ADHC',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(dateStr: string): string {
  const dt = parseLocalDate(dateStr);
  return `${dt.getDate()} ${MONTHS[dt.getMonth()]}`;
}

export function getDayLabel(dateStr: string): string {
  const dt = parseLocalDate(dateStr);
  const day = DAYS[dt.getDay()];
  const d = dt.getDate();
  const mon = MONTHS[dt.getMonth()].toUpperCase();
  return `${day} ${d} ${mon}`;
}

export function formatTime(
  time: string | null,
  tzOffset: number,
): string {
  if (!time) return '--:--';
  const [hStr, mStr] = time.split(':');
  let h = parseInt(hStr, 10) + tzOffset;
  const m = parseInt(mStr, 10);

  // wrap around midnight
  if (h < 0) h += 24;
  if (h >= 24) h -= 24;

  const suffix = h < 12 ? 'a' : 'p';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const mm = m.toString().padStart(2, '0');
  return `${h12}:${mm}${suffix}`;
}

function buildGmailUrl(event: EventItem, tzOffset: number): string {
  const d = event.event_date.replace(/-/g, '');
  const title = encodeURIComponent(
    `${event.ticker} ${TYPE_LABELS[event.event_type] ?? event.event_type}`,
  );
  const details = encodeURIComponent(
    [event.title, event.description, event.webcast_url]
      .filter(Boolean)
      .join('\n'),
  );
  const timeText = event.event_time
    ? formatTime(event.event_time, tzOffset)
    : '';
  const location = encodeURIComponent(timeText);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${d}/${d}&details=${details}&location=${location}`;
}

// ── Component ────────────────────────────────────────────────

interface EventsTableProps {
  events: EventItem[];
  onSelectionChange: (ids: number[]) => void;
  watchlistTickers: string[] | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  timezone: string;
}

export default function EventsTable({
  events,
  onSelectionChange,
  watchlistTickers,
  searchValue,
  onSearchChange,
  timezone,
}: EventsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const tzOffset = TZ_OFFSETS[timezone] ?? 0;
  const watchSet = useMemo(
    () => new Set((watchlistTickers ?? []).map((t) => t.toUpperCase())),
    [watchlistTickers],
  );

  // ── selection helpers ────────────────────────────────────
  const toggleRow = useCallback(
    (id: number) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        const arr = Array.from(next);
        onSelectionChange(arr);
        return next;
      });
    },
    [onSelectionChange],
  );

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allIds = events.map((e) => e.id);
      const allSelected = allIds.length > 0 && allIds.every((id) => prev.has(id));
      const next = allSelected ? new Set<number>() : new Set(allIds);
      onSelectionChange(Array.from(next));
      return next;
    });
  }, [events, onSelectionChange]);

  // ── columns ──────────────────────────────────────────────
  const columns = useMemo<ColumnDef<EventItem, unknown>[]>(
    () => [
      {
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            className="w-3 h-3"
            checked={
              events.length > 0 &&
              events.every((e) => selectedIds.has(e.id))
            }
            onChange={toggleAll}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="w-3 h-3"
            checked={selectedIds.has(row.original.id)}
            onChange={() => toggleRow(row.original.id)}
          />
        ),
        enableSorting: false,
      },
      {
        id: 'watch',
        header: '',
        cell: ({ row }) =>
          watchSet.has(row.original.ticker.toUpperCase()) ? (
            <span className="ew-link">W</span>
          ) : null,
        enableSorting: false,
      },
      {
        accessorKey: 'event_date',
        header: 'Date',
        cell: ({ getValue }) => formatDate(getValue<string>()),
      },
      {
        accessorKey: 'ticker',
        header: 'Ticker',
        cell: ({ getValue }) => (
          <span className="c-blue">{getValue<string>()}</span>
        ),
      },
      {
        accessorKey: 'company_name',
        header: 'Company',
        cell: ({ getValue }) => (
          <span
            className="block truncate max-w-[180px]"
            title={getValue<string>()}
          >
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'event_type',
        header: 'Type',
        cell: ({ getValue }) => (
          <span className="c-muted">
            {TYPE_LABELS[getValue<string>()] ?? getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'event_time',
        header: 'Time',
        cell: ({ row }) => formatTime(row.original.event_time, tzOffset),
        enableSorting: false,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const e = row.original;
          return (
            <span className="flex gap-2 items-center">
              <a
                href={`/api/calendar/${e.id}.ics`}
                className="ew-link"
              >
                +Outlook
              </a>
              <a
                href={buildGmailUrl(e, tzOffset)}
                target="_blank"
                rel="noopener noreferrer"
                className="ew-link"
              >
                +Gmail
              </a>
              {e.webcast_url && (
                <a
                  href={e.webcast_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ew-link"
                >
                  Webcast
                </a>
              )}
            </span>
          );
        },
        enableSorting: false,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ row }) => {
          const s = row.original.status;
          const label = (row.original as any).status_label || s;
          if (s === 'confirmed') {
            return <span className="ew-confirmed" title={label}>CONF</span>;
          }
          if (s === 'date_confirmed') {
            return <span className="ew-tentative" title={label}>DATE</span>;
          }
          return <span className="c-muted" title={label}>EST</span>;
        },
      },
    ],
    [events, selectedIds, toggleAll, toggleRow, watchSet, tzOffset],
  );

  // ── table instance ──────────────────────────────────────
  const table = useReactTable({
    data: events,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // ── date-separator bookkeeping ──────────────────────────
  const sortedRows = table.getRowModel().rows;
  const dateSepSet = useMemo(() => {
    const seen = new Set<string>();
    const map = new Map<string, string>(); // rowId -> label
    for (const row of sortedRows) {
      const d = row.original.event_date;
      if (!seen.has(d)) {
        seen.add(d);
        map.set(row.id, getDayLabel(d));
      }
    }
    return map;
  }, [sortedRows]);

  // ── render ──────────────────────────────────────────────
  return (
    <div>
      {/* search */}
      <input
        type="text"
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="search code or company..."
        className="mb-2 px-1.5 py-1 w-full border border-[#ccc] bg-white text-[11px] font-mono focus:outline-none focus:border-[#0550ae]"
      />

      <table className="w-full border-collapse text-[11px] font-mono">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-[#ddd]">
              {hg.headers.map((header) => (
                <th
                  key={header.id}
                  className="px-1 py-0.5 text-left c-muted font-normal whitespace-nowrap cursor-pointer select-none"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                  {header.column.getIsSorted() === 'asc' && ' \u25B2'}
                  {header.column.getIsSorted() === 'desc' && ' \u25BC'}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isWatched = watchSet.has(
              row.original.ticker.toUpperCase(),
            );
            const isSelected = selectedIds.has(row.original.id);
            const sepLabel = dateSepSet.get(row.id);

            return (
              <>
                {sepLabel && (
                  <tr key={`sep-${row.id}`} className="ew-sep">
                    <td
                      colSpan={columns.length}
                      className="px-1 py-0.5 font-bold tracking-wider"
                    >
                      {sepLabel}
                    </td>
                  </tr>
                )}
                <tr
                  key={row.id}
                  className={[
                    'border-b border-[#eee] hover:bg-[#f6f8fa]',
                    isWatched ? 'ew-watched' : '',
                    isSelected ? 'bg-[#ddf4ff]' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-1 py-0.5 whitespace-nowrap"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
