import { COMPILER_VERSION } from '@/lib/compiler';

export function SettingsStrip() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 font-mono text-[0.72rem] text-muted-foreground">
      <span>Mini-C compiler v{COMPILER_VERSION}</span>
      <span aria-hidden="true">·</span>
      <span>IR style: LLVM-like (opaque pointers)</span>
      <span aria-hidden="true">·</span>
      <span>optimisation: none</span>
    </div>
  );
}
