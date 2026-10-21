'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardCheck, Copy, Workflow } from 'lucide-react';
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
  IR_ALL_FUNCTIONS,
  IR_BLOCKED,
  IR_CALLEE_LABEL,
  IR_COPY_DONE,
  IR_COPY_LABEL,
  IR_EMPTY_SELECTION,
  IR_FUNCTION_LABEL,
  IR_INSTRUCTION_TITLE,
  IR_LINE_COUNT_LABEL,
  IR_NO_ORIGIN,
  IR_NO_RESULT,
  IR_NOTE,
  IR_NOTE_TITLE,
  IR_OPCODE_LEGEND_TITLE,
  IR_OPERANDS_LABEL,
  IR_PREDICATE_EXPLANATIONS,
  IR_PREDICATE_LABEL,
  IR_RESULT_LABEL,
  IR_VAR_LABEL,
  IROPCODE_EXPLANATIONS,
} from '@/content/explanations';
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { useWorkspaceStore } from '@/lib/store';
import type { IRInstr, IRLine, IROperand } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

/**
 * One IR line split into coloured segments (§8: regex syntax colouring for
 * opcodes, %names, @globals, types, labels and numbers). Pure text work — no
 * parsing of compiler output.
 */
const IR_TOKEN_PATTERN =
  /((?:^|\s)(?:define|declare|global|alloca|load|store|add|sub|mul|sdiv|srem|icmp|zext|br|ret|call|unreachable|nsw|align|phi)(?=\s))|(%[\w.]+)|(@[\w]+)|\b(i1|i32|ptr|void)\b|\b(label|to|global)\b|\b(\d+)\b/g;

const TOKEN_CLASSES: Record<number, string> = {
  1: 'font-semibold text-violet-700', // opcode words
  2: 'text-sky-700', // %value names
  3: 'text-emerald-700', // @globals
  4: 'text-orange-700', // types
  5: 'text-pink-700', // label/to keywords
  6: 'text-amber-700', // numbers
};

function colourIRLine(text: string): { text: string; className: string }[] {
  const segments: { text: string; className: string }[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(IR_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), className: '' });
    const groupIndex = match.slice(1).findIndex((capture) => capture !== undefined) + 1;
    segments.push({ text: match[0], className: TOKEN_CLASSES[groupIndex] ?? '' });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), className: '' });
  return segments;
}

function operandText(operand: IROperand, module: { blocks: Record<number, { label: string }> }): string {
  switch (operand.kind) {
    case 'value':
      return operand.name;
    case 'const':
      return `${operand.type} ${operand.value}`;
    case 'label':
      return `label %${module.blocks[operand.blockId]?.label ?? `block${operand.blockId}`}`;
    case 'global':
      return `ptr @${operand.name}`;
  }
}

function InstructionPanel({ instrId }: { instrId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const highlights = useMemo(
    () => computeHighlights({ kind: 'ir', instrId, origin: 'stage' }, result),
    [instrId, result],
  );

  const instr: IRInstr | undefined = result?.ir?.module.instrs[instrId];
  if (instr === undefined) {
    return <p className="text-sm leading-6 text-muted-foreground">{IR_NO_RESULT}</p>;
  }

  const opcodeMeta = IROPCODE_EXPLANATIONS[instr.opcode];
  const irModule = result!.ir!.module;
  const originNode =
    instr.astNodeId !== undefined ? result?.ast?.nodes[instr.astNodeId] : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.75rem]">
          {opcodeMeta?.label ?? instr.opcode}
        </Badge>
        {instr.result !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">
            {IR_RESULT_LABEL}: <code className="text-foreground">{instr.result}</code>
          </span>
        ) : null}
        {instr.predicate !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">
            {IR_PREDICATE_LABEL}: {IR_PREDICATE_EXPLANATIONS[instr.predicate]}
          </span>
        ) : null}
        {instr.varName !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">
            {IR_VAR_LABEL}: <code className="text-foreground">{instr.varName}</code>
          </span>
        ) : null}
        {instr.callee !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">
            {IR_CALLEE_LABEL}: <code className="text-foreground">@{instr.callee}</code>
          </span>
        ) : null}
      </div>

      {opcodeMeta !== undefined ? <p className="text-sm leading-6">{opcodeMeta.simple}</p> : null}

      {instr.operands.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-medium">{IR_OPERANDS_LABEL}:{' '}</span>
          {instr.operands
            .map((operand) => operandText(operand, irModule))
            .join(', ')}
        </p>
      ) : null}

      {originNode !== undefined && result !== null ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-medium">Source mapping: </span>
          syntax node #{originNode.id} ({originNode.kind}) —{' '}
          <code className="font-mono">
            {result.source.slice(originNode.range.start, originNode.range.end)}
          </code>
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">{IR_NO_ORIGIN}</p>
      )}

      {highlights.unavailable !== undefined ? (
        <p className="text-xs leading-5 text-muted-foreground">{highlights.unavailable}</p>
      ) : null}
    </div>
  );
}

