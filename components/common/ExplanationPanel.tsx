'use client';

import { useMemo } from 'react';
import { MousePointer2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  AST_KIND_EXPLANATIONS,
  AST_NODE_NOT_FOUND,
  astChildCountLabel,
  DIAGNOSTIC_CODE_EXPLANATIONS,
  DIAGNOSTIC_WHY_LABEL,
  IROPCODE_EXPLANATIONS,
  IR_PREDICATE_EXPLANATIONS,
  NOTHING_SELECTED,
  SELECTION_DETAILS_PENDING,
  SOURCE_RANGE_NONE,
  SOURCE_RANGE_ONE,
  STALE_SELECTION_NOTE,
  STAGE_EXPLANATIONS,
  SYMBOL_KIND_EXPLANATIONS,
  SYMBOL_NOT_FOUND,
  TOKEN_KIND_EXPLANATIONS,
  TOKEN_NOT_FOUND,
  sourceRangeMany,
  typeToString,
} from '@/content/explanations';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import { computeHighlights, createEmptyHighlights } from '@/lib/highlight';
import { positionAt } from '@/lib/positions';
import { useWorkspaceStore, type Selection } from '@/lib/store';

function selectionLabel(selection: Selection): string {
  switch (selection.kind) {
    case 'source':
      return 'source range';
    case 'token':
      return `token #${selection.tokenId}`;
    case 'ast':
      return `syntax node #${selection.nodeId}`;
    case 'symbol':
      return `symbol #${selection.symbolId}`;
    case 'ir':
      return `IR instruction #${selection.instrId}`;
    case 'diagnostic':
      return `diagnostic #${selection.diagnosticId}`;
    default:
      return 'item';
  }
}

function TokenDetail({ tokenId }: { tokenId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const token = result?.tokens.find((candidate) => candidate.id === tokenId);

  if (token === undefined) {
    return <p className="text-sm leading-6 text-muted-foreground">{TOKEN_NOT_FOUND}</p>;
  }

  const kind = TOKEN_KIND_EXPLANATIONS[token.kind];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {kind.label}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {token.line}:{token.col} · {token.text.length} char
          {token.text.length === 1 ? '' : 's'}
        </span>
      </div>
      <code className="w-fit max-w-full overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-sm">
        {token.text}
      </code>
      <p className="text-sm leading-6">{kind.simple}</p>
    </div>
  );
}

function AstDetail({ nodeId }: { nodeId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const node = result?.ast?.nodes[nodeId];

  if (node === undefined) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">{AST_NODE_NOT_FOUND}</p>
    );
  }

  const meta = AST_KIND_EXPLANATIONS[node.kind];
  const start = positionAt(result!.source, node.range.start);
  const end = positionAt(result!.source, node.range.end);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {meta.label}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {start.line}:{start.col}–{end.line}:{end.col}
        </span>
        <span className="text-xs text-muted-foreground">
          {astChildCountLabel(node.childIds.length)}
        </span>
      </div>
      {node.name !== undefined ? (
        <code className="w-fit max-w-full overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-sm">
          {node.name}
        </code>
      ) : null}
      {node.op !== undefined ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Operator: <code className="font-mono text-sm">{node.op}</code>
        </p>
      ) : null}
      <p className="text-sm leading-6">{meta.simple}</p>
    </div>
  );
}

