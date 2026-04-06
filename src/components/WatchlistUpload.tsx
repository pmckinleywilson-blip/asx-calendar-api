'use client';

import { useRef, useState, useCallback } from 'react';

interface WatchlistUploadProps {
  onUpload: (file: File) => void;
  onClear: () => void;
  isActive: boolean;
  tickerCount?: number;
}

export default function WatchlistUpload({
  onUpload,
  onClear,
  isActive,
  tickerCount,
}: WatchlistUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (file && file.name.endsWith('.csv')) {
        onUpload(file);
      }
    },
    [onUpload],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      handleFile(file);
    },
    [handleFile],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  if (isActive) {
    return (
      <span className="text-[10px] font-mono tracking-wider c-muted">
        WATCHLIST: {tickerCount} tickers{' '}
        <button
          onClick={onClear}
          className="c-muted hover:text-[#1b1b1b] underline cursor-pointer bg-transparent border-none p-0 text-[10px] font-mono tracking-wider"
        >
          [clear]
        </button>
      </span>
    );
  }

  return (
    <span
      className={`text-[10px] font-mono tracking-wider cursor-pointer ${
        dragging ? 'c-blue' : 'c-muted hover:text-[#1b1b1b]'
      }`}
      onClick={() => inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      [UPLOAD CSV WATCHLIST]
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </span>
  );
}
