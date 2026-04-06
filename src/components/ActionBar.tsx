'use client';

import { useCallback } from 'react';

interface ActionBarProps {
  selectedIds: number[];
}

export default function ActionBar({ selectedIds }: ActionBarProps) {
  const count = selectedIds.length;

  const handleOutlookDownload = useCallback(async () => {
    if (count === 0) return;
    try {
      const res = await fetch('/api/calendar/bulk.ics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: selectedIds }),
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'asx-calendar.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Bulk ICS download failed:', err);
    }
  }, [selectedIds, count]);

  if (count === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-[#fefefe] border-t-2 border-[#1b1b1b] px-4 py-2 flex items-center justify-between text-[10px] font-mono tracking-wider z-50">
      <span className="c-muted">
        {count} selected
      </span>

      <div className="flex items-center gap-4">
        <button
          onClick={handleOutlookDownload}
          className="px-2 py-1 border border-[#1b1b1b] bg-white hover:bg-[#f6f8fa] cursor-pointer"
        >
          ADD TO OUTLOOK (.ICS)
        </button>
        <a
          href="/subscribe"
          className="ew-link"
        >
          ADD TO GMAIL
        </a>
      </div>
    </div>
  );
}
