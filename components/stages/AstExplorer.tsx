'use client';

import { useCallback, useMemo, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  GraphCanvas,
  AST_GRAPH_NODE_HEIGHT,
  AST_GRAPH_NODE_WIDTH,
  type AstGraphNode,
} from '@/components/common/GraphCanvas';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import {
  AST_BLOCKED,
  AST_EMPTY,
  AST_EXPAND_ALL,
  AST_GRAPH_LABEL,
  AST_KIND_EXPLANATIONS,
  AST_MODE_LABEL,
  AST_NODE_CHILDREN_LABEL,
  AST_NODE_KIND_LABEL,
  AST_NODE_NAME_LABEL,
  AST_NODE_NOT_FOUND,
  AST_NODE_OP_LABEL,
  AST_NODE_RANGE_LABEL,
  AST_NODE_TYPE_LABEL,
  AST_NO_RESULT,
  AST_OUTLINE_LABEL,
  AST_PANEL_TITLE,
  AST_PARSE_FAILED,
  STALE_SELECTION_NOTE,
  astChildCountLabel,
  astNodeCountLabel,
} from '@/content/explanations';
import { computeHighlights, createEmptyHighlights } from '@/lib/highlight';
import { positionAt } from '@/lib/positions';
import { useWorkspaceStore } from '@/lib/store';
import type { Ast, AstNode, Type } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

type ViewMode = 'graph' | 'outline';

function nodeEmphasisClass(isPrimary: boolean, isRelated: boolean, hasFocus: boolean): string {
  return cn(
    'rounded px-2 py-1 text-left text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    isPrimary &&
      'bg-amber-100 font-semibold outline outline-2 -outline-offset-2 outline-amber-700',
    isRelated &&
      'bg-sky-50 underline decoration-dashed decoration-sky-700/70 underline-offset-2',
    !isPrimary && !isRelated && hasFocus && 'bg-muted/60',
  );
}

function nodeLabel(node: AstNode): string {
  const meta = AST_KIND_EXPLANATIONS[node.kind];
  const detail =
    node.name ?? node.op ?? (node.value !== undefined ? String(node.value) : null);
  return detail === null ? meta.label : `${meta.label} ${detail}`;
}

function formatType(type: Type): string {
  if (type.kind === 'function') {
    return `function returning ${formatType(type.ret)} (${type.params
      .map(formatType)
      .join(', ')})`;
  }
  return type.kind;
}

interface AstOutlineProps {
  ast: Ast;
  source: string;
  collapsed: Set<number>;
  primaryNodeId: number | null;
  relatedNodeIds: Set<number>;
  selectedNodeId: number | null;
  onToggle: (nodeId: number) => void;
  onSelect: (nodeId: number) => void;
}

