'use client';

import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, Check, GitCompare, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import { ChangeDetail } from '@/components/common/ChangeDetail';
import { colourIRLine } from '@/components/stages/irColour';
import {
  IR_ALL_FUNCTIONS,
  IR_BLOCKED,
  IR_FUNCTION_LABEL,
  IR_NO_RESULT,
} from '@/content/explanations';
import {
  OPT_CHANGE_NONE,
  OPT_CHANGES_HEADING,
  OPT_FALLBACK_NOTE,
  OPT_LEGEND_HEADING,
  OPT_NO_CHANGES,
  OPT_NO_RESULT,
  OPT_NOT_LLVM_NOTE,
  OPT_PANE_HEADING_OPTIMISED,
  OPT_PANE_HEADING_ORIGINAL,
  OPT_PASSES_HEADING,
  OPT_PASS_ALL_OFF,
  OPT_PASS_EXPLANATIONS,
  OPT_ROW_LEGEND,
  OPT_STATS_APPLIED,
  OPT_STATS_NO_PASS,
  OPT_TIMELINE_HEADING,
  OPT_VERSION_HEADING,
  changeTitle,
  optInstructionsLabel,
  optRemovedLabel,
  passLabel,
} from '@/content/optExplanations';
import {
  OPT_PASS_ORDER,
  findChangeForInstruction,
  type OptPassState,
  type OptRowStatus,
} from '@/lib/compiler';
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { useWorkspaceStore } from '@/lib/store';
import type { IRLine } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

/** Marker + word for a row state, so the state never depends on colour alone. */
function statusMeta(status: OptRowStatus | undefined): { marker: string; label: string } {
  const entry = OPT_ROW_LEGEND.find((candidate) => candidate.status === status);
  if (entry === undefined) return { marker: '·', label: 'not compared' };
  return { marker: entry.marker, label: entry.label };
}

