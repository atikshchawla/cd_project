'use client';

import dynamic from 'next/dynamic';
import { CircleSlash, FileCode2, Loader, Play } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StageErrorBoundary } from '@/components/common/StageErrorBoundary';
import {
  BLOCKED_NO_ERROR_LINK,
  BLOCKED_SELECT_FIRST_ERROR,
  COMPILE_IN_PROGRESS,
  COMPILE_IN_PROGRESS_DETAIL,
  EMPTY_WORKSPACE,
  STAGE_EXPLANATIONS,
  STEP_NOT_RUN_BODY,
  STEP_NOT_RUN_RUN_NEXT,
  STEP_NOT_RUN_RUN_THIS,
  STEP_NOT_RUN_TITLE,
  blockedStageMessage,
} from '@/content/explanations';
import { PIPELINE_STAGES } from '@/lib/compiler';
import { useWorkspaceStore } from '@/lib/store';
import { deriveStageStatus, type StageStatus } from '@/lib/status';
import type { Diagnostic, Stage } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';
import { TokenExplorer } from '@/components/stages/TokenExplorer';

const ALL_STAGES: Stage[] = ['source', 'lex', 'parse', 'sema', 'ir', 'opt', 'asm', 'sim'];

const AstExplorer = dynamic(() => import('@/components/stages/AstExplorer'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
      Loading the syntax tree…
    </div>
  ),
});

const SemanticView = dynamic(
  () => import('@/components/stages/SemanticView').then((module) => ({ default: module.SemanticView })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        Loading the scope tree…
      </div>
    ),
  },
);

const IrView = dynamic(
  () => import('@/components/stages/IrView').then((module) => ({ default: module.IrView })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        Loading the IR view…
      </div>
    ),
  },
);

const OptView = dynamic(
  () => import('@/components/stages/OptView').then((module) => ({ default: module.OptView })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        Loading the optimisation view…
      </div>
    ),
  },
);

const AssemblyView = dynamic(
  () => import('@/components/stages/AssemblyView').then((module) => ({ default: module.AssemblyView })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        Loading the assembly view…
      </div>
    ),
  },
);

const ExecView = dynamic(
  () => import('@/components/stages/ExecView').then((module) => ({ default: module.ExecView })),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        Loading the execution view…
      </div>
    ),
  },
);

function SourceOverview({ source }: { source: string }) {
  const lines = source.length === 0 ? 0 : source.split('\n').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
        <FileCode2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">
          The compiler receives exactly the text in the editor. Line endings are normalised to LF
          before any later stage runs, and every artifact points back into this text with character
          offsets.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Characters
          </dt>
          <dd className="mt-1 font-mono text-lg">{source.length}</dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Lines
          </dt>
          <dd className="mt-1 font-mono text-lg">{lines}</dd>
        </div>
        <div className="rounded-md border border-border p-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            State
          </dt>
          <dd className="mt-1 text-sm font-medium">
            {source.length === 0 ? 'Empty' : 'Ready'}
          </dd>
        </div>
      </dl>

      {source.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">{EMPTY_WORKSPACE}</p>
      ) : null}
    </div>
  );
}

/** Find the first error diagnostic so a blocked stage can link to it. */
function firstErrorDiagnostic(diagnostics: Diagnostic[]): Diagnostic | null {
  return diagnostics.find((diagnostic) => diagnostic.severity === 'error') ?? null;
}

/** The stage whose failure blocks the given stage, per the status table. */
function blockingStageFor(stage: Stage, statuses: Record<Stage, StageStatus>): Stage | null {
  const order: Stage[] = ALL_STAGES.filter((candidate) => candidate !== 'source');
  const index = order.indexOf(stage);
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const stageName = order[candidate];
    if (statuses[stageName] === 'failed') return stageName;
  }
  return null;
}

function BlockedStage({ stage, statuses }: { stage: Stage; statuses: Record<Stage, StageStatus> }) {
  const result = useWorkspaceStore((state) => state.result);
  const select = useWorkspaceStore((state) => state.select);

  const blocking = blockingStageFor(stage, statuses);
  const blockingLabel =
    blocking === null ? 'An earlier stage' : STAGE_EXPLANATIONS[blocking].label;
  const firstError = result === null ? null : firstErrorDiagnostic(result.diagnostics);

  return (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 rounded-md border border-dashed border-border bg-muted/20 p-6">
      <div className="flex items-center gap-2">
        <CircleSlash aria-hidden="true" className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">{blockedStageMessage(stageLabelFor(stage), blockingLabel)}</p>
      </div>
      {firstError !== null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            select({ kind: 'diagnostic', diagnosticId: firstError.id, origin: 'stage' })
          }
        >
          {BLOCKED_SELECT_FIRST_ERROR}
        </Button>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">{BLOCKED_NO_ERROR_LINK}</p>
      )}
    </div>
  );
}

