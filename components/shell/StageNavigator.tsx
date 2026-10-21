'use client';

import {
  Circle,
  CircleCheck,
  CircleSlash,
  CircleX,
  ListStart,
  Play,
  RotateCcw,
  StepForward,
  Timer,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  STEP_THROUGH_DONE,
  STEP_THROUGH_EXIT,
  STEP_THROUGH_FAILED,
  STEP_THROUGH_NEXT,
  STEP_THROUGH_RUN_ALL,
  STEP_THROUGH_START,
  STAGE_EXPLANATIONS,
} from '@/content/explanations';
import { PIPELINE_STAGES } from '@/lib/compiler';
import { useWorkspaceStore } from '@/lib/store';
import { deriveStageStatus, type StageStatus } from '@/lib/status';
import { cn } from '@/lib/utils';
import { STAGE_CONFIG } from './stageConfig';

const STATUS_META: Record<StageStatus, { label: string; icon: LucideIcon }> = {
  ready: { label: 'Ready', icon: Circle },
  ok: { label: 'OK', icon: CircleCheck },
  warnings: { label: 'Warnings', icon: TriangleAlert },
  failed: { label: 'Failed', icon: CircleX },
  blocked: { label: 'Blocked', icon: CircleSlash },
  stale: { label: 'Stale', icon: RotateCcw },
  pending: { label: 'Pending', icon: Timer },
};

/** Inline step-mode transport controls shown on the right of the stepper. */
function StepControls() {
  const stepReached = useWorkspaceStore((state) => state.stepReached);
  const result = useWorkspaceStore((state) => state.result);
  const advanceStep = useWorkspaceStore((state) => state.advanceStep);
  const runUntil = useWorkspaceStore((state) => state.runUntil);
  const stopStepThrough = useWorkspaceStore((state) => state.stopStepThrough);

  const reachedIndex = stepReached === null ? -1 : PIPELINE_STAGES.indexOf(stepReached);
  const nextStage = PIPELINE_STAGES[reachedIndex + 1] ?? null;
  const reachedFailed =
    stepReached !== null && result !== null && result.completed[stepReached] === 'failed';
  const reachedLabel = stepReached === null ? null : STAGE_EXPLANATIONS[stepReached].label;
  const nextLabel = nextStage === null ? null : STAGE_EXPLANATIONS[nextStage].label;
  const lastStage = PIPELINE_STAGES[PIPELINE_STAGES.length - 1];

  return (
    <div
      role="group"
      aria-label="Step-through controls"
      className="flex shrink-0 items-center gap-1.5 border-l border-border pl-2"
    >
      <ListStart aria-hidden="true" className="size-3.5 shrink-0 text-stage-ast" />
      {reachedFailed ? (
        <span
          role="status"
          className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-xs font-medium text-danger"
        >
          <CircleX aria-hidden="true" className="size-3.5" />
          {STEP_THROUGH_FAILED(reachedLabel ?? '')}
        </span>
      ) : nextStage === null ? (
        <span role="status" className="text-xs font-medium text-muted-foreground">
          {STEP_THROUGH_DONE}
        </span>
      ) : (
        <Button type="button" size="sm" className="h-7" onClick={() => advanceStep()}>
          {reachedIndex === -1 ? (
            <Play aria-hidden="true" />
          ) : (
            <StepForward aria-hidden="true" />
          )}
          {reachedIndex === -1 ? STEP_THROUGH_START : STEP_THROUGH_NEXT(nextLabel ?? '')}
        </Button>
      )}

      {!reachedFailed && nextStage !== null && nextStage !== lastStage ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => runUntil(lastStage)}
        >
          {STEP_THROUGH_RUN_ALL}
        </Button>
      ) : null}

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7"
        onClick={() => stopStepThrough()}
        title={STEP_THROUGH_EXIT}
      >
        <X aria-hidden="true" />
        {STEP_THROUGH_EXIT}
      </Button>
    </div>
  );
}

/**
 * The compact stage stepper (≤56px): one chip per pipeline stage with icon,
 * short label and icon+text status, plus step-mode transport controls when
 * step-through is active. Driven entirely by STAGE_CONFIG — never hard-codes
 * the stage count.
 */
export function StageNavigator() {
  const activeStage = useWorkspaceStore((state) => state.activeStage);
  const result = useWorkspaceStore((state) => state.result);
  const stale = useWorkspaceStore((state) => state.stale);
  const setActiveStage = useWorkspaceStore((state) => state.setActiveStage);
  const stepMode = useWorkspaceStore((state) => state.stepMode);
  const stepReached = useWorkspaceStore((state) => state.stepReached);

  return (
    <nav
      aria-label="Compiler stages"
      className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3"
    >
      <ol className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {STAGE_CONFIG.map((stage, index) => {
          const stageMeta = STAGE_EXPLANATIONS[stage.id];
          const StageIcon = stage.icon;
          const status = deriveStageStatus(
            stage.id,
            result,
            stale,
            stepMode ? stepReached : null,
          );
          const statusMeta = STATUS_META[status];
          const isActive = activeStage === stage.id;

          return (
            <li key={stage.id} className="flex">
              <button
                type="button"
                onClick={() => setActiveStage(stage.id)}
                aria-current={isActive ? 'step' : undefined}
                aria-label={`${stageMeta.label}, step ${index + 1} of ${STAGE_CONFIG.length}: ${statusMeta.label}`}
                className={cn(
                  'flex h-10 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  isActive
                    ? `${stage.activeClass} font-medium shadow-sm`
                    : 'border-transparent hover:bg-muted/60',
                  status === 'pending' && !isActive && 'opacity-75',
                )}
              >
                <StageIcon
                  aria-hidden="true"
                  className="size-4 shrink-0"
                  style={{ color: `var(${stage.hueVar})` }}
                />
                <span className="text-xs">{stageMeta.shortLabel}</span>
                <span
                  className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground"
                  title={statusMeta.label}
                >
                  <statusMeta.icon aria-hidden="true" className="size-3" />
                  {statusMeta.label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {stepMode ? <StepControls /> : null}
    </nav>
  );
}
