'use client';

import { CircleX, ListStart, Play, StepForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  STEP_THROUGH_DONE,
  STEP_THROUGH_EXIT,
  STEP_THROUGH_FAILED,
  STEP_THROUGH_HINT,
  STEP_THROUGH_NEXT,
  STEP_THROUGH_REACHED,
  STEP_THROUGH_RUN_ALL,
  STEP_THROUGH_START,
  STEP_THROUGH_TITLE,
} from '@/content/explanations';
import { PIPELINE_STAGES } from '@/lib/compiler';
import { STAGE_EXPLANATIONS } from '@/content/explanations';
import { useWorkspaceStore } from '@/lib/store';

/** The step-through bar: run the compiler one stage at a time. */
export function StepThroughBar() {
  const stepMode = useWorkspaceStore((state) => state.stepMode);
  const stepReached = useWorkspaceStore((state) => state.stepReached);
  const result = useWorkspaceStore((state) => state.result);
  const advanceStep = useWorkspaceStore((state) => state.advanceStep);
  const runUntil = useWorkspaceStore((state) => state.runUntil);
  const stopStepThrough = useWorkspaceStore((state) => state.stopStepThrough);

  if (!stepMode) return null;

  const reachedIndex = stepReached === null ? -1 : PIPELINE_STAGES.indexOf(stepReached);
  const nextStage = PIPELINE_STAGES[reachedIndex + 1] ?? null;
  const reachedFailed =
    stepReached !== null && result !== null && result.completed[stepReached] === 'failed';
  const reachedLabel = stepReached === null ? null : STAGE_EXPLANATIONS[stepReached].label;
  const nextLabel = nextStage === null ? null : STAGE_EXPLANATIONS[nextStage].label;
  const lastStage = PIPELINE_STAGES[PIPELINE_STAGES.length - 1];

  return (
    <section
      aria-label={STEP_THROUGH_TITLE}
      className="flex flex-wrap items-center gap-2 rounded-md border border-violet-300 bg-violet-50/70 px-3 py-2"
    >
      <ListStart aria-hidden="true" className="size-4 shrink-0 text-violet-800" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-violet-950">{STEP_THROUGH_TITLE}</p>
        <p className="text-[0.7rem] leading-4 text-violet-900/80">
          {reachedLabel === null ? STEP_THROUGH_HINT : STEP_THROUGH_REACHED(reachedLabel)}
        </p>
      </div>

      {reachedFailed ? (
        <span className="inline-flex items-center gap-1.5 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs font-medium text-rose-900">
          <CircleX aria-hidden="true" className="size-3.5" />
          {STEP_THROUGH_FAILED(reachedLabel ?? '')}
        </span>
      ) : nextStage === null ? (
        <span className="text-xs font-medium text-violet-900">{STEP_THROUGH_DONE}</span>
      ) : (
        <Button type="button" size="sm" onClick={() => advanceStep()}>
          {reachedIndex === -1 ? (
            <Play aria-hidden="true" />
          ) : (
            <StepForward aria-hidden="true" />
          )}
          {reachedIndex === -1 ? STEP_THROUGH_START : STEP_THROUGH_NEXT(nextLabel ?? '')}
        </Button>
      )}

      {!reachedFailed && nextStage !== null && nextStage !== lastStage ? (
        <Button type="button" size="sm" variant="outline" onClick={() => runUntil(lastStage)}>
          {STEP_THROUGH_RUN_ALL}
        </Button>
      ) : null}

      <Button type="button" size="sm" variant="ghost" onClick={() => stopStepThrough()}>
        <X aria-hidden="true" />
        {STEP_THROUGH_EXIT}
      </Button>
    </section>
  );
}