function SymbolDetail({ symbolId }: { symbolId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const symbol = result?.symbols?.symbols.find((candidate) => candidate.id === symbolId);

  if (symbol === undefined) {
    return <p className="text-sm leading-6 text-muted-foreground">{SYMBOL_NOT_FOUND}</p>;
  }

  const declNode = result?.ast?.nodes[symbol.declNodeId];
  const declPos =
    declNode !== undefined && result !== undefined && result !== null
      ? positionAt(result.source, declNode.range.start)
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {symbol.kind}
        </Badge>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {typeToString(symbol.type)}
        </Badge>
        {declPos !== null ? (
          <span className="font-mono text-xs text-muted-foreground">
            declared at {declPos.line}:{declPos.col}
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          used {symbol.useNodeIds.length} time{symbol.useNodeIds.length === 1 ? '' : 's'}
        </span>
      </div>
      <code className="w-fit max-w-full overflow-x-auto rounded border border-border bg-muted/40 px-2 py-1 font-mono text-sm">
        {symbol.name}
      </code>
      <p className="text-sm leading-6">
        {SYMBOL_KIND_EXPLANATIONS[symbol.kind] ?? 'A named entity in the program.'}
      </p>
      {symbol.type.kind === 'function' ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Returns {typeToString(symbol.type.ret)} and takes{' '}
          {symbol.type.params.length} parameter{symbol.type.params.length === 1 ? '' : 's'}.
        </p>
      ) : null}
    </div>
  );
}

function IrDetail({ instrId }: { instrId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const instr = result?.ir?.module.instrs[instrId];

  if (instr === undefined) {
    return <p className="text-sm leading-6 text-muted-foreground">{SELECTION_DETAILS_PENDING}</p>;
  }

  const meta = IROPCODE_EXPLANATIONS[instr.opcode];
  const operandText = instr.operands
    .map((operand) => {
      switch (operand.kind) {
        case 'value':
          return operand.name;
        case 'const':
          return `${operand.type} ${operand.value}`;
        case 'label': {
          const block = result?.ir?.module.blocks[operand.blockId];
          return `label %${block?.label ?? `block${operand.blockId}`}`;
        }
        case 'global':
          return `ptr @${operand.name}`;
      }
    })
    .join(', ');

  const originNode =
    instr.astNodeId !== undefined ? result?.ast?.nodes[instr.astNodeId] : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {instr.opcode}
        </Badge>
        {instr.result !== undefined ? (
          <span className="font-mono text-xs text-muted-foreground">result {instr.result}</span>
        ) : null}
        {instr.predicate !== undefined ? (
          <span className="text-xs text-muted-foreground">
            comparison: {IR_PREDICATE_EXPLANATIONS[instr.predicate]}
          </span>
        ) : null}
      </div>
      {meta !== undefined ? <p className="text-sm leading-6">{meta.simple}</p> : null}
      {operandText.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Operands: <code className="font-mono text-xs">{operandText}</code>
        </p>
      ) : null}
      {originNode !== undefined && result !== null ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Generated from {originNode.kind} at{' '}
          <code className="font-mono">
            {result.source.slice(originNode.range.start, originNode.range.end)}
          </code>
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          This is compiler scaffolding; it does not correspond to a source expression.
        </p>
      )}
    </div>
  );
}

