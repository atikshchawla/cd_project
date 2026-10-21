'use client';

import { useEffect } from 'react';
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Layers, Maximize2, Tag, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ScopeNodeData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  isSelected: boolean;
  isDimmed: boolean;
  onSelect: () => void;
}

export interface SymbolNodeData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  isPrimary: boolean;
  isRelated: boolean;
  isDimmed: boolean;
  tintClass: string;
  onSelect: () => void;
}

export type ScopeFlowNode = Node<ScopeNodeData, 'scopeNode'>;
export type SymbolFlowNode = Node<SymbolNodeData, 'symbolNode'>;
export type ScopeTreeNode = ScopeFlowNode | SymbolFlowNode;

export const SCOPE_NODE_WIDTH = 170;
export const SCOPE_NODE_HEIGHT = 48;
export const SYMBOL_NODE_WIDTH = 150;
export const SYMBOL_NODE_HEIGHT = 40;

function ScopeFlowNodeComponent({ data }: NodeProps<ScopeFlowNode>) {
  return (
    <div
      title={data.subtitle}
      className={cn(
        'relative flex h-12 w-[170px] cursor-pointer flex-col justify-center gap-0.5 rounded-md border border-violet-300 bg-violet-50 px-2 text-xs shadow-sm transition-colors hover:bg-violet-100',
        data.isSelected &&
          'font-semibold outline outline-2 -outline-offset-2 outline-violet-600 bg-violet-100',
        data.isDimmed && 'opacity-70',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1 !border-0 !bg-transparent"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!size-1 !border-0 !bg-transparent"
      />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect();
        }}
        className="flex min-w-0 items-center gap-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Layers aria-hidden="true" className="size-3.5 shrink-0 text-violet-700" />
        <span className="truncate font-medium text-violet-950">{data.label}</span>
      </button>
      <span className="truncate pl-5 text-[0.65rem] text-violet-800/80">{data.subtitle}</span>
    </div>
  );
}

function SymbolFlowNodeComponent({ data }: NodeProps<SymbolFlowNode>) {
  return (
    <div
      title={data.subtitle}
      className={cn(
        'relative flex h-10 w-[150px] cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs shadow-sm transition-colors hover:bg-muted/60',
        data.isPrimary && cn('sel-primary', data.tintClass),
        data.isRelated && 'sel-related',
        data.isDimmed && 'opacity-70',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!size-1 !border-0 !bg-transparent"
      />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect();
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Tag aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-[0.75rem] font-medium">{data.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[0.6rem] text-muted-foreground">
          {data.subtitle}
        </span>
      </button>
    </div>
  );
}

const NODE_TYPES = { scopeNode: ScopeFlowNodeComponent, symbolNode: SymbolFlowNodeComponent };

export interface ScopeTreeCanvasProps {
  nodes: ScopeTreeNode[];
  edges: Edge[];
  label: string;
  heightClass?: string;
}

function ScopeTreeCanvasInner({ nodes, edges, label, heightClass }: ScopeTreeCanvasProps) {
  const flow = useReactFlow();

  useEffect(() => {
    void flow.fitView({ padding: 0.2, duration: 0 });
  }, [nodes, flow]);

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'relative w-full overflow-hidden rounded-md border border-border bg-surface',
        heightClass ?? 'h-[24rem]',
      )}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background gap={16} />
      </ReactFlow>
      <div className="absolute top-2 right-2 flex gap-1">
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Zoom out"
          className="size-8 bg-background/90"
          onClick={() => void flow.zoomOut()}
        >
          <ZoomOut aria-hidden="true" className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Zoom in"
          className="size-8 bg-background/90"
          onClick={() => void flow.zoomIn()}
        >
          <ZoomIn aria-hidden="true" className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Reset view"
          className="size-8 bg-background/90"
          onClick={() => void flow.fitView({ padding: 0.2, duration: 0 })}
        >
          <Maximize2 aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function ScopeTreeCanvas(props: ScopeTreeCanvasProps) {
  return (
    <ReactFlowProvider>
      <ScopeTreeCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
