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
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { useWorkspaceStore } from '@/lib/store';
import type { AsmLine } from '@/lib/compiler/types';
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

function InstructionPanel({ lineNo }: { lineNo: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const highlights = useMemo(
    () => computeHighlights({ kind: 'asm', lineId: lineNo, origin: 'stage' }, result),
    [lineNo, result],
  );

  const line = result?.asm?.lines.find((candidate) => candidate.lineNo === lineNo);
  if (line === undefined || result === null) {
    return <p className="text-sm leading-6 text-muted-foreground">{ASM_NO_RESULT}</p>;
  }

  const irInstr =
    line.irInstrId !== undefined ? result.ir?.module.instrs[line.irInstrId] : undefined;
  const irLine =
    line.irInstrId !== undefined
      ? result.ir?.lines.find((candidate) => candidate.instrId === line.irInstrId)
      : undefined;
  const originNode = irInstr?.astNodeId !== undefined ? result.ast?.nodes[irInstr.astNodeId] : undefined;

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
  const select = useWorkspaceStore((state) => state.select);

  const [functionFilter, setFunctionFilter] = useState<string>('all');
  const [copied, setCopied] = useState(false);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  const lines = useMemo(() => result?.asm?.lines ?? [], [result]);
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

  const selectedLineNo = selection.kind === 'asm' ? selection.lineId : null;

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

  if (result.asm === null) {
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
        <ProvenanceBadge kind="generated" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {visibleLines.length} {ASM_LINE_COUNT_LABEL}
        </Badge>
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
              const isPrimary = selectedLineNo === line.lineNo;
              const isRelated =
                !isPrimary && line.irInstrId !== undefined && highlights.irInstrIds.has(line.irInstrId);
              const isUnrelated = selection.kind !== 'none' && !stale && !isPrimary && !isRelated;
              const selectable = line.kind === 'instruction';

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

              return (
                <button
                  key={line.lineNo}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  type="button"
                  aria-pressed={isPrimary}
                  onClick={() => select({ kind: 'asm', lineId: line.lineNo, origin: 'stage' })}
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
        {selectedLineNo === null || stale ? (
          <p className="text-sm leading-6 text-muted-foreground">{ASM_EMPTY_SELECTION}</p>
        ) : (
          <InstructionPanel lineNo={selectedLineNo} />
        )}
      </section>
    </div>
  );
}
