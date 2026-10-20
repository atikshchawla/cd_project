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
import { ChevronDown, ChevronRight, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AstGraphData extends Record<string, unknown> {
  label: string;
  title: string;
  isPrimary: boolean;
  isRelated: boolean;
  isDimmed: boolean;
  hasChildren: boolean;
  isCollapsed: boolean;
  onSelect: () => void;
  onToggleCollapse: () => void;
}

export type AstGraphNode = Node<AstGraphData, 'astNode'>;

const AST_NODE_WIDTH = 180;
const AST_NODE_HEIGHT = 44;

export const AST_GRAPH_NODE_WIDTH = AST_NODE_WIDTH;
export const AST_GRAPH_NODE_HEIGHT = AST_NODE_HEIGHT;

function AstFlowNode({ data }: NodeProps<AstGraphNode>) {
  return (
    <div
      title={data.title}
      className={cn(
        'relative flex h-11 w-[180px] items-center gap-1 rounded-md border border-border bg-background px-1.5 text-xs shadow-sm transition-colors',
        data.isPrimary && 'bg-amber-100 font-semibold outline outline-2 -outline-offset-2 outline-amber-700',
        data.isRelated &&
          'bg-sky-50 underline decoration-dashed decoration-sky-700/70 underline-offset-2',
        data.isDimmed && 'opacity-80',
      )}
    >
      {/* Invisible handles so dagre's parent-to-child edges can be drawn. */}
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
      {data.hasChildren ? (
        <button
          type="button"
          aria-label={data.isCollapsed ? 'Expand this node' : 'Collapse this node'}
          aria-expanded={!data.isCollapsed}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleCollapse();
          }}
          className="shrink-0 rounded p-1 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {data.isCollapsed ? (
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
        onClick={(event) => {
          event.stopPropagation();
          data.onSelect();
        }}
        className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {data.label}
      </button>
    </div>
  );
}

const NODE_TYPES = { astNode: AstFlowNode };

export interface GraphCanvasProps {
  nodes: AstGraphNode[];
  edges: Edge[];
  label: string;
}

function GraphCanvasInner({ nodes, edges, label }: GraphCanvasProps) {
  const flow = useReactFlow();

  // Re-fit after every layout (initial mount, collapse/expand) without animation.
  useEffect(() => {
    void flow.fitView({ padding: 0.2, duration: 0 });
  }, [nodes, flow]);

  return (
    <div
      role="group"
      aria-label={label}
      className="relative h-[24rem] w-full overflow-hidden rounded-md border border-border bg-white"
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

export function GraphCanvas(props: GraphCanvasProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
