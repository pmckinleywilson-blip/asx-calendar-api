'use client';

import { GICS_SECTORS } from '@/lib/types';
import type { IndexTier, EventType } from '@/lib/types';

// ── Constants ────────────────────────────────────────────────

const INDEX_OPTIONS: { label: string; value: string }[] = [
  { label: 'ALL', value: '' },
  { label: 'ASX 20', value: 'asx20' },
  { label: 'ASX 50', value: 'asx50' },
  { label: 'ASX 100', value: 'asx100' },
  { label: 'ASX 200', value: 'asx200' },
  { label: 'ASX 300', value: 'asx300' },
  { label: 'ALL ORDS', value: 'all-ords' },
  { label: 'SMALL ORDS', value: 'small-ords' },
];

const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: 'ALL', value: '' },
  { label: 'EARN', value: 'earnings' },
  { label: 'INV DAY', value: 'investor_day' },
  { label: 'CONF', value: 'conference' },
  { label: 'AD HOC', value: 'ad_hoc' },
];

const TZ_OPTIONS = [
  'AEST', 'AEDT', 'NZST', 'GMT', 'CET', 'SGT', 'JST', 'ET', 'CT', 'PT',
];

const inputClass =
  'px-1.5 py-1 border border-[#ccc] bg-white text-[10px] font-mono focus:outline-none focus:border-[#0550ae]';

// ── Component ────────────────────────────────────────────────

interface FiltersProps {
  index: string;
  onIndexChange: (value: IndexTier | '') => void;
  sector: string;
  onSectorChange: (value: string) => void;
  eventType: string;
  onEventTypeChange: (value: EventType | '') => void;
  confirmedOnly: boolean;
  onConfirmedOnlyChange: (value: boolean) => void;
  dateFrom: string;
  onDateFromChange: (value: string) => void;
  dateTo: string;
  onDateToChange: (value: string) => void;
  timezone: string;
  onTimezoneChange: (value: string) => void;
}

export default function Filters({
  index,
  onIndexChange,
  sector,
  onSectorChange,
  eventType,
  onEventTypeChange,
  confirmedOnly,
  onConfirmedOnlyChange,
  dateFrom,
  onDateFromChange,
  dateTo,
  onDateToChange,
  timezone,
  onTimezoneChange,
}: FiltersProps) {
  return (
    <div className="flex flex-wrap gap-2 mb-2 py-1.5 border-b border-[#ddd] text-[10px] c-muted items-center">
      {/* FROM */}
      <label className="flex items-center gap-1">
        FROM
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          className={inputClass}
        />
      </label>

      {/* TO */}
      <label className="flex items-center gap-1">
        TO
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          className={inputClass}
        />
      </label>

      {/* INDEX */}
      <label className="flex items-center gap-1">
        INDEX
        <select
          value={index}
          onChange={(e) => onIndexChange(e.target.value as IndexTier | '')}
          className={inputClass}
        >
          {INDEX_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* SECTOR */}
      <label className="flex items-center gap-1">
        SECTOR
        <select
          value={sector}
          onChange={(e) => onSectorChange(e.target.value)}
          className={inputClass}
        >
          <option value="">ALL</option>
          {GICS_SECTORS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {/* TYPE */}
      <label className="flex items-center gap-1">
        TYPE
        <select
          value={eventType}
          onChange={(e) => onEventTypeChange(e.target.value as EventType | '')}
          className={inputClass}
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* CONFIRMED ONLY */}
      <label className="flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          className="w-3 h-3"
          checked={confirmedOnly}
          onChange={(e) => onConfirmedOnlyChange(e.target.checked)}
        />
        CONFIRMED ONLY
      </label>

      {/* TZ — pushed right */}
      <label className="flex items-center gap-1 ml-auto">
        TZ
        <select
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          className={inputClass}
        >
          {TZ_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
