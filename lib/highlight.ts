import type { Ast, AstNode, CompileResult, Range, Stage } from '@/lib/compiler/types';
import type { OptimizationResult } from '@/lib/compiler';
import type { Selection } from '@/lib/store';

export type SelectionTint = 'source' | 'lex' | 'parse' | 'sema' | 'ir' | 'asm' | 'diagnostic';

/**
 * Which pastel tint to paint the primary highlight with, depending on the
 * selected part: tokens tint peach, syntax lavender, symbols mint, IR sky,
 * assembly rose, diagnostics by their reporting stage.
 */
export function selectionTint(selection: Selection, result: CompileResult | null): SelectionTint {
  switch (selection.kind) {
    case 'token':
      return 'lex';
    case 'ast':
      return 'parse';
    case 'symbol':
      return 'sema';
    case 'ir':
      return 'ir';
    case 'opt':
      // An optimisation change is still an IR-to-source mapping; the shared
      // primary/related tokens do the painting (SPEC 7.3).
      return 'ir';
    case 'asm':
      return 'asm';
    case 'diagnostic': {
      const diagnostic = result?.diagnostics.find(
        (candidate) => candidate.id === selection.diagnosticId,
      );
      if (diagnostic === undefined) return 'diagnostic';
      switch (diagnostic.stage) {
        case 'lex':
          return 'lex';
        case 'parse':
          return 'parse';
        case 'sema':
          return 'sema';
        default:
          return 'diagnostic';
      }
    }
    default:
      return 'source';
  }
}

export interface Highlights {
  primary: { stage: Stage; id: number } | null;
  sourceRanges: Range[];
  tokenIds: Set<number>;
  astNodeIds: Set<number>;
  symbolIds: Set<number>;
  /** Instruction IDs in the **original** IR module. */
  irInstrIds: Set<number>;
  /** Instruction IDs in the **optimised** clone (Optimization stage only). */
  optInstrIds: Set<number>;
  /** The change a `{ kind: 'opt' }` selection points at, for row emphasis. */
  optChangeId: number | null;
  unavailable?: string;
}

export function createEmptyHighlights(): Highlights {
  return {
    primary: null,
    sourceRanges: [],
    tokenIds: new Set<number>(),
    astNodeIds: new Set<number>(),
    symbolIds: new Set<number>(),
    irInstrIds: new Set<number>(),
    optInstrIds: new Set<number>(),
    optChangeId: null,
  };
}

function spanOf(range: Range): number {
  return range.end - range.start;
}

function nodeDepths(ast: Ast): Map<number, number> {
  const depths = new Map<number, number>([[ast.rootId, 0]]);
  const queue = [ast.rootId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = ast.nodes[nodeId];
    if (node === undefined) continue;
    for (const childId of node.childIds) {
      if (!depths.has(childId)) {
        depths.set(childId, (depths.get(nodeId) ?? 0) + 1);
        queue.push(childId);
      }
    }
  }
  return depths;
}

/** Innermost node whose range contains `range` (smallest span, then deepest). */
function innermostNode(ast: Ast, range: Range): AstNode | null {
  const depths = nodeDepths(ast);
  let best: AstNode | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  let bestDepth = -1;

  for (const node of Object.values(ast.nodes)) {
    const contains =
      range.start === range.end
        ? node.range.start <= range.start && range.start <= node.range.end
        : node.range.start <= range.start && range.end <= node.range.end;
    if (!contains) continue;
    const span = spanOf(node.range);
    const depth = depths.get(node.id) ?? 0;
    if (span < bestSpan || (span === bestSpan && depth > bestDepth)) {
      best = node;
      bestSpan = span;
      bestDepth = depth;
    }
  }
  return best;
}

function descendantIds(ast: Ast, rootId: number): number[] {
  const ids: number[] = [];
  const stack = [rootId];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = ast.nodes[nodeId];
    if (node === undefined) continue;
    ids.push(nodeId);
    for (const childId of node.childIds) stack.push(childId);
  }
  return ids;
}

function ancestorIds(ast: Ast, nodeId: number): number[] {
  const ids: number[] = [];
  let currentId = ast.nodes[nodeId]?.parentId ?? null;
  const seen = new Set<number>();
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    ids.push(currentId);
    currentId = ast.nodes[currentId]?.parentId ?? null;
  }
  return ids;
}

function tokensOverlapping(result: CompileResult, range: Range): number[] {
  if (range.start === range.end) {
    return result.tokens
      .filter((token) => token.range.start <= range.start && range.start < token.range.end)
      .map((token) => token.id);
  }

  return result.tokens
    .filter((token) => token.range.start < range.end && token.range.end > range.start)
    .map((token) => token.id);
}

function tokensFullyInside(result: CompileResult, range: Range): number[] {
  return result.tokens
    .filter((token) => token.range.start >= range.start && token.range.end <= range.end)
    .map((token) => token.id);
}

function addNodeAndAncestors(highlights: Highlights, ast: Ast, node: AstNode): void {
  highlights.astNodeIds.add(node.id);
  for (const ancestorId of ancestorIds(ast, node.id)) {
    highlights.astNodeIds.add(ancestorId);
  }
}

