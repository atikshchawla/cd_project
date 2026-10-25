'use client';

import { useMemo, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/components/common/DiagnosticList';
import {
  SCOPE_NODE_HEIGHT,
  SCOPE_NODE_WIDTH,
  SYMBOL_NODE_HEIGHT,
  SYMBOL_NODE_WIDTH,
  ScopeTreeCanvas,
  type ScopeTreeNode,
} from '@/components/common/ScopeTreeCanvas';
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
  SEMA_SCOPE_EMPTY_SELECTION,
  SEMA_SCOPE_GLOBAL_LABEL,
  SEMA_SCOPE_KIND_LABEL,
  SEMA_SCOPE_LABEL,
  SEMA_SCOPE_NONE,
  SEMA_SCOPE_OWNER_LABEL,
  SEMA_SCOPE_PARENT_LABEL,
  SEMA_SCOPE_SYMBOL_COUNT,
  SEMA_SCOPE_SYMBOLS_LABEL,
  SEMA_SCOPE_TREE_HINT,
  SEMA_SCOPE_TREE_TITLE,
  SEMA_SYMBOL_COUNT_LABEL,
  SEMA_SYMBOL_TABLE_TITLE,
  SEMA_TABLE_LABEL,
  SEMA_TREE_EMPTY,
  SEMA_TREE_LABEL,
  SEMA_USES_HINT,
  SEMA_VIEW_MODE_LABEL,
  SYMBOL_KIND_EXPLANATIONS,
  semaScopeFunctionLabel,
  typeToString,
} from '@/content/explanations';
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { positionAt } from '@/lib/positions';
import { useWorkspaceStore } from '@/lib/store';
import type { Scope, Symbol } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

function useSymbolHighlights() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const optimization = useWorkspaceStore((state) => state.optimization);
  return useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result, optimization)),
    [selection, result, optimization, stale],
  );
}

// ---------------------------------------------------------------------------
// Scope tree (React Flow)
// ---------------------------------------------------------------------------

function scopeDisplay(scope: Scope, ownerName: string | null, ownerPosition: string | null): {
  label: string;
  subtitle: string;
} {
  if (scope.kind === 'global') {
    return { label: SEMA_SCOPE_GLOBAL_LABEL, subtitle: SEMA_SCOPE_SYMBOLS_LABEL };
  }
  if (scope.kind === 'function') {
    return {
      label: semaScopeFunctionLabel(ownerName ?? '?'),
      subtitle: ownerPosition ?? '',
    };
  }
  return {
    label: `block ${ownerPosition ?? ''}`.trim(),
    subtitle: ownerPosition ?? '',
  };
}

