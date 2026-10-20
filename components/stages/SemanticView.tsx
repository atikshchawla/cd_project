'use client';

import { useMemo } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { DiagnosticList } from '@/components/common/DiagnosticList';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import {
  SEMA_BLOCKED,
  SEMA_COL_DECLARED,
  SEMA_COL_KIND,
  SEMA_COL_NAME,
  SEMA_COL_TYPE,
  SEMA_COL_USES,
  SEMA_EMPTY_TABLE,
  SEMA_NO_RESULT,
  SEMA_SYMBOL_COUNT_LABEL,
  SEMA_SYMBOL_TABLE_TITLE,
  SEMA_USES_HINT,
  SYMBOL_KIND_EXPLANATIONS,
  typeToString,
} from '@/content/explanations';
import { computeHighlights, createEmptyHighlights } from '@/lib/highlight';
import { positionAt } from '@/lib/positions';
import { useWorkspaceStore } from '@/lib/store';
import type { Symbol } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

function useSymbolHighlights() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  return useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );
}

function SymbolRow({ symbol }: { symbol: Symbol }) {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const highlights = useSymbolHighlights();

  const isPrimary = selection.kind === 'symbol' && selection.symbolId === symbol.id;
  const isRelated = !isPrimary && highlights.symbolIds.has(symbol.id);

  const declNode = result?.ast?.nodes[symbol.declNodeId];
  const declaredAt =
    declNode !== undefined && result !== null && result !== undefined
      ? positionAt(result.source, declNode.range.start)
      : null;

  return (
    <button
      type="button"
      aria-pressed={isPrimary}
      onClick={() => select({ kind: 'symbol', symbolId: symbol.id, origin: 'stage' })}
      className={cn(
        'grid w-full grid-cols-[minmax(5rem,1fr)_minmax(4.5rem,6rem)_minmax(3rem,4rem)_minmax(4rem,5rem)_3rem] items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        isPrimary && 'bg-amber-100 font-semibold outline outline-2 -outline-offset-2 outline-amber-700',
        isRelated && 'bg-sky-50 underline decoration-dashed decoration-sky-700/70 underline-offset-2',
      )}
    >
      <code className="truncate font-mono text-[0.85rem]" title={symbol.name}>
        {symbol.name}
      </code>
      <span className="inline-flex w-fit items-center rounded-full border border-border bg-background px-2 py-0.5 text-[0.7rem] font-medium">
        {symbol.kind}
      </span>
      <span className="font-mono text-[0.8rem] text-foreground/80">
        {typeToString(symbol.type)}
      </span>
      <span className="font-mono text-[0.75rem] text-foreground/70">
        {declaredAt === null ? '—' : `${declaredAt.line}:${declaredAt.col}`}
      </span>
      <span className="text-right font-mono text-[0.75rem] text-foreground/70">
        {symbol.useNodeIds.length}
      </span>
    </button>
  );
}

/**
 * Semantic view (§8): the symbol table plus the shared diagnostics list.
 * Rows are buttons; clicking a row selects the symbol, which highlights its
 * declaration and every use across stages.
 */
export function SemanticView() {
  const result = useWorkspaceStore((state) => state.result);

  const symbols = result?.symbols?.symbols ?? null;
  const diagnostics = result?.diagnostics ?? [];
  const semaErrors = diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' && diagnostic.stage === 'sema',
  );
  const otherDiagnostics = diagnostics.filter(
    (diagnostic) => !(diagnostic.severity === 'error' && diagnostic.stage === 'sema'),
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProvenanceBadge kind="generated" />
          {symbols !== null ? (
            <Badge variant="outline" className="font-mono text-[0.7rem]">
              {symbols.length} {SEMA_SYMBOL_COUNT_LABEL}
            </Badge>
          ) : null}
          {result?.completed.sema === 'warnings' ? (
            <Badge variant="outline" className="border-amber-700/40 bg-amber-50 text-[0.7rem] text-amber-900">
              warnings
            </Badge>
          ) : null}
        </div>

        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {SEMA_SYMBOL_TABLE_TITLE}
        </h3>

        {result === null ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
            {SEMA_NO_RESULT}
          </div>
        ) : symbols === null ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-6 text-muted-foreground">{SEMA_BLOCKED}</p>
          </div>
        ) : symbols.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
            {SEMA_EMPTY_TABLE}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <div
              aria-hidden="true"
              className="grid grid-cols-[minmax(5rem,1fr)_minmax(4.5rem,6rem)_minmax(3rem,4rem)_minmax(4rem,5rem)_3rem] gap-2 border-b border-border bg-muted/50 px-2 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <span>{SEMA_COL_NAME}</span>
              <span>{SEMA_COL_KIND}</span>
              <span>{SEMA_COL_TYPE}</span>
              <span>{SEMA_COL_DECLARED}</span>
              <span className="text-right">{SEMA_COL_USES}</span>
            </div>
            <div className="max-h-[22rem] overflow-y-auto">
              {symbols.map((symbol) => (
                <SymbolRow key={symbol.id} symbol={symbol} />
              ))}
            </div>
          </div>
        )}

        {symbols !== null && symbols.length > 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">{SEMA_USES_HINT}</p>
        ) : null}

        {symbols !== null ? (
          <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
              What the kinds mean
            </summary>
            <dl className="grid gap-2 pt-2 sm:grid-cols-2">
              {Object.entries(SYMBOL_KIND_EXPLANATIONS).map(([kind, text]) => (
                <div key={kind} className="flex items-start gap-2">
                  <dt className="inline-flex w-fit shrink-0 items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium">
                    {kind}
                  </dt>
                  <dd className="text-xs leading-5 text-muted-foreground">{text}</dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Diagnostics
        </h3>
        {otherDiagnostics.length === 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {semaErrors.length === 0
              ? 'No diagnostics from any stage.'
              : 'Errors are listed under the Semantic analysis diagnostics below.'}
          </p>
        ) : (
          <DiagnosticList diagnostics={otherDiagnostics} />
        )}
        {semaErrors.length > 0 ? (
          <>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Semantic analysis
            </h4>
            <DiagnosticList diagnostics={semaErrors} />
          </>
        ) : null}
      </section>
    </div>
  );
}