/**
 * Compute the cross-stage highlights for one selection.
 *
 * Mapping is done with IDs and source ranges only. When a selection cannot be
 * mapped reliably, `unavailable` explains why instead of guessing.
 *
 * `optimization` is only consulted for `{ kind: 'opt' }` selections: it holds
 * the optimised clone and the per-instruction change records that tie an
 * optimised instruction back to the original one and, through its AST node, to
 * a source range. Every other selection kind maps exactly as before.
 */
export function computeHighlights(
  selection: Selection,
  result: CompileResult | null,
  optimization: OptimizationResult | null = null,
): Highlights {
  const highlights = createEmptyHighlights();

  if (result === null) {
    if (selection.kind !== 'none') {
      highlights.unavailable =
        'There is no compiler result to map this selection to yet. Compile the program first.';
    }
    return highlights;
  }

  switch (selection.kind) {
    case 'none':
      return highlights;

    case 'source': {
      highlights.sourceRanges = [selection.range];
      highlights.tokenIds = new Set(tokensOverlapping(result, selection.range));
      if (result.ast !== null) {
        const node = innermostNode(result.ast, selection.range);
        if (node !== null) addNodeAndAncestors(highlights, result.ast, node);
      }
      return highlights;
    }

    case 'token': {
      const token = result.tokens.find((candidate) => candidate.id === selection.tokenId);
      if (token === undefined) {
        highlights.unavailable =
          'This token is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.primary = { stage: 'lex', id: token.id };
      highlights.sourceRanges = [token.range];
      highlights.tokenIds = new Set([token.id]);
      if (result.ast !== null) {
        const node = innermostNode(result.ast, token.range);
        if (node !== null) addNodeAndAncestors(highlights, result.ast, node);
      }
      return highlights;
    }

    case 'ast': {
      const node = result.ast?.nodes[selection.nodeId];
      if (result.ast === null) {
        highlights.unavailable =
          'There is no syntax tree for this program, so this selection cannot be mapped.';
        return highlights;
      }
      if (node === undefined) {
        highlights.unavailable =
          'This syntax node is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.primary = { stage: 'parse', id: node.id };
      highlights.sourceRanges = [node.range];
      highlights.tokenIds = new Set(tokensFullyInside(result, node.range));
      highlights.astNodeIds = new Set([node.id, ...descendantIds(result.ast, node.id)]);
      return highlights;
    }

    case 'diagnostic': {
      const diagnostic = result.diagnostics.find(
        (candidate) => candidate.id === selection.diagnosticId,
      );
      if (diagnostic === undefined) {
        highlights.unavailable =
          'This diagnostic is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.sourceRanges = [diagnostic.range];
      highlights.tokenIds = new Set(tokensOverlapping(result, diagnostic.range));
      if (result.ast !== null) {
        const node = innermostNode(result.ast, diagnostic.range);
        if (node !== null) highlights.astNodeIds = new Set([node.id]);
      }
      return highlights;
    }

    case 'symbol': {
      const table = result.symbols;
      if (table === null) {
        highlights.unavailable =
          'There is no symbol table for this program, so this selection cannot be mapped.';
        return highlights;
      }
      const symbol = table.symbols.find((candidate) => candidate.id === selection.symbolId);
      if (symbol === undefined) {
        highlights.unavailable =
          'This symbol is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.primary = { stage: 'sema', id: symbol.id };
      const declNode = result.ast?.nodes[symbol.declNodeId];
      const useNodes = symbol.useNodeIds
        .map((nodeId) => result.ast?.nodes[nodeId])
        .filter((node): node is AstNode => node !== undefined);
      const mappedNodes = [...(declNode !== undefined ? [declNode] : []), ...useNodes];

      highlights.sourceRanges = mappedNodes.map((node) => node.range);
      highlights.astNodeIds = new Set(mappedNodes.map((node) => node.id));
      highlights.tokenIds = new Set(
        result.tokens
          .filter(
            (token) =>
              token.kind === 'identifier' &&
              mappedNodes.some((node) => token.range.start >= node.range.start && token.range.end <= node.range.end),
          )
          .map((token) => token.id),
      );

      // IR: the alloca carrying this variable's name plus the loads/stores
      // that use that pointer.
      if (result.ir !== null) {
        const { module } = result.ir;
        const alloca = Object.values(module.instrs).find(
          (instr) => instr.opcode === 'alloca' && instr.varName === symbol.name,
        );
        if (alloca !== undefined && alloca.result !== undefined) {
          const ptrName = alloca.result;
          highlights.irInstrIds.add(alloca.id);
          for (const instr of Object.values(module.instrs)) {
            if (instr.opcode !== 'load' && instr.opcode !== 'store') continue;
            const usesPtr = instr.operands.some(
              (operand) => operand.kind === 'value' && operand.name === ptrName,
            );
            if (usesPtr) highlights.irInstrIds.add(instr.id);
          }
        }
      }
      return highlights;
    }

    case 'ir': {
      if (result.ir === null) {
        highlights.unavailable =
          'There is no generated IR for this program, so this selection cannot be mapped.';
        return highlights;
      }
      const instr = result.ir.module.instrs[selection.instrId];
      if (instr === undefined) {
        highlights.unavailable =
          'This IR instruction is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.primary = { stage: 'ir', id: instr.id };
      highlights.irInstrIds = new Set(
        Object.values(result.ir.module.instrs)
          .filter((candidate) => candidate.astNodeId === instr.astNodeId)
          .map((candidate) => candidate.id),
      );

      const node = instr.astNodeId !== undefined ? result.ast?.nodes[instr.astNodeId] : undefined;
      if (node === undefined) {
        highlights.unavailable =
          'This is compiler scaffolding; it does not correspond to a source expression.';
        return highlights;
      }
      highlights.astNodeIds = new Set([node.id]);
      highlights.sourceRanges = [node.range];
      highlights.tokenIds = new Set(tokensFullyInside(result, node.range));
      return highlights;
    }

    case 'opt': {
      if (result.ir === null) {
        highlights.unavailable =
          'There is no generated IR for this program, so this selection cannot be mapped.';
        return highlights;
      }
      if (optimization === null) {
        highlights.unavailable =
          'There is no optimisation result yet — compile the program and open the Optimization stage.';
        return highlights;
      }
      const change = optimization.changes.find((candidate) => candidate.id === selection.changeId);
      if (change === undefined) {
        highlights.unavailable =
          'This transformation is not in the current pass selection. Toggle the passes again to refresh the list.';
        return highlights;
      }

      highlights.optChangeId = change.id;

      // Instructions involved: the original the change is about, whatever the
      // change left in its place, and everything the change rewrote or reused.
      const original = result.ir.module.instrs;
      const optimised = optimization.module.instrs;
      for (const instrId of [change.beforeInstrId, change.afterInstrId, ...change.relatedInstrIds]) {
        if (instrId === null) continue;
        if (original[instrId] !== undefined) highlights.irInstrIds.add(instrId);
        if (optimised[instrId] !== undefined) highlights.optInstrIds.add(instrId);
      }

      const before =
        change.beforeInstrId === null ? undefined : original[change.beforeInstrId];
      if (before !== undefined) highlights.primary = { stage: 'ir', id: before.id };

      // Source: this change's own instruction plus each instruction it rewrote,
      // so the highlighted ranges answer "which expressions changed".
      const ast = result.ast;
      const nodes: AstNode[] = [];
      const nodeIdOf = (nodeId: number | null | undefined): number | null => nodeId ?? null;
      const wanted = [nodeIdOf(change.astNodeId)];
      for (const instrId of change.relatedInstrIds) {
        wanted.push(nodeIdOf(original[instrId]?.astNodeId));
      }
      if (ast !== null) {
        for (const nodeId of wanted) {
          if (nodeId === null) continue;
          const node = ast.nodes[nodeId];
          if (node === undefined) continue;
          if (nodes.some((candidate) => candidate.id === node.id)) continue;
          nodes.push(node);
        }
      }

      if (nodes.length === 0) {
        highlights.unavailable =
          'This change is control-flow bookkeeping (a branch or a merge point) with no single source expression.';
        return highlights;
      }

      nodes.sort((a, b) => a.range.start - b.range.start);
      highlights.sourceRanges = nodes.map((node) => node.range);
      highlights.astNodeIds = new Set(nodes.map((node) => node.id));
      const tokenIds = new Set<number>();
      for (const node of nodes) {
        for (const tokenId of tokensFullyInside(result, node.range)) tokenIds.add(tokenId);
      }
      highlights.tokenIds = tokenIds;
      return highlights;
    }

    case 'asm': {
      if (result.asm === null) {
        highlights.unavailable =
          'There is no generated assembly for this program, so this selection cannot be mapped.';
        return highlights;
      }
      const line = result.asm.lines.find((candidate) => candidate.lineNo === selection.lineId);
      if (line === undefined) {
        highlights.unavailable =
          'This assembly line is not part of the current compile. Recompile and select it again.';
        return highlights;
      }

      highlights.primary = { stage: 'asm', id: line.lineNo };
      if (line.irInstrId === undefined || result.ir === null) {
        highlights.unavailable =
          'This line is a label, directive or prologue instruction. It is scaffolding without a single IR origin.';
        return highlights;
      }

      const instr = result.ir.module.instrs[line.irInstrId];
      if (instr === undefined) return highlights;
      highlights.irInstrIds = new Set(
        Object.values(result.ir.module.instrs)
          .filter((candidate) => candidate.astNodeId === instr.astNodeId && instr.astNodeId !== undefined)
          .map((candidate) => candidate.id),
      );
      highlights.irInstrIds.add(instr.id);

      const node = instr.astNodeId !== undefined ? result.ast?.nodes[instr.astNodeId] : undefined;
      if (node === undefined) {
        highlights.unavailable =
          'This is compiler scaffolding; it does not correspond to a source expression.';
        return highlights;
      }
      highlights.astNodeIds = new Set([node.id]);
      highlights.sourceRanges = [node.range];
      highlights.tokenIds = new Set(tokensFullyInside(result, node.range));
      return highlights;
    }
  }
}