function ScopeTree({
  selectedScopeId,
  onSelectScope,
}: {
  selectedScopeId: number | null;
  onSelectScope: (scopeId: number) => void;
}) {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const highlights = useSymbolHighlights();
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  const layout = useMemo(() => {
    const table = result?.symbols;
    const ast = result?.ast ?? null;
    const source = result?.source ?? '';
    if (table === null || table === undefined) return null;

    const primarySymbolId = selection.kind === 'symbol' ? selection.symbolId : null;
    const selectedScopeOfSymbol =
      primarySymbolId === null
        ? null
        : (table.symbols.find((candidate) => candidate.id === primarySymbolId)?.scopeId ?? null);

    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'TB', nodesep: 14, ranksep: 30, marginx: 8, marginy: 8 });
    graph.setDefaultEdgeLabel(() => ({}));

    for (const scope of table.scopes) {
      graph.setNode(`s${scope.id}`, { width: SCOPE_NODE_WIDTH, height: SCOPE_NODE_HEIGHT });
    }
    for (const symbol of table.symbols) {
      graph.setNode(`y${symbol.id}`, { width: SYMBOL_NODE_WIDTH, height: SYMBOL_NODE_HEIGHT });
    }
    for (const scope of table.scopes) {
      if (scope.parentId !== null) graph.setEdge(`s${scope.parentId}`, `s${scope.id}`);
    }
    for (const symbol of table.symbols) {
      graph.setEdge(`s${symbol.scopeId}`, `y${symbol.id}`);
    }
    dagre.layout(graph);

    const nodes: ScopeTreeNode[] = [];
    for (const scope of table.scopes) {
      const position = graph.node(`s${scope.id}`);
      const ownerNode = ast?.nodes[scope.ownerNodeId];
      const pos = ownerNode !== undefined ? positionAt(source, ownerNode.range.start) : null;
      const display = scopeDisplay(
        scope,
        ownerNode?.name ?? null,
        pos === null ? null : `${pos.line}:${pos.col}`,
      );
      const isSelectedScope = selectedScopeId === scope.id || selectedScopeOfSymbol === scope.id;
      const hasAnySelection = primarySymbolId !== null || selectedScopeId !== null;
      nodes.push({
        id: `s${scope.id}`,
        type: 'scopeNode',
        position: {
          x: (position?.x ?? 0) - SCOPE_NODE_WIDTH / 2,
          y: (position?.y ?? 0) - SCOPE_NODE_HEIGHT / 2,
        },
        data: {
          label: display.label,
          subtitle: `${scope.symbolIds.length} ${SEMA_SCOPE_SYMBOL_COUNT}${display.subtitle ? ` · ${display.subtitle}` : ''}`,
          isSelected: isSelectedScope,
          isDimmed: hasAnySelection && !isSelectedScope,
          onSelect: () => onSelectScope(scope.id),
        },
      });
    }
    for (const symbol of table.symbols) {
      const position = graph.node(`y${symbol.id}`);
      const isPrimary = primarySymbolId === symbol.id;
      const isRelated = !isPrimary && highlights.symbolIds.has(symbol.id);
      const hasAnySelection = primarySymbolId !== null || selectedScopeId !== null;
      nodes.push({
        id: `y${symbol.id}`,
        type: 'symbolNode',
        position: {
          x: (position?.x ?? 0) - SYMBOL_NODE_WIDTH / 2,
          y: (position?.y ?? 0) - SYMBOL_NODE_HEIGHT / 2,
        },
        data: {
          label: symbol.name,
          subtitle: `${symbol.kind}:${typeToString(symbol.type)}`,
          isPrimary,
          isRelated,
          isDimmed: hasAnySelection && !isPrimary && !isRelated,
          tintClass,
          onSelect: () => select({ kind: 'symbol', symbolId: symbol.id, origin: 'stage' }),
        },
      });
    }

    const edges = [
      ...table.scopes
        .filter((scope) => scope.parentId !== null)
        .map((scope) => ({
          id: `es${scope.parentId}-${scope.id}`,
          source: `s${scope.parentId}`,
          target: `s${scope.id}`,
          style: { stroke: 'oklch(0.7 0.08 300)' },
        })),
      ...table.symbols.map((symbol) => ({
        id: `ey${symbol.scopeId}-${symbol.id}`,
        source: `s${symbol.scopeId}`,
        target: `y${symbol.id}`,
        style: { stroke: 'oklch(0.75 0.05 200)' },
      })),
    ];

    return { nodes, edges };
  }, [result, selection, highlights, selectedScopeId, tintClass, select, onSelectScope]);

  if (layout === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {SEMA_TREE_EMPTY}
      </div>
    );
  }

  return (
    <ScopeTreeCanvas
      nodes={layout.nodes}
      edges={layout.edges}
      label={`${SEMA_SCOPE_TREE_TITLE} — ${SEMA_TREE_LABEL}`}
      heightClass="h-[26rem]"
    />
  );
}

