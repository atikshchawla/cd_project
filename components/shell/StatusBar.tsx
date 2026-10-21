'use client';

import { CircleHelp } from 'lucide-react';
import { useWorkspaceStore } from '@/lib/store';

/**
 * 24px footer (SPEC target layout D): build facts on the left, one link that
 * opens the full honesty statement in the About dialog on the right.
 */
export function StatusBar() {
  const setAboutOpen = useWorkspaceStore((state) => state.setAboutOpen);

  return (
    <footer
      aria-label="Build information"
      className="flex h-6 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-3 font-mono text-[12px] text-muted-foreground"
    >
      <span className="truncate">
        Mini-C compiler v0.1 · IR: LLVM-style (opaque ptr) · opt: none · target x86-64
      </span>
      <button
        type="button"
        onClick={() => setAboutOpen(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 transition-colors hover:text-foreground"
      >
        <CircleHelp aria-hidden="true" className="size-3" />
        Not produced by Clang/LLVM
      </button>
    </footer>
  );
}
