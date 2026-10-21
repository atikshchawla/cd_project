'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'minic-split';
const DEFAULT_SPLIT = 40;
const MIN_LEFT_PX = 280;
const MIN_RIGHT_PX = 320;
const STEP_PCT = 2;
const LARGE_STEP_PCT = 10;
const MIN_PCT = 20;
const MAX_PCT = 80;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredSplit(): number {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = Number.parseFloat(stored);
      if (Number.isFinite(parsed)) return clamp(parsed, MIN_PCT, MAX_PCT);
    }
  } catch {
    // Private mode: fall back to the default split.
  }
  return DEFAULT_SPLIT;
}

function subscribeToSplit(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  return () => window.removeEventListener('storage', onStoreChange);
}

function getServerSplitSnapshot(): number {
  return DEFAULT_SPLIT;
}

interface ResizablePanesProps {
  left: ReactNode;
  right: ReactNode;
}

/**
 * Two resizable panes split by a draggable separator (no extra dependency).
 * Below 1024px the panes simply stack and the separator hides. The split
 * percentage is read from localStorage via useSyncExternalStore (never during
 * server render) and written back after each drag.
 */
export function ResizablePanes({ left, right }: ResizablePanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const storedSplit = useSyncExternalStore(
    subscribeToSplit,
    readStoredSplit,
    getServerSplitSnapshot,
  );
  const [dragSplit, setDragSplit] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const split = dragSplit ?? storedSplit;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(split));
    } catch {
      // Private mode: persistence is best-effort.
    }
  }, [split]);

  const splitFromClientX = (clientX: number): number | null => {
    const container = containerRef.current;
    if (container === null) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    const minPct = (MIN_LEFT_PX / rect.width) * 100;
    const maxPct = 100 - (MIN_RIGHT_PX / rect.width) * 100;
    return clamp(pct, Math.max(MIN_PCT, minPct), Math.min(MAX_PCT, maxPct));
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex min-h-0 flex-col lg:h-full lg:flex-row',
        dragging && 'select-none',
      )}
    >
      <div
        className="min-w-0 lg:h-full lg:min-h-0 lg:overflow-hidden lg:basis-[var(--split)] lg:shrink-0"
        style={{ '--split': `${split}%` } as CSSProperties}
      >
        {left}
      </div>

      <div
        role="separator"
        aria-label="Resize the editor and workspace panes"
        aria-orientation="vertical"
        aria-valuemin={MIN_PCT}
        aria-valuemax={MAX_PCT}
        aria-valuenow={Math.round(split)}
        aria-valuetext={`${Math.round(split)} percent editor width`}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const next = splitFromClientX(event.clientX);
          if (next !== null) setDragSplit(next);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setDragSplit(DEFAULT_SPLIT)}
        onKeyDown={(event) => {
          const step =
            event.key === 'ArrowLeft'
              ? -(event.shiftKey ? LARGE_STEP_PCT : STEP_PCT)
              : event.key === 'ArrowRight'
                ? event.shiftKey
                  ? LARGE_STEP_PCT
                  : STEP_PCT
                : null;
          if (step !== null) {
            event.preventDefault();
            setDragSplit(clamp(split + step, MIN_PCT, MAX_PCT));
            return;
          }
          if (event.key === 'Home') {
            event.preventDefault();
            setDragSplit(MIN_PCT);
          } else if (event.key === 'End') {
            event.preventDefault();
            setDragSplit(MAX_PCT);
          }
        }}
        className={cn(
          'hidden w-1.5 shrink-0 cursor-col-resize touch-none items-center justify-center bg-transparent outline-none hover:bg-accent focus-visible:bg-accent lg:flex',
          dragging && 'bg-accent',
        )}
      >
        <span aria-hidden="true" className="h-10 w-px rounded bg-border" />
      </div>

      <div className="min-h-0 min-w-0 lg:h-full lg:flex-1 lg:overflow-hidden">{right}</div>
    </div>
  );
}