function StatusMarker({ status }: { status: OptRowStatus | undefined }) {
  const meta = statusMeta(status);
  return (
    <span
      title={meta.label}
      className={cn(
        'inline-flex w-4 shrink-0 select-none items-center justify-center font-mono text-[0.7rem]',
        status === undefined || status === 'unchanged'
          ? 'text-muted-foreground/60'
          : 'font-semibold text-foreground',
      )}
    >
      <span aria-hidden="true">{meta.marker}</span>
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

interface IrPaneProps {
  heading: string;
  lines: IRLine[];
  primaryId: number | null;
  relatedIds: Set<number>;
  hasSelection: boolean;
  statusOf: (instrId: number) => OptRowStatus | undefined;
  onPick: (instrId: number) => void;
  count: number;
}

/**
 * One side of the comparison: printed IR rows with their by-ID status marker.
 * Rows are real buttons (focusable, arrow-navigable) so the selection can be
 * driven from either side.
 */
function IrPane({
  heading,
  lines,
  primaryId,
  relatedIds,
  hasSelection,
  statusOf,
  onPick,
  count,
}: IrPaneProps) {
  const selection = useWorkspaceStore((state) => state.selection);
  const result = useWorkspaceStore((state) => state.result);
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonIndexes = lines
    .map((line, index) => (line.instrId === undefined ? null : index))
    .filter((index): index is number => index !== null);

  const focusRow = (position: number) => {
    const bounded = Math.max(0, Math.min(position, buttonIndexes.length - 1));
    rowRefs.current[buttonIndexes[bounded]]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const position = buttonIndexes.indexOf(index);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(position + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(position - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(buttonIndexes.length - 1);
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-1">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading}
        </h3>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {count}
        </Badge>
      </header>
      <div className="overflow-hidden rounded-md border border-border">
        <div
          ref={listRef}
          className="max-h-[24rem] overflow-auto bg-background font-mono text-[0.8rem] leading-6"
        >
          {lines.map((line, index) => {
            const isPrimary = line.instrId !== undefined && primaryId === line.instrId;
            const isRelated =
              !isPrimary && line.instrId !== undefined && relatedIds.has(line.instrId);
            const isUnrelated = hasSelection && !isPrimary && !isRelated;
            const status = line.instrId === undefined ? undefined : statusOf(line.instrId);

            const content = (
              <>
                <span
                  aria-hidden="true"
                  className="w-10 shrink-0 select-none border-r border-border bg-muted/40 pr-2 text-right text-[0.7rem] text-muted-foreground"
                >
                  {line.lineNo}
                </span>
                <StatusMarker status={status} />
                <code className="min-w-0 flex-1 whitespace-pre pl-1">
                  {colourIRLine(line.text).map((segment, segmentIndex) => (
                    <span key={segmentIndex} className={segment.className}>
                      {segment.text}
                    </span>
                  ))}
                </code>
              </>
            );

            if (line.instrId === undefined) {
              return (
                <div
                  key={line.lineNo}
                  className={cn(
                    'flex items-center border-b border-border/60 px-1 last:border-b-0',
                    line.text === '' ? 'h-2' : '',
                    /^[a-z]/.test(line.text) && 'bg-muted/20 font-semibold',
                  )}
                >
                  {content}
                </div>
              );
            }

            const statusLabel = statusMeta(status).label;
            return (
              <button
                key={line.lineNo}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                type="button"
                aria-pressed={isPrimary}
                title={`${line.text} — ${statusLabel}`}
                onClick={() => onPick(line.instrId!)}
                onKeyDown={(event) => onRowKeyDown(event, index)}
                className={cn(
                  'flex w-full items-center border-b border-border/60 px-1 text-left transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isPrimary && cn('sel-primary', tintClass),
                  isRelated && 'sel-related',
                  isUnrelated && 'opacity-80',
                )}
              >
                {content}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function passStatusBadge(state: OptPassState): string {
  if (!state.enabled) return 'off';
  if (state.status === 'applied') return `${state.changeCount} change${state.changeCount === 1 ? '' : 's'}`;
  return 'clean';
}

/**
 * Optimization stage (SPEC §13): side-by-side before/after IR, pass toggles,
 * a per-pass timeline, a status legend and the transformation list, with the
 * selection synchronised across source, both IR panes and the explanation
 * panel. Nothing here parses printed IR — every ID comes from the two modules.
 */
export function OptView() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const optimization = useWorkspaceStore((state) => state.optimization);
  const enabledPasses = useWorkspaceStore((state) => state.enabledPasses);
  const toggleOptPass = useWorkspaceStore((state) => state.toggleOptPass);
  const select = useWorkspaceStore((state) => state.select);

  const [functionFilter, setFunctionFilter] = useState<string>('all');

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result, optimization)),
    [selection, result, optimization, stale],
  );

  const selectedChange =
    selection.kind === 'opt'
      ? (optimization?.changes.find((change) => change.id === selection.changeId) ?? null)
      : null;

  const originalLines = useMemo(() => {
    const lines = result?.ir?.lines ?? [];
    return functionFilter === 'all'
      ? lines
      : lines.filter((line) => line.funcName === functionFilter);
  }, [result, functionFilter]);

  const optimisedLines = useMemo(() => {
    const lines = optimization?.lines ?? [];
    return functionFilter === 'all'
      ? lines
      : lines.filter((line) => line.funcName === functionFilter);
  }, [optimization, functionFilter]);

  const functions = useMemo(
    () =>
      (result?.ir?.module.functions ?? []).map((fn) => ({
        name: fn.name,
        isDeclaration: fn.isDeclaration,
      })),
    [result],
  );

  const pick = (instrId: number) => {
    const change = optimization === null ? null : findChangeForInstruction(optimization, instrId);
    if (change !== null) {
      select({ kind: 'opt', changeId: change.id, origin: 'stage' });
    } else {
      select({ kind: 'ir', instrId, origin: 'stage' });
    }
  };

  const primaryOriginal =
    selectedChange !== null
      ? selectedChange.beforeInstrId
      : selection.kind === 'ir'
        ? selection.instrId
        : null;
  const primaryOptimised =
    selectedChange !== null
      ? selectedChange.afterInstrId
      : selection.kind === 'ir' &&
          optimization !== null &&
          optimization.module.instrs[selection.instrId] !== undefined
        ? selection.instrId
        : null;

  const hasSelection = selection.kind !== 'none' && !stale;
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  if (result === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {OPT_NO_RESULT}
      </div>
    );
  }

  if (result.ir === null) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
        <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">{IR_BLOCKED}</p>
      </div>
    );
  }

  if (optimization === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {IR_NO_RESULT}
      </div>
    );
  }

  const removedCount = Math.max(0, optimization.originalCount - optimization.optimizedCount);
  const appliedCount = optimization.passStates.filter((state) => state.status === 'applied').length;
  const allOff = optimization.enabledPasses.length === 0;

  const timelineSteps = [
    {
      key: 'original',
      label: 'Original',
      count: optimization.originalCount as number | null,
      note: null as string | null,
    },
    ...optimization.passStates.map((state) => ({
      key: state.id,
      label: OPT_PASS_EXPLANATIONS[state.id].label,
      count: state.instructionCountAfter,
      note: !state.enabled ? 'skipped' : null,
    })),
    {
      key: 'optimised',
      label: 'Optimised',
      count: optimization.optimizedCount as number | null,
      note: null as string | null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar: provenance and headline statistics. */}
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="derived" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {optInstructionsLabel(optimization.originalCount, optimization.optimizedCount)}
        </Badge>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {optRemovedLabel(removedCount)}
        </Badge>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {appliedCount > 0
            ? `${appliedCount} ${OPT_STATS_APPLIED}`
            : OPT_STATS_NO_PASS}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">{OPT_NOT_LLVM_NOTE}</span>
      </div>

      {stale ? (
        <p
          role="status"
          className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
        >
          The source changed after this IR was generated. Recompile to refresh it.
        </p>
      ) : null}

      {optimization.fallback !== null ? (
        <p
          role="status"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-5"
        >
          {OPT_FALLBACK_NOTE} ({optimization.fallback})
        </p>
      ) : null}

      {/* Pass toggles */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {OPT_PASSES_HEADING}
        </h3>
        <ul className="divide-y divide-border rounded-md border border-border">
          {OPT_PASS_ORDER.map((pass) => {
            const explanation = OPT_PASS_EXPLANATIONS[pass];
            const state = optimization.passStates.find(
              (candidate) => candidate.id === pass,
            ) as OptPassState;
            const enabled = enabledPasses.includes(pass);
            return (
              <li key={pass} className="flex flex-wrap items-center gap-2 px-2 py-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleOptPass(pass)}
                  className="flex items-center gap-2 rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  title={enabled ? `Turn ${explanation.label} off` : `Turn ${explanation.label} on`}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-flex size-4 items-center justify-center rounded border',
                      enabled
                        ? 'border-stage-opt bg-stage-opt/20 text-stage-opt'
                        : 'border-border bg-background text-transparent',
                    )}
                  >
                    <Check className="size-3" />
                  </span>
                  <span className="text-sm font-medium">{explanation.label}</span>
                </button>
                <Badge
                  variant="outline"
                  className={cn('ml-auto font-mono text-[0.7rem]', !enabled && 'opacity-70')}
                >
                  {passStatusBadge(state)}
                </Badge>
                <p className="w-full text-xs leading-5 text-muted-foreground">
                  {explanation.tagline}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Timeline */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {OPT_TIMELINE_HEADING}
        </h3>
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {timelineSteps.map((step, index) => (
            <Fragment key={step.key}>
              {index > 0 ? (
                <li aria-hidden="true" className="text-muted-foreground">
                  <ArrowRight className="size-3" />
                </li>
              ) : null}
              <li className="flex items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1">
                <span className="font-medium">{step.label}</span>
                <span className="font-mono text-muted-foreground">
                  {step.note !== null ? step.note : (step.count ?? '—')}
                </span>
              </li>
            </Fragment>
          ))}
        </ol>
      </section>

      {/* Legend */}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {OPT_LEGEND_HEADING}
        </h3>
        <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {OPT_ROW_LEGEND.map((entry) => (
            <div key={entry.status} className="flex items-start gap-2">
              <dt className="flex w-fit shrink-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-flex size-5 items-center justify-center rounded border border-border bg-muted font-mono text-xs"
                >
                  {entry.marker}
                </span>
                <span className="text-xs font-medium">{entry.label}</span>
              </dt>
              <dd className="text-xs leading-5 text-muted-foreground">{entry.description}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Side-by-side IR */}
      <div className="flex flex-wrap items-center gap-2">
        <GitCompare aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">{OPT_VERSION_HEADING}</span>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          original / optimised
        </Badge>
        {functions.length > 1 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{IR_FUNCTION_LABEL}</span>
            <Select value={functionFilter} onValueChange={setFunctionFilter}>
              <SelectTrigger className="w-[12rem]" aria-label={IR_FUNCTION_LABEL}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{IR_ALL_FUNCTIONS}</SelectItem>
                {functions.map((fn) => (
                  <SelectItem key={fn.name} value={fn.name}>
                    {fn.name}
                    {fn.isDeclaration ? ' (declare)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <IrPane
          heading={OPT_PANE_HEADING_ORIGINAL}
          lines={originalLines}
          primaryId={primaryOriginal}
          relatedIds={highlights.irInstrIds}
          hasSelection={hasSelection}
          statusOf={(instrId) => optimization.rowStatus[instrId]}
          onPick={pick}
          count={originalLines.length}
        />
        <IrPane
          heading={OPT_PANE_HEADING_OPTIMISED}
          lines={optimisedLines}
          primaryId={primaryOptimised}
          relatedIds={highlights.optInstrIds}
          hasSelection={hasSelection}
          statusOf={(instrId) => optimization.rowStatus[instrId]}
          onPick={pick}
          count={optimisedLines.length}
        />
      </div>

      {/* Transformations */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {OPT_CHANGES_HEADING}
          </h3>
          <Badge variant="outline" className="font-mono text-[0.7rem]">
            {optimization.changes.length}
          </Badge>
        </div>

        {optimization.changes.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            {allOff ? OPT_PASS_ALL_OFF : OPT_NO_CHANGES}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {optimization.changes.map((change) => {
              const isSelected =
                selection.kind === 'opt' && selection.changeId === change.id && !stale;
              const isRelated = !isSelected && highlights.optChangeId === change.id;
              return (
                <li key={change.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => select({ kind: 'opt', changeId: change.id, origin: 'stage' })}
                    className={cn(
                      'flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                      isSelected && cn('sel-primary', tintClass),
                      isRelated && 'sel-related',
                    )}
                  >
                    <span aria-hidden="true" className="font-mono text-sm text-muted-foreground">
                      {statusMeta(change.kind).marker}
                    </span>
                    <span className="text-sm font-medium">{changeTitle(change)}</span>
                    <Badge variant="outline" className="ml-auto font-mono text-[0.7rem]">
                      {passLabel(change.pass)}
                    </Badge>
                    <span className="w-full text-xs text-muted-foreground">
                      instruction #{change.beforeInstrId}
                      {change.astNodeId !== null ? ` · source node #${change.astNodeId}` : ''}
                    </span>
                  </button>
                  {isSelected ? <ChangeDetail change={change} /> : null}
                </li>
              );
            })}
          </ul>
        )}

        {optimization.changes.length > 0 && selection.kind !== 'opt' ? (
          <p className="text-xs leading-5 text-muted-foreground">{OPT_CHANGE_NONE}</p>
        ) : null}
      </section>

      {/* Technique reference */}
      <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          What each pass does
        </summary>
        <dl className="grid gap-3 pt-2 sm:grid-cols-2">
          {OPT_PASS_ORDER.map((pass) => {
            const explanation = OPT_PASS_EXPLANATIONS[pass];
            return (
              <div key={pass} className="flex flex-col gap-1">
                <dt className="text-xs font-semibold">{explanation.label}</dt>
                <dd className="text-xs leading-5 text-muted-foreground">
                  {explanation.technical}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    </div>
  );
}
