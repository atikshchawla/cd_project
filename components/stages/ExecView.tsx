'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Cpu,
  Gauge,
  MemoryStick,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  StepForward,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import { scrollWithinBox } from '@/components/common/scrollWithinBox';
import {
  EXEC_BLOCKED,
  EXEC_CURRENT_INSTRUCTION,
  EXEC_DATA_EMPTY,
  EXEC_DATA_TITLE,
  EXEC_FRAME_BYTES,
  EXEC_HEAP_EMPTY,
  EXEC_HEAP_TITLE,
  EXEC_JUST_ALLOCATED,
  EXEC_JUST_WRITTEN,
  EXEC_MEMORY_TITLE,
  EXEC_NO_INSTRUCTION,
  EXEC_NO_RESULT,
  EXEC_OUTCOME_ERROR,
  EXEC_OUTCOME_FINISHED,
  EXEC_OUTCOME_NO_MAIN,
  EXEC_OUTCOME_STEP_LIMIT,
  EXEC_PAUSE_LABEL,
  EXEC_RESET_LABEL,
  EXEC_RESULT_RUNNING,
  EXEC_RESULT_TITLE,
  EXEC_RESULT_VALUE,
  EXEC_RESULT_VOID,
  EXEC_RUN_LABEL,
  EXEC_RELEASED_FRAME,
  EXEC_RELEASED_TITLE,
  EXEC_SLOT_COUNT,
  EXEC_STACK_DEPTH,
  EXEC_STACK_EMPTY,
  EXEC_STACK_TITLE,
  EXEC_STEP_BACK_LABEL,
  EXEC_STEP_LABEL,
  EXEC_STEP_OF,
  EXEC_TRACE_EMPTY,
  EXEC_TRACE_TITLE,
} from '@/content/explanations';
import { simulate, type SimFrame, type SimSlot, type SimulationResult } from '@/lib/compiler/simulate';
import { useWorkspaceStore } from '@/lib/store';
import { cn } from '@/lib/utils';

function showValue(value: number): string {
  return `${value} (0x${(value >>> 0).toString(16)})`;
}

function slotRows(frame: SimFrame): SimSlot[] {
  return Object.values(frame.slots).sort((a, b) => {
    const aVar = a.varName ?? '';
    const bVar = b.varName ?? '';
    if (aVar !== bVar) return aVar.localeCompare(bVar);
    return a.name.localeCompare(b.name);
  });
}