function ScopePanel({ scopeId }: { scopeId: number | null }) {
  const result = useWorkspaceStore((state) => state.result);
  const select = useWorkspaceStore((state) => state.select);
  const table = result?.symbols;

  if (scopeId === null || table === null || table === undefined) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">{SEMA_SCOPE_EMPTY_SELECTION}</p>
    );
  }
  const scope = table.scopes.find((candidate) => candidate.id === scopeId);
  if (scope === undefined) {
    return <p className="text-sm leading-6 text-muted-foreground">{SEMA_SCOPE_EMPTY_SELECTION}</p>;
  }

  const ownerNode = result?.ast?.nodes[scope.ownerNodeId];
  const ownerPos =
    ownerNode !== undefined && result !== null
      ? positionAt(result.source, ownerNode.range.start)
      : null;
  const parentScope = scope.parentId === null ? null : table.scopes.find((c) => c.id === scope.parentId);
  const symbols = scope.symbolIds
    .map((symbolId) => table.symbols[symbolId])
    .filter((symbol): symbol is Symbol => symbol !== undefined);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {SEMA_SCOPE_LABEL}
      </p>
      <Badge variant="outline" className="w-fit border-violet-700/30 bg-violet-50 font-mono text-[0.7rem] text-violet-900">
        {scope.kind}
      </Badge>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="font-medium text-muted-foreground">{SEMA_SCOPE_KIND_LABEL}</dt>
        <dd className="font-mono">{scope.kind}</dd>
        <dt className="font-medium text-muted-foreground">{SEMA_SCOPE_OWNER_LABEL}</dt>
        <dd className="font-mono">
          {ownerNode === undefined
            ? '—'
            : `${ownerNode.kind}${ownerPos !== null ? ` at ${ownerPos.line}:${ownerPos.col}` : ''}`}
        </dd>
        <dt className="font-medium text-muted-foreground">{SEMA_SCOPE_PARENT_LABEL}</dt>
        <dd className="font-mono">
          {parentScope === null || parentScope === undefined
            ? SEMA_SCOPE_NONE
            : parentScope.kind === 'global'
              ? SEMA_SCOPE_GLOBAL_LABEL
              : `${parentScope.kind} #${parentScope.id}`}
        </dd>
      </dl>
      <p className="text-xs font-medium text-muted-foreground">
        {SEMA_SCOPE_SYMBOLS_LABEL} ({symbols.length})
      </p>
      {symbols.length === 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{SEMA_EMPTY_TABLE}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {symbols.map((symbol) => (
            <li key={symbol.id}>
              <button
                type="button"
                onClick={() => select({ kind: 'symbol', symbolId: symbol.id, origin: 'stage' })}
                className="flex w-full items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <code className="font-mono font-medium">{symbol.name}</code>
                <span className="text-muted-foreground">{symbol.kind}</span>
                <span className="ml-auto font-mono text-muted-foreground">
                  {typeToString(symbol.type)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Symbol table rows
// ---------------------------------------------------------------------------

function SymbolRow({ symbol }: { symbol: Symbol }) {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const highlights = useSymbolHighlights();
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

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
        isPrimary && cn('sel-primary', tintClass),
        isRelated && 'sel-related',
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
 * Semantic view (§8): a clickable scope tree (React Flow) plus the symbol
 * table and the shared diagnostics list. Selecting a symbol highlights its
 * declaration and every use across stages.
 */
export function SemanticView() {
  const result = useWorkspaceStore((state) => state.result);
  const [mode, setMode] = useState<'tree' | 'table'>('tree');
  const [selectedScopeId, setSelectedScopeId] = useState<number | null>(null);

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
          <div role="group" aria-label={SEMA_VIEW_MODE_LABEL} className="ml-auto flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={mode === 'tree' ? 'default' : 'outline'}
              aria-pressed={mode === 'tree'}
              onClick={() => setMode('tree')}
            >
              {SEMA_TREE_LABEL}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'table' ? 'default' : 'outline'}
              aria-pressed={mode === 'table'}
              onClick={() => setMode('table')}
            >
              {SEMA_TABLE_LABEL}
            </Button>
          </div>
        </div>

        {result === null ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
            {SEMA_NO_RESULT}
          </div>
        ) : symbols === null ? (
          <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm leading-6 text-muted-foreground">{SEMA_BLOCKED}</p>
          </div>
        ) : mode === 'tree' ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="min-w-0">
              <ScopeTree
                selectedScopeId={selectedScopeId}
                onSelectScope={setSelectedScopeId}
              />
            </div>
            <aside
              aria-label={SEMA_SCOPE_TREE_TITLE}
              className="rounded-md border border-border bg-background p-3"
            >
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {SEMA_SCOPE_TREE_TITLE}
              </h3>
              <ScopePanel scopeId={selectedScopeId} />
            </aside>
          </div>
        ) : symbols.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
            {SEMA_EMPTY_TABLE}
          </div>
        ) : (
          <div
            aria-label={SEMA_SYMBOL_TABLE_TITLE}
            className="overflow-hidden rounded-md border border-border"
          >
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

        {mode === 'tree' && symbols !== null && symbols.length > 0 ? (
          <p className="text-xs leading-5 text-muted-foreground">{SEMA_SCOPE_TREE_HINT}</p>
        ) : null}

        {mode === 'table' && symbols !== null && symbols.length > 0 ? (
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
