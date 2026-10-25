'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardCheck, Copy, Cpu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import { scrollWithinBox } from '@/components/common/scrollWithinBox';
import { IrVersionToggle } from '@/components/common/IrVersionToggle';
import {
  ASM_ALL_FUNCTIONS,
  ASM_BLOCKED,
  ASM_EMPTY_SELECTION,
  ASM_FUNCTION_LABEL,
  ASM_INSTRUCTION_TITLE,
  ASM_LINE_COUNT_LABEL,
  ASM_MAPPED_IR_LABEL,
  ASM_NO_MAPPING,
  ASM_NO_RESULT,
  ASM_NOTE,
  ASM_NOTE_TITLE,
} from '@/content/explanations';
import {
  computeHighlights,
  createEmptyHighlights,
  selectionTint,
  type Highlights,
} from '@/lib/highlight';
import { findChangeForInstruction } from '@/lib/compiler';
import { generateAsm } from '@/lib/compiler/asmgen';
import { useWorkspaceStore } from '@/lib/store';
import type { AsmLine, CompileResult, IRLine, IRModule } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

function kindClass(line: AsmLine): string {
  switch (line.kind) {
    case 'label':
      return 'font-semibold text-violet-700';
    case 'directive':
      return 'text-teal-700';
    case 'comment':
      return 'italic text-muted-foreground';
    default:
      return 'text-foreground';
  }
}

function InstructionPanel({
  line,
  result,
  irLines,
  irModule,
  highlights,
}: {
  line: AsmLine;
  result: CompileResult;
  irLines: IRLine[];
  irModule: IRModule | null;
  highlights: Highlights;
}) {
  const irInstr =
    line.irInstrId !== undefined && irModule !== null
      ? irModule.instrs[line.irInstrId]
      : undefined;
  const irLine =
    line.irInstrId !== undefined
      ? irLines.find((candidate) => candidate.instrId === line.irInstrId)
      : undefined;
  const originNode =
    irInstr?.astNodeId !== undefined ? result.ast?.nodes[irInstr.astNodeId] : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.75rem]">
          {line.kind}
        </Badge>
        {line.funcName !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">@{line.funcName}</span>
        ) : null}
      </div>

      {irLine !== undefined ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{ASM_MAPPED_IR_LABEL}:</p>
          <code className="w-fit max-w-full overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-sm">
            {irLine.text}
          </code>
        </div>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">{ASM_NO_MAPPING}</p>
      )}

      {originNode !== undefined ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Source mapping: syntax node #{originNode.id} ({originNode.kind}) —{' '}
          <code className="font-mono">
            {result.source.slice(originNode.range.start, originNode.range.end)}
          </code>
        </p>
      ) : null}

      {highlights.unavailable !== undefined ? (
        <p className="text-xs leading-5 text-muted-foreground">{highlights.unavailable}</p>
      ) : null}
    </div>
  );
}

/**
 * Assembly view: row-based read-only view of the generated x86-64 text with
 * per-line mapping back to the IR instruction it lowers.
 */