function FrameCard({
  frame,
  stepIndex,
  isCurrent,
}: {
  frame: SimFrame;
  stepIndex: number;
  isCurrent: boolean;
}) {
  const rows = slotRows(frame);
  const bytes = rows.length * 4;

  return (
    <div
      className={cn(
        'rounded-md border p-2 transition-colors',
        isCurrent ? 'border-violet-400 bg-violet-50/70' : 'border-border bg-background',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            'font-mono text-[0.7rem]',
            isCurrent && 'border-violet-700/40 bg-violet-100 text-violet-900',
          )}
        >
          {frame.funcName}
        </Badge>
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          {EXEC_FRAME_BYTES(bytes)} · {EXEC_SLOT_COUNT(rows.length)}
        </span>
        {isCurrent ? (
          <span className="ml-auto text-[0.65rem] font-medium text-violet-800">executing</span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">no cells yet</p>
      ) : (
        <table className="mt-1 w-full text-left font-mono text-[0.7rem]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-0.5 pr-2 font-medium">cell</th>
              <th className="py-0.5 pr-2 font-medium">4 bytes</th>
              <th className="py-0.5 font-medium">value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((slot) => {
              const justAllocated = slot.allocatedAt === stepIndex;
              const justWritten = !justAllocated && slot.updatedAt === stepIndex;
              return (
                <tr
                  key={slot.name}
                  className={cn(
                    'border-t border-border/50',
                    justAllocated && 'bg-emerald-100/80',
                    justWritten && 'bg-sky-100/80',
                  )}
                >
                  <td className="py-0.5 pr-2">
                    {slot.varName ?? slot.name}
                    {slot.varName !== undefined && slot.varName !== slot.name ? (
                      <span className="text-muted-foreground"> {slot.name}</span>
                    ) : null}
                  </td>
                  <td className="py-0.5 pr-2 text-muted-foreground">4 B</td>
                  <td className="py-0.5">
                    {showValue(slot.value)}
                    {justAllocated ? (
                      <span className="ml-1 rounded bg-emerald-200 px-1 text-[0.6rem] font-semibold text-emerald-900">
                        {EXEC_JUST_ALLOCATED}
                      </span>
                    ) : null}
                    {justWritten ? (
                      <span className="ml-1 rounded bg-sky-200 px-1 text-[0.6rem] font-semibold text-sky-900">
                        {EXEC_JUST_WRITTEN}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReleasedFrameCard({ frame }: { frame: SimFrame }) {
  const rows = slotRows(frame);
  const bytes = rows.length * 4;
  return (
    <div className="rounded-md border border-dashed border-rose-300 bg-rose-50/60 p-2 opacity-80">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="border-rose-700/30 bg-rose-100 font-mono text-[0.7rem] text-rose-900 line-through"
        >
          {frame.funcName}
        </Badge>
        <span className="text-[0.65rem] font-medium text-rose-900">
          {EXEC_RELEASED_TITLE} — {EXEC_RELEASED_FRAME(frame.funcName, bytes)}
        </span>
      </div>
    </div>
  );
}

function MemoryMap({
  simulation,
  stepIndex,
}: {
  simulation: SimulationResult;
  stepIndex: number;
}) {
  const state = simulation.steps[stepIndex]?.state;
  const globals = Object.entries(state?.globals ?? {});
  const stackBytes = (state?.frames ?? []).reduce(
    (total, frame) => total + Object.keys(frame.slots).length * 4,
    0,
  );

  return (
    <section
      aria-label={EXEC_MEMORY_TITLE}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <MemoryStick aria-hidden="true" className="size-3.5" />
        {EXEC_MEMORY_TITLE}
      </h3>

      <div className="rounded border border-teal-300 bg-teal-50/60 p-2">
        <p className="text-[0.7rem] font-semibold text-teal-900">{EXEC_DATA_TITLE}</p>
        {globals.length === 0 ? (
          <p className="mt-1 text-xs text-teal-900/80">{EXEC_DATA_EMPTY}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[0.7rem] text-teal-950">
            {globals.map(([name, value]) => (
              <li key={name}>
                @{name} = {showValue(value)}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded border border-border bg-muted/30 p-2">
        <p className="text-[0.7rem] font-semibold text-muted-foreground">{EXEC_HEAP_TITLE}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{EXEC_HEAP_EMPTY}</p>
      </div>

      <div className="rounded border border-violet-300 bg-violet-50/60 p-2">
        <p className="text-[0.7rem] font-semibold text-violet-900">{EXEC_STACK_TITLE}</p>
        <p className="mt-1 font-mono text-[0.7rem] text-violet-950">
          {EXEC_STACK_DEPTH(state?.frames.length ?? 0)} · {EXEC_FRAME_BYTES(stackBytes)} occupied
        </p>
      </div>
    </section>
  );
}

/**
 * Execution (VM) view: step through the generated IR on a small simulated
 * machine, watching frames and cells occupy and release stack space and the
 * result appear when main returns.
 */
export function ExecView() {
  const result = useWorkspaceStore((state) => state.result);
  const stale = useWorkspaceStore((state) => state.stale);

  const simulation = useMemo(
    () => (result?.ir === null || result?.ir === undefined ? null : simulate(result.ir.module)),
    [result],
  );

  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [trackedSimulation, setTrackedSimulation] = useState(simulation);
  const traceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const traceRef = useRef<HTMLDivElement | null>(null);

  // A new compile produces a new trace: rewind to its first step.
  if (trackedSimulation !== simulation) {
    setTrackedSimulation(simulation);
    setStepIndex(0);
    setPlaying(false);
  }

  const totalSteps = simulation?.steps.length ?? 0;
  const clampedIndex = Math.min(stepIndex, Math.max(totalSteps - 1, 0));
  const current = simulation?.steps[clampedIndex] ?? null;
  const finished = simulation?.outcome === 'finished';

  useEffect(() => {
    if (!playing || simulation === null) return;
    const timer = window.setTimeout(() => {
      if (clampedIndex >= totalSteps - 1) {
        setPlaying(false);
        return;
      }
      setStepIndex(clampedIndex + 1);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [playing, clampedIndex, totalSteps, simulation]);

  useEffect(() => {
    scrollWithinBox(traceRef.current, traceRefs.current[clampedIndex] ?? null);
  }, [clampedIndex]);

  if (result === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {EXEC_NO_RESULT}
      </div>
    );
  }

  if (result.ir === null) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
        <Cpu aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">{EXEC_BLOCKED}</p>
      </div>
    );
  }

  if (simulation === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {EXEC_NO_RESULT}
      </div>
    );
  }

  const currentIrLine =
    current?.instrId !== null && current?.instrId !== undefined
      ? result.ir.lines.find((line) => line.instrId === current.instrId)
      : undefined;

  const outcomeMeta =
    simulation.outcome === 'finished'
      ? { label: EXEC_OUTCOME_FINISHED, className: 'border-emerald-700/30 bg-emerald-50 text-emerald-900' }
      : simulation.outcome === 'step-limit'
        ? { label: EXEC_OUTCOME_STEP_LIMIT, className: 'border-amber-700/30 bg-amber-50 text-amber-900' }
        : simulation.outcome === 'no-main'
          ? { label: EXEC_OUTCOME_NO_MAIN, className: 'border-amber-700/30 bg-amber-50 text-amber-900' }
          : { label: EXEC_OUTCOME_ERROR, className: 'border-red-700/30 bg-red-50 text-red-900' };

  const frames = current?.state.frames ?? [];
  const poppedFrame = current?.poppedFrame ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="simulated" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {EXEC_STEP_OF(clampedIndex, totalSteps)}
        </Badge>
        <Badge variant="outline" className={cn('font-mono text-[0.7rem]', outcomeMeta.className)}>
          {outcomeMeta.label}
        </Badge>
      </div>

      {stale ? (
        <p
          role="status"
          className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
        >
          The source changed after this execution trace was recorded. Recompile to refresh it.
        </p>
      ) : null}

      {simulation.message !== null ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {simulation.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setPlaying(false);
            setStepIndex((index) => Math.max(0, index - 1));
          }}
          disabled={clampedIndex <= 0}
        >
          <SkipBack aria-hidden="true" />
          {EXEC_STEP_BACK_LABEL}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setPlaying(false);
            setStepIndex((index) => Math.min(totalSteps - 1, index + 1));
          }}
          disabled={clampedIndex >= totalSteps - 1}
        >
          <StepForward aria-hidden="true" />
          {EXEC_STEP_LABEL}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => setPlaying((value) => !value)}
          disabled={clampedIndex >= totalSteps - 1 && !playing}
        >
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {playing ? EXEC_PAUSE_LABEL : EXEC_RUN_LABEL}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setPlaying(false);
            setStepIndex(0);
          }}
          disabled={clampedIndex <= 0}
        >
          <RotateCcw aria-hidden="true" />
          {EXEC_RESET_LABEL}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Gauge aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">
            {clampedIndex} / {Math.max(totalSteps - 1, 0)}
          </span>
        </div>
      </div>

      <section
        aria-label={EXEC_CURRENT_INSTRUCTION}
        className="flex flex-col gap-1.5 rounded-md border border-border p-3"
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {EXEC_CURRENT_INSTRUCTION}
        </h3>
        <p className="text-sm leading-6">{current?.description ?? EXEC_NO_INSTRUCTION}</p>
        {currentIrLine !== undefined ? (
          <code className="w-fit max-w-full overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-sm">
            {currentIrLine.text}
          </code>
        ) : null}
        {current !== null && (current.kind === 'call' || current.kind === 'start' || current.kind === 'ret') ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Stack frames now: {frames.length}.{' '}
            {current.kind === 'ret' && poppedFrame !== null
              ? `A frame was just released (${EXEC_FRAME_BYTES(Object.keys(poppedFrame.slots).length * 4)}).`
              : current.kind === 'call'
                ? 'A frame was just pushed.'
                : ''}
          </p>
        ) : null}
        {finished && clampedIndex === totalSteps - 1 ? (
          <p className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-900">
            <span className="font-semibold">{EXEC_RESULT_TITLE}: </span>
            {simulation.result === null
              ? EXEC_RESULT_VOID
              : EXEC_RESULT_VALUE(simulation.result)}
          </p>
        ) : null}
      </section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section aria-label={EXEC_STACK_TITLE} className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Cpu aria-hidden="true" className="size-3.5" />
            {EXEC_STACK_TITLE} — top of stack first
          </h3>
          {poppedFrame !== null ? <ReleasedFrameCard frame={poppedFrame} /> : null}
          {frames.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              {EXEC_STACK_EMPTY}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {[...frames].reverse().map((frame, reverseIndex) => (
                <FrameCard
                  key={`${frame.funcName}-${frames.length - reverseIndex}`}
                  frame={frame}
                  stepIndex={clampedIndex}
                  isCurrent={reverseIndex === 0}
                />
              ))}
            </div>
          )}
          <MemoryMap simulation={simulation} stepIndex={clampedIndex} />
        </section>

        <section aria-label={EXEC_TRACE_TITLE} className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {EXEC_TRACE_TITLE}
          </h3>
          {simulation.steps.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
              {EXEC_TRACE_EMPTY}
            </div>
          ) : (
            <div
              ref={traceRef}
              className="max-h-[26rem] overflow-y-auto rounded-md border border-border"
            >
              {simulation.steps.map((step) => {
                const isCurrentStep = step.index === clampedIndex;
                const kindTone =
                  step.kind === 'call'
                    ? 'text-violet-700'
                    : step.kind === 'ret'
                      ? 'text-rose-700'
                      : step.kind === 'branch'
                        ? 'text-sky-700'
                        : step.kind === 'start'
                          ? 'text-violet-700'
                          : 'text-foreground';
                return (
                  <button
                    key={step.index}
                    ref={(element) => {
                      traceRefs.current[step.index] = element;
                    }}
                    type="button"
                    aria-current={isCurrentStep ? 'step' : undefined}
                    onClick={() => {
                      setPlaying(false);
                      setStepIndex(step.index);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 border-b border-border/60 px-2 py-1 text-left text-xs leading-5 transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      isCurrentStep && 'bg-violet-100 font-semibold outline outline-2 -outline-offset-2 outline-violet-600',
                    )}
                  >
                    <span className="w-8 shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                      #{step.index}
                    </span>
                    <span className={cn('w-10 shrink-0 font-mono text-[0.65rem] uppercase', kindTone)}>
                      {step.kind}
                    </span>
                    <span className="min-w-0 flex-1 font-mono text-[0.7rem]">{step.description}</span>
                  </button>
                );
              })}
            </div>
          )}
          {simulation.outcome === 'finished' && simulation.result !== null ? (
            <p className="rounded-md border border-emerald-700/30 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">
              <span className="font-semibold">{EXEC_RESULT_TITLE}: </span>
              {EXEC_RESULT_VALUE(simulation.result)}
            </p>
          ) : simulation.outcome === 'finished' ? (
            <p className="rounded-md border border-emerald-700/30 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">
              {EXEC_RESULT_VOID}
            </p>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">{EXEC_RESULT_RUNNING}</p>
          )}
        </section>
      </div>
    </div>
  );
}
