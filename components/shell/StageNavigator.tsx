'use client';

import {
  Binary,
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  Cpu,
  FileCode2,
  GitBranch,
  Gauge,
  RotateCcw,
  Timer,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Stage } from '@/lib/compiler/types';
import { STAGE_EXPLANATIONS, STAGE_ORDER } from '@/content/explanations';
import { cn } from '@/lib/utils';
import { useWorkspaceStore } from '@/lib/store';
import { deriveStageStatus, type StageStatus } from '@/lib/status';

type NavigatorStatus = StageStatus;

const STAGE_ICONS: Record<Stage, LucideIcon> = {
  source: FileCode2,
  lex: Binary,
  parse: GitBranch,
  sema: CircleCheck,
  ir: Workflow,
  asm: Cpu,
  sim: Gauge,
};

const STATUS_META: Record<NavigatorStatus, { label: string; icon: LucideIcon }> = {
  ready: { label: 'Ready', icon: Circle },
  ok: { label: 'OK', icon: CircleCheck },
  warnings: { label: 'Warnings', icon: TriangleAlert },
  failed: { label: 'Failed', icon: CircleX },
  blocked: { label: 'Blocked', icon: CircleSlash },
  stale: { label: 'Stale', icon: RotateCcw },
  pending: { label: 'Pending', icon: Timer },
};

export function StageNavigator() {
  const activeStage = useWorkspaceStore((state) => state.activeStage);
  const result = useWorkspaceStore((state) => state.result);
  const stale = useWorkspaceStore((state) => state.stale);
  const setActiveStage = useWorkspaceStore((state) => state.setActiveStage);
  const stepMode = useWorkspaceStore((state) => state.stepMode);
  const stepReached = useWorkspaceStore((state) => state.stepReached);

  return (
    <nav aria-label="Compiler stages" className="w-full">
      <ol className="flex items-stretch gap-2 overflow-x-auto pb-1">
        {STAGE_ORDER.map((stage, index) => {
          const stageMeta = STAGE_EXPLANATIONS[stage];
          const StageIcon = STAGE_ICONS[stage];
          const status = deriveStageStatus(stage, result, stale, stepMode ? stepReached : null);
          const statusMeta = STATUS_META[status];
          const isActive = activeStage === stage;

          return (
            <li key={stage} className="flex min-w-[9.5rem] flex-1">
              <button
                type="button"
                onClick={() => setActiveStage(stage)}
                aria-current={isActive ? 'step' : undefined}
                aria-label={`${stageMeta.label}: ${statusMeta.label}`}
                className={cn(
                  'flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  isActive
                    ? 'border-violet-400 bg-violet-50/70 shadow-sm'
                    : 'border-border bg-background/70 hover:bg-muted/60',
                  status === 'pending' && !isActive && 'opacity-75',
                )}
              >
                <span className="flex items-center gap-2">
                  <StageIcon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1 text-[0.7rem] font-medium text-muted-foreground">
                    <statusMeta.icon aria-hidden="true" className="size-3.5" />
                    {statusMeta.label}
                  </span>
                </span>
                <span className="text-sm font-semibold leading-5">
                  {stageMeta.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