/** Step-through mode: this stage has simply not run yet. */
function NotRunStage({ stage }: { stage: Stage }) {
  const advanceStep = useWorkspaceStore((state) => state.advanceStep);
  const runUntil = useWorkspaceStore((state) => state.runUntil);
  const stepReached = useWorkspaceStore((state) => state.stepReached);
  const label = stageLabelFor(stage);

  const reachedIndex = stepReached === null ? -1 : PIPELINE_STAGES.indexOf(stepReached);
  // Derived stages are not steps of their own: the Optimization stage is run
  // as soon as its base stage (the IR) has run.
  const target = stage === 'opt' ? 'ir' : stage;
  const stageIndex = PIPELINE_STAGES.indexOf(target);
  const isNext = stageIndex === reachedIndex + 1;

  return (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 rounded-md border border-dashed border-violet-400 bg-violet-50/50 p-6">
      <div className="flex items-center gap-2">
        <Play aria-hidden="true" className="size-5 text-violet-700" />
        <p className="text-sm font-medium">{STEP_NOT_RUN_TITLE}</p>
      </div>
      <p className="max-w-md text-xs leading-5 text-muted-foreground">{STEP_NOT_RUN_BODY(label)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => advanceStep()} disabled={!isNext}>
          {STEP_NOT_RUN_RUN_NEXT}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => runUntil(target)}>
          {STEP_NOT_RUN_RUN_THIS(label)}
        </Button>
      </div>
    </div>
  );
}

function stageLabelFor(stage: Stage): string {
  return STAGE_EXPLANATIONS[stage].label;
}

export function StageWorkspace() {
  const activeStage = useWorkspaceStore((state) => state.activeStage);
  const source = useWorkspaceStore((state) => state.source);
  const compileStatus = useWorkspaceStore((state) => state.compileStatus);
  const stale = useWorkspaceStore((state) => state.stale);
  const result = useWorkspaceStore((state) => state.result);
  const stepMode = useWorkspaceStore((state) => state.stepMode);
  const stepReached = useWorkspaceStore((state) => state.stepReached);
  const stage = STAGE_EXPLANATIONS[activeStage];
  const stageIndex = ALL_STAGES.indexOf(activeStage) + 1;

  const statuses = Object.fromEntries(
    ALL_STAGES.map((name) => [
      name,
      deriveStageStatus(name, result, stale, stepMode ? stepReached : null),
    ]),
  ) as Record<Stage, StageStatus>;
  const status = statuses[activeStage];
  // Blocked only after a compile (spec §8); before the first compile stages
  // show their empty states. In step-through mode, un-reached stages invite
  // the next step instead of claiming to be blocked.
  const isBlocked = result !== null && status === 'blocked';
  const isPending = result !== null && status === 'pending';

  return (
    <section
      aria-labelledby="stage-workspace-heading"
      className={cn(
        'flex min-h-[26rem] flex-col rounded-md border border-border bg-background',
        stale && 'border-amber-700/30 bg-muted/20',
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
            Stage {stageIndex} of {ALL_STAGES.length}
          </p>
          <h2 id="stage-workspace-heading" className="truncate text-base font-semibold">
            {stage.label}
          </h2>
        </div>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {activeStage}
        </Badge>
      </header>

      <div className="flex-1 p-4">
        {compileStatus === 'compiling' ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6 text-center">
            <Loader aria-hidden="true" className="size-5 text-muted-foreground" />
            <p className="text-sm font-medium">{COMPILE_IN_PROGRESS}</p>
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">
              {COMPILE_IN_PROGRESS_DETAIL}
            </p>
          </div>
        ) : (
          <StageErrorBoundary key={activeStage}>
            {activeStage === 'source' ? (
              <SourceOverview source={source} />
            ) : activeStage === 'asm' ? (
              isPending ? (
                <NotRunStage stage={activeStage} />
              ) : isBlocked ? (
                <BlockedStage stage={activeStage} statuses={statuses} />
              ) : (
                <AssemblyView />
              )
            ) : activeStage === 'sim' ? (
              isPending ? (
                <NotRunStage stage={activeStage} />
              ) : isBlocked ? (
                <BlockedStage stage={activeStage} statuses={statuses} />
              ) : (
                <ExecView />
              )
            ) : activeStage === 'lex' ? (
              <TokenExplorer />
            ) : activeStage === 'parse' ? (
              <AstExplorer />
            ) : isPending ? (
              <NotRunStage stage={activeStage} />
            ) : isBlocked ? (
              <BlockedStage stage={activeStage} statuses={statuses} />
            ) : activeStage === 'sema' ? (
              <SemanticView />
            ) : activeStage === 'ir' ? (
              <IrView />
            ) : activeStage === 'opt' ? (
              <OptView />
            ) : (
              <SourceOverview source={source} />
            )}
          </StageErrorBoundary>
        )}
      </div>
    </section>
  );
}