function AstOutline({
  ast,
  source,
  collapsed,
  primaryNodeId,
  relatedNodeIds,
  selectedNodeId,
  onToggle,
  onSelect,
}: AstOutlineProps) {
  const renderNode = (nodeId: number) => {
    const node = ast.nodes[nodeId];
    if (node === undefined) return null;
    const meta = AST_KIND_EXPLANATIONS[node.kind];
    const hasChildren = node.childIds.length > 0;
    const isCollapsed = collapsed.has(nodeId);
    const position = positionAt(source, node.range.start);
    const isPrimary = primaryNodeId === nodeId;
    const isRelated = !isPrimary && relatedNodeIds.has(nodeId);
    const isDimmed =
      (primaryNodeId !== null || relatedNodeIds.size > 0) &&
      !isPrimary &&
      !isRelated;

    return (
      <li key={nodeId} className="flex flex-col">
        <div className="flex items-center gap-0.5">
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${meta.label}`}
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(nodeId)}
              className="shrink-0 rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {isCollapsed ? (
                <ChevronRight aria-hidden="true" className="size-3.5" />
              ) : (
                <ChevronDown aria-hidden="true" className="size-3.5" />
              )}
            </button>
          ) : (
            <span aria-hidden="true" className="size-6 shrink-0" />
          )}
          <button
            type="button"
            aria-current={selectedNodeId === nodeId ? 'true' : undefined}
            title={nodeLabel(node)}
            onClick={() => onSelect(nodeId)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2',
              nodeEmphasisClass(isPrimary, isRelated, false),
              isDimmed && 'opacity-80',
            )}
          >
            <span className="truncate font-medium">{meta.label}</span>
            {node.name !== undefined ? (
              <code className="truncate font-mono text-[0.7rem]">{node.name}</code>
            ) : null}
            {node.op !== undefined ? (
              <code className="font-mono text-[0.7rem] text-foreground/70">{node.op}</code>
            ) : null}
            <span className="ml-auto shrink-0 font-mono text-[0.7rem] text-foreground/70">
              {position.line}:{position.col}
            </span>
          </button>
        </div>
        {hasChildren && !isCollapsed ? (
          <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-2">
            {node.childIds.map(renderNode)}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <ul aria-label={AST_OUTLINE_LABEL} className="flex flex-col gap-0.5">
      {renderNode(ast.rootId)}
    </ul>
  );
}

interface AstNodePanelProps {
  ast: Ast | null;
  source: string;
  nodeId: number | null;
}

function AstNodePanel({ ast, source, nodeId }: AstNodePanelProps) {
  if (nodeId === null || ast === null) {
    return <p className="text-sm leading-6 text-muted-foreground">{AST_EMPTY}</p>;
  }
  const node = ast.nodes[nodeId];
  if (node === undefined) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">{AST_NODE_NOT_FOUND}</p>
    );
  }

  const meta = AST_KIND_EXPLANATIONS[node.kind];
  const start = positionAt(source, node.range.start);
  const end = positionAt(source, node.range.end);

  return (
    <div className="flex flex-col gap-2">
      <Badge variant="outline" className="w-fit font-mono text-[0.7rem]">
        {meta.label}
      </Badge>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="font-medium text-muted-foreground">{AST_NODE_KIND_LABEL}</dt>
        <dd className="font-mono">{node.kind}</dd>
        <dt className="font-medium text-muted-foreground">{AST_NODE_RANGE_LABEL}</dt>
        <dd className="font-mono">
          {start.line}:{start.col}–{end.line}:{end.col}
        </dd>
        {node.name !== undefined ? (
          <>
            <dt className="font-medium text-muted-foreground">{AST_NODE_NAME_LABEL}</dt>
            <dd>
              <code className="font-mono">{node.name}</code>
            </dd>
          </>
        ) : null}
        {node.op !== undefined ? (
          <>
            <dt className="font-medium text-muted-foreground">{AST_NODE_OP_LABEL}</dt>
            <dd>
              <code className="font-mono">{node.op}</code>
            </dd>
          </>
        ) : null}
        {node.type !== undefined ? (
          <>
            <dt className="font-medium text-muted-foreground">{AST_NODE_TYPE_LABEL}</dt>
            <dd className="font-mono">{formatType(node.type)}</dd>
          </>
        ) : null}
        <dt className="font-medium text-muted-foreground">{AST_NODE_CHILDREN_LABEL}</dt>
        <dd className="font-mono">{astChildCountLabel(node.childIds.length)}</dd>
      </dl>
      <p className="text-sm leading-6">{meta.simple}</p>
    </div>
  );
}

export function AstExplorer() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const select = useWorkspaceStore((state) => state.select);
  const [mode, setMode] = useState<ViewMode>('graph');
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const ast = result?.ast ?? null;
  const source = result?.source ?? '';
  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );
  const primaryNodeId = highlights.primary?.stage === 'parse' ? highlights.primary.id : null;
  const relatedNodeIds = highlights.astNodeIds;
  const selectedNodeId = selection.kind === 'ast' ? selection.nodeId : null;
  const nodeCount = ast === null ? 0 : Object.keys(ast.nodes).length;

  const toggleCollapse = useCallback((nodeId: number) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const selectNode = useCallback(
    (nodeId: number) => {
      select({ kind: 'ast', nodeId, origin: 'stage' });
    },
    [select],
  );

  const layout = useMemo(() => {
    if (ast === null) return null;

    const visibleIds: number[] = [];
    const edges: { id: string; source: string; target: string }[] = [];
    const queue = [ast.rootId];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      visibleIds.push(nodeId);
      if (collapsed.has(nodeId)) continue;
      for (const childId of ast.nodes[nodeId]?.childIds ?? []) {
        edges.push({ id: `e${nodeId}-${childId}`, source: String(nodeId), target: String(childId) });
        queue.push(childId);
      }
    }

    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'TB', nodesep: 16, ranksep: 32, marginx: 8, marginy: 8 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const nodeId of visibleIds) {
      graph.setNode(String(nodeId), {
        width: AST_GRAPH_NODE_WIDTH,
        height: AST_GRAPH_NODE_HEIGHT,
      });
    }
    for (const edge of edges) graph.setEdge(edge.source, edge.target);
    dagre.layout(graph);

    const nodes: AstGraphNode[] = visibleIds.map((nodeId) => {
      const node = ast.nodes[nodeId];
      const position = graph.node(String(nodeId));
      const label = nodeLabel(node);
      const isPrimary = primaryNodeId === nodeId;
      const isRelated = !isPrimary && relatedNodeIds.has(nodeId);
      const isDimmed =
        (primaryNodeId !== null || relatedNodeIds.size > 0) && !isPrimary && !isRelated;

      return {
        id: String(nodeId),
        type: 'astNode',
        position: {
          x: (position?.x ?? 0) - AST_GRAPH_NODE_WIDTH / 2,
          y: (position?.y ?? 0) - AST_GRAPH_NODE_HEIGHT / 2,
        },
        data: {
          label,
          title: `${label} (${node.kind} #${nodeId})`,
          isPrimary,
          isRelated,
          isDimmed,
          hasChildren: node.childIds.length > 0,
          isCollapsed: collapsed.has(nodeId),
          onSelect: () => selectNode(nodeId),
          onToggleCollapse: () => toggleCollapse(nodeId),
        },
      };
    });

    return { nodes, edges };
  }, [ast, collapsed, primaryNodeId, relatedNodeIds, selectNode, toggleCollapse]);

  const emptyMessage =
    result === null
      ? AST_NO_RESULT
      : result.completed.lex === 'failed'
        ? AST_BLOCKED
        : AST_PARSE_FAILED;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="generated" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {astNodeCountLabel(nodeCount)}
        </Badge>
        {ast !== null ? (
          <div role="group" aria-label={AST_MODE_LABEL} className="ml-auto flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={mode === 'graph' ? 'default' : 'outline'}
              aria-pressed={mode === 'graph'}
              onClick={() => setMode('graph')}
            >
              {AST_GRAPH_LABEL}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'outline' ? 'default' : 'outline'}
              aria-pressed={mode === 'outline'}
              onClick={() => setMode('outline')}
            >
              {AST_OUTLINE_LABEL}
            </Button>
          </div>
        ) : null}
        {ast !== null && mode === 'graph' ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setCollapsed(new Set())}>
            {AST_EXPAND_ALL}
          </Button>
        ) : null}
      </div>

      {stale ? (
        <p
          role="status"
          className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
        >
          {STALE_SELECTION_NOTE}
        </p>
      ) : null}

      {ast === null || layout === null ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className={cn('min-w-0', stale && 'bg-muted/20')}>
            {mode === 'graph' ? (
              <GraphCanvas
                nodes={layout.nodes}
                edges={layout.edges}
                label={`${AST_GRAPH_LABEL} — ${AST_KIND_EXPLANATIONS.TranslationUnit.label}`}
              />
            ) : (
              <div className="h-[24rem] overflow-auto rounded-md border border-border p-2">
                <AstOutline
                  ast={ast}
                  source={source}
                  collapsed={collapsed}
                  primaryNodeId={primaryNodeId}
                  relatedNodeIds={relatedNodeIds}
                  selectedNodeId={selectedNodeId}
                  onToggle={toggleCollapse}
                  onSelect={selectNode}
                />
              </div>
            )}
          </div>
          <aside
            aria-label={AST_PANEL_TITLE}
            className="rounded-md border border-border bg-background p-3"
          >
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {AST_PANEL_TITLE}
            </h3>
            <AstNodePanel ast={ast} source={source} nodeId={selectedNodeId} />
          </aside>
        </div>
      )}
    </div>
  );
}

export default AstExplorer;