export function AssemblyView() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const optimization = useWorkspaceStore((state) => state.optimization);
  const irVersion = useWorkspaceStore((state) => state.irVersion);
  const select = useWorkspaceStore((state) => state.select);

  const [functionFilter, setFunctionFilter] = useState<string>('all');
  const [copied, setCopied] = useState(false);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result, optimization)),
    [selection, result, optimization, stale],
  );
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  /** Lower the selected IR version: the original module or its optimised clone. */
  const optimised = irVersion === 'optimized' && optimization !== null;
  const asmModule = useMemo(() => {
    if (irVersion === 'optimized' && optimization !== null) {
      return generateAsm(optimization.module);
    }
    return result?.asm ?? null;
  }, [irVersion, optimization, result]);
  const irModule: IRModule | null = optimised
    ? (optimization?.module ?? null)
    : (result?.ir?.module ?? null);
  const irLines: IRLine[] = optimised
    ? (optimization?.lines ?? [])
    : (result?.ir?.lines ?? []);

  const lines = useMemo(() => asmModule?.lines ?? [], [asmModule]);
  const functions = useMemo(() => {
    const names: string[] = [];
    for (const line of lines) {
      if (line.funcName !== undefined && !names.includes(line.funcName)) names.push(line.funcName);
    }
    return names;
  }, [lines]);

  const visibleLines = useMemo(
    () =>
      functionFilter === 'all'
        ? lines
        : lines.filter((line) => line.funcName === functionFilter || line.kind === 'comment'),
    [lines, functionFilter],
  );

  const selectedChange =
    selection.kind === 'opt'
      ? (optimization?.changes.find((change) => change.id === selection.changeId) ?? null)
      : null;

  // In the original version a row selects an assembly line; in the optimised
  // version a row selects the transformation (or the IR instruction) it came
  // from, because its line numbers belong to a different module.
  const selectedLineNo = !optimised
    ? selection.kind === 'asm'
      ? selection.lineId
      : null
    : (() => {
        const primaryIrId =
          selection.kind === 'opt'
            ? (selectedChange?.afterInstrId ?? null)
            : selection.kind === 'ir'
              ? selection.instrId
              : null;
        if (primaryIrId === null) return null;
        return lines.find((line) => line.irInstrId === primaryIrId)?.lineNo ?? null;
      })();

  const selectedLine =
    selectedLineNo === null
      ? null
      : (lines.find((line) => line.lineNo === selectedLineNo) ?? null);

  useEffect(() => {
    if (stale || selection.kind !== 'asm' || selection.origin !== 'editor') return;
    const index = visibleLines.findIndex((line) => line.lineNo === selection.lineId);
    if (index < 0) return;
    scrollWithinBox(listRef.current, rowRefs.current[index] ?? null);
  }, [stale, selection, visibleLines]);

  const focusRow = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visibleLines.length - 1));
    rowRefs.current[bounded]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(visibleLines.length - 1);
    }
  };

  const copyText = visibleLines.map((line) => line.text).join('\n');
  const onCopy = () => {
    void navigator.clipboard
      .writeText(copyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  if (result === null) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
        {ASM_NO_RESULT}
      </div>
    );
  }

  if (asmModule === null) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
        <Cpu aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">{ASM_BLOCKED}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind={optimised ? 'derived' : 'generated'} />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {visibleLines.length} {ASM_LINE_COUNT_LABEL}
        </Badge>
        <IrVersionToggle />
        {functions.length > 1 ? (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{ASM_FUNCTION_LABEL}</span>
            <Select value={functionFilter} onValueChange={setFunctionFilter}>
              <SelectTrigger className="w-[12rem]" aria-label={ASM_FUNCTION_LABEL}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{ASM_ALL_FUNCTIONS}</SelectItem>
                {functions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onCopy} disabled={copied}>
          {copied ? (
            <ClipboardCheck aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy assembly'}
        </Button>
      </div>

      {stale ? (
        <p
          role="status"
          className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
        >
          The source changed after this assembly was generated. Recompile to refresh it.
        </p>
      ) : null}

      {visibleLines.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
          This function has no assembly lines to show.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div
            ref={listRef}
            className="max-h-[26rem] overflow-auto bg-background font-mono text-[0.8rem] leading-6"
          >
            {visibleLines.map((line, index) => {
              const isPrimary = optimised
                ? line.irInstrId !== undefined &&
                  (selection.kind === 'opt'
                    ? selectedChange?.afterInstrId === line.irInstrId
                    : selection.kind === 'ir' && selection.instrId === line.irInstrId)
                : selectedLineNo === line.lineNo;
              const relatedIds = optimised ? highlights.optInstrIds : highlights.irInstrIds;
              const isRelated =
                !isPrimary && line.irInstrId !== undefined && relatedIds.has(line.irInstrId);
              const isUnrelated = selection.kind !== 'none' && !stale && !isPrimary && !isRelated;
              const selectable =
                line.kind === 'instruction' && (!optimised || line.irInstrId !== undefined);

              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className="w-10 shrink-0 select-none border-r border-border bg-muted/40 pr-2 text-right text-[0.7rem] text-muted-foreground"
                  >
                    {line.lineNo}
                  </span>
                  <code className={cn('min-w-0 flex-1 whitespace-pre pl-2', kindClass(line))}>
                    {line.text}
                  </code>
                </>
              );

              if (!selectable) {
                return (
                  <div
                    key={line.lineNo}
                    className={cn(
                      'flex items-center border-b border-border/60 px-1 last:border-b-0',
                      line.text === '' ? 'h-2' : '',
                      isRelated && 'sel-related',
                    )}
                  >
                    {content}
                  </div>
                );
              }

              const pickLine = () => {
                if (!optimised) {
                  select({ kind: 'asm', lineId: line.lineNo, origin: 'stage' });
                  return;
                }
                const irId = line.irInstrId;
                if (irId === undefined) return;
                const change =
                  optimization === null ? null : findChangeForInstruction(optimization, irId);
                if (change !== null) {
                  select({ kind: 'opt', changeId: change.id, origin: 'stage' });
                } else {
                  select({ kind: 'ir', instrId: irId, origin: 'stage' });
                }
              };

              return (
                <button
                  key={line.lineNo}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  type="button"
                  aria-pressed={isPrimary}
                  onClick={pickLine}
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
      )}

      <p className="text-xs leading-5 text-muted-foreground">
        <span className="font-medium">{ASM_NOTE_TITLE}: </span>
        {ASM_NOTE}
      </p>

      <section className="flex flex-col gap-2 rounded-md border border-border p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {ASM_INSTRUCTION_TITLE}
        </h3>
        {selectedLine === null || stale ? (
          <p className="text-sm leading-6 text-muted-foreground">{ASM_EMPTY_SELECTION}</p>
        ) : (
          <InstructionPanel
            line={selectedLine}
            result={result}
            irLines={irLines}
            irModule={irModule}
            highlights={highlights}
          />
        )}
      </section>
    </div>
  );
}