function DiagnosticDetail({ diagnosticId }: { diagnosticId: number }) {
  const result = useWorkspaceStore((state) => state.result);
  const diagnostic = result?.diagnostics.find((candidate) => candidate.id === diagnosticId);

  if (diagnostic === undefined || result === null) {
    return <p className="text-sm leading-6 text-muted-foreground">{TOKEN_NOT_FOUND}</p>;
  }

  const position = positionAt(result.source, diagnostic.range.start);
  const explanation = DIAGNOSTIC_CODE_EXPLANATIONS[diagnostic.code];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {diagnostic.code}
        </Badge>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {diagnostic.severity}
        </Badge>
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {diagnostic.stage}
        </Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {position.line}:{position.col}
        </span>
      </div>
      <p className="text-sm leading-6">{diagnostic.message}</p>
      {explanation !== undefined ? (
        <p className="text-sm leading-6 text-muted-foreground">
          <span className="font-medium">
            {DIAGNOSTIC_WHY_LABEL} ({explanation.title}){' '}
          </span>
          {explanation.why}
        </p>
      ) : null}
      {diagnostic.notes !== undefined && diagnostic.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded border border-border bg-muted/40 p-2 text-xs leading-5">
          {diagnostic.notes.map((note, index) => (
            <li key={index} className="text-muted-foreground">
              note: {note.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SourceDetail({ selection }: { selection: Extract<Selection, { kind: 'source' }> }) {
  const result = useWorkspaceStore((state) => state.result);
  const highlights = useMemo(
    () => computeHighlights(selection, result),
    [selection, result],
  );
  const tokenIds = highlights.tokenIds;
  const tokens = result?.tokens ?? [];
  const overlapping = tokens.filter((token) => tokenIds.has(token.id));

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-xs text-muted-foreground">
        characters {selection.range.start}–{selection.range.end}
      </span>
      {overlapping.length === 0 ? (
        <p className="text-sm leading-6 text-muted-foreground">{SOURCE_RANGE_NONE}</p>
      ) : overlapping.length === 1 ? (
        <>
          <p className="text-sm leading-6">{SOURCE_RANGE_ONE}</p>
          <TokenDetail tokenId={overlapping[0].id} />
        </>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {sourceRangeMany(overlapping.length)}
        </p>
      )}
    </div>
  );
}

export function ExplanationPanel() {
  const activeStage = useWorkspaceStore((state) => state.activeStage);
  const selection = useWorkspaceStore((state) => state.selection);
  const result = useWorkspaceStore((state) => state.result);
  const stale = useWorkspaceStore((state) => state.stale);
  const stage = STAGE_EXPLANATIONS[activeStage];

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );

  return (
    <aside
      aria-label="Explanation panel"
      className="flex flex-col gap-4 rounded-md border border-border bg-background p-4"
    >
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Understanding {stage.label}</h2>
          <ProvenanceBadge kind="illustrative" />
        </div>
        <p className="text-xs text-muted-foreground">
          Teaching notes for this stage. The selected item is explained separately below.
        </p>
      </div>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Simple explanation
        </h3>
        <p className="text-sm leading-6">{stage.simple}</p>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Technical explanation
        </h3>
        <p className="text-sm leading-6 text-foreground/90">{stage.technical}</p>
      </section>

      <details className="group rounded-md border border-border bg-muted/30 px-3 py-2">
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Why it matters
          <span aria-hidden="true" className="ml-1 text-muted-foreground group-open:hidden">
            +
          </span>
          <span aria-hidden="true" className="ml-1 hidden text-muted-foreground group-open:inline">
            −
          </span>
        </summary>
        <p className="pt-2 text-sm leading-6">{stage.whyItMatters}</p>
      </details>

      <section className="flex flex-col gap-1.5 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Selected item
          </h3>
          <ProvenanceBadge kind="derived" />
        </div>
        {selection.kind === 'none' ? (
          <p className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            <MousePointer2 aria-hidden="true" className="mt-1 size-4 shrink-0" />
            {NOTHING_SELECTED}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Badge variant="outline" className="w-fit font-mono text-[0.7rem]">
              {selectionLabel(selection)}
            </Badge>
            {stale ? (
              <p className="text-sm leading-6 text-amber-900">{STALE_SELECTION_NOTE}</p>
            ) : highlights.unavailable !== undefined ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {highlights.unavailable}
              </p>
            ) : selection.kind === 'token' ? (
              <TokenDetail tokenId={selection.tokenId} />
            ) : selection.kind === 'source' ? (
              <SourceDetail selection={selection} />
            ) : selection.kind === 'ast' ? (
              <AstDetail nodeId={selection.nodeId} />
            ) : selection.kind === 'symbol' ? (
              <SymbolDetail symbolId={selection.symbolId} />
            ) : selection.kind === 'ir' ? (
              <IrDetail instrId={selection.instrId} />
            ) : selection.kind === 'diagnostic' ? (
              <DiagnosticDetail diagnosticId={selection.diagnosticId} />
            ) : (
              <p className="text-sm leading-6 text-muted-foreground">
                {SELECTION_DETAILS_PENDING}
              </p>
            )}
          </div>
        )}
      </section>
    </aside>
  );
}