/**
 * IR view (§8): row-based read-only view (custom button rows, not Monaco)
 * with line numbers, regex colouring, a function selector, Copy IR, and a
 * selected-instruction panel built from the structured IRInstr.
 */
export function IrView() {
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

  const lines = useMemo(() => result?.ir?.lines ?? [], [result]);
  const functions = useMemo(
    () =>
      (result?.ir?.module.functions ?? []).map((fn) => ({
        name: fn.name,
        isDeclaration: fn.isDeclaration,
      })),
    [result],
  );

  const visibleLines = useMemo(
    () =>
      functionFilter === 'all'
        ? lines
        : lines.filter((line) => line.funcName === functionFilter),
    [lines, functionFilter],
  );

  const selectedInstrId = selection.kind === 'ir' ? selection.instrId : null;
  const hasSelection = selection.kind !== 'none' && !stale;

  useEffect(() => {
    if (stale || selection.kind !== 'ir' || selection.origin !== 'editor') return;
    const index = visibleLines.findIndex((line) => line.instrId === selection.instrId);
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
        {IR_NO_RESULT}
      </div>
    );
  }

  if (result.ir === null) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 p-6">
        <Workflow aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm leading-6 text-muted-foreground">{IR_BLOCKED}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="generated" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {visibleLines.length} {IR_LINE_COUNT_LABEL}
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
        <Button type="button" variant="outline" size="sm" onClick={onCopy} disabled={copied}>
          {copied ? (
            <ClipboardCheck aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          {copied ? IR_COPY_DONE : IR_COPY_LABEL}
        </Button>
      </div>

      {stale ? (
        <p
          role="status"
          className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
        >
          The source changed after this IR was generated. Recompile to refresh it.
        </p>
      ) : null}

      {visibleLines.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
          This function has no lines to show.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div
            ref={listRef}
            className="max-h-[26rem] overflow-auto bg-background font-mono text-[0.8rem] leading-6"
          >
            {visibleLines.map((line: IRLine, index) => {
              const isPrimary =
                line.instrId !== undefined && selectedInstrId === line.instrId;
              const isRelated =
                !isPrimary &&
                line.instrId !== undefined &&
                highlights.irInstrIds.has(line.instrId);
              const isUnrelated = hasSelection && !isPrimary && !isRelated;
              const isStructural = line.instrId === undefined;

              const content = (
                <>
                  <span
                    aria-hidden="true"
                    className="w-10 shrink-0 select-none border-r border-border bg-muted/40 pr-2 text-right text-[0.7rem] text-muted-foreground"
                  >
                    {line.lineNo}
                  </span>
                  <code className="min-w-0 flex-1 whitespace-pre pl-2">
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
                      isStructural && /^[a-z]/.test(line.text) && 'bg-muted/20 font-semibold',
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
                  onClick={() =>
                    select({ kind: 'ir', instrId: line.instrId!, origin: 'stage' })
                  }
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
        <span className="font-medium">{IR_NOTE_TITLE}: </span>
        {IR_NOTE}
      </p>

      <section className="flex flex-col gap-2 rounded-md border border-border p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {IR_INSTRUCTION_TITLE}
        </h3>
        {selectedInstrId === null || stale ? (
          <p className="text-sm leading-6 text-muted-foreground">{IR_EMPTY_SELECTION}</p>
        ) : (
          <InstructionPanel instrId={selectedInstrId} />
        )}
      </section>

      <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {IR_OPCODE_LEGEND_TITLE}
        </summary>
        <dl className="grid gap-2 pt-2 sm:grid-cols-2">
          {Object.entries(IROPCODE_EXPLANATIONS).map(([opcode, meta]) => (
            <div key={opcode} className="flex items-start gap-2">
              <dt className="inline-flex w-fit shrink-0 items-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs font-medium">
                {meta.label}
              </dt>
              <dd className="text-xs leading-5 text-muted-foreground">{meta.simple}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
