import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import { computeHighlights, createEmptyHighlights } from '@/lib/highlight';
import type { Selection } from '@/lib/store';

const PROGRAM = `int main() {
  int total = 1;
  return total;
}
`;

function firstTokenId(source: string, text: string): number {
  const result = compile(source);
  const token = result.tokens.find((candidate) => candidate.text === text);
  if (token === undefined) throw new Error(`No token ${text}`);
  return token.id;
}

describe('computeHighlights', () => {
  it('returns empty highlights for no selection', () => {
    const highlights = computeHighlights({ kind: 'none' }, compile(PROGRAM));
    expect(highlights).toEqual(createEmptyHighlights());
    expect(highlights.unavailable).toBeUndefined();
  });

  it('maps a token selection to its source range, primary token and AST chain', () => {
    const result = compile(PROGRAM);
    const token = result.tokens.findLast((candidate) => candidate.text === 'total');
    expect(token).toBeDefined();
    const selection: Selection = {
      kind: 'token',
      tokenId: token!.id,
      origin: 'stage',
    };

    const highlights = computeHighlights(selection, result);

    expect(highlights.primary).toEqual({ stage: 'lex', id: token!.id });
    expect(highlights.sourceRanges).toEqual([token!.range]);
    expect(highlights.tokenIds).toEqual(new Set([token!.id]));
    // Innermost node (DeclRefExpr) plus its ancestors up to the root.
    const node = Object.values(result.ast!.nodes).find(
      (candidate) => candidate.kind === 'DeclRefExpr' && candidate.name === 'total',
    );
    expect(node).toBeDefined();
    expect(highlights.astNodeIds.has(node!.id)).toBe(true);
    expect(highlights.astNodeIds.has(result.ast!.rootId)).toBe(true);
    expect(highlights.symbolIds.size).toBe(0);
    expect(highlights.irInstrIds.size).toBe(0);
    expect(highlights.unavailable).toBeUndefined();
  });

  it('maps a source selection to overlapping tokens', () => {
    const result = compile(PROGRAM);
    const returnToken = result.tokens.find((candidate) => candidate.text === 'return');
    const totalToken = result.tokens.findLast((candidate) => candidate.text === 'total');
    expect(returnToken).toBeDefined();
    expect(totalToken).toBeDefined();

    const range = {
      start: returnToken!.range.start,
      end: totalToken!.range.end,
    };
    const highlights = computeHighlights(
      { kind: 'source', range, origin: 'editor' },
      result,
    );

    expect(highlights.sourceRanges).toEqual([range]);
    expect(highlights.tokenIds).toEqual(new Set([returnToken!.id, totalToken!.id]));
    expect(highlights.primary).toBeNull();
    // Innermost node containing the range is the ReturnStmt; its ancestors follow.
    const returnStatement = Object.values(result.ast!.nodes).find(
      (candidate) => candidate.kind === 'ReturnStmt',
    );
    expect(returnStatement).toBeDefined();
    expect(highlights.astNodeIds.has(returnStatement!.id)).toBe(true);
    expect(highlights.astNodeIds.has(result.ast!.rootId)).toBe(true);
    expect(highlights.unavailable).toBeUndefined();
  });

  it('finds the token under a zero-length caret selection', () => {
    const result = compile(PROGRAM);
    const token = result.tokens.find((candidate) => candidate.text === 'main');
    expect(token).toBeDefined();
    const position = token!.range.start + 1;

    const highlights = computeHighlights(
      { kind: 'source', range: { start: position, end: position }, origin: 'editor' },
      result,
    );

    expect(highlights.tokenIds).toEqual(new Set([token!.id]));
  });

  it('maps a diagnostic selection to its range and overlapping tokens', () => {
    const result = compile('int a = 2147483648;');
    const diagnostic = result.diagnostics[0];
    expect(diagnostic).toBeDefined();

    const highlights = computeHighlights(
      { kind: 'diagnostic', diagnosticId: diagnostic.id, origin: 'stage' },
      result,
    );

    expect(highlights.sourceRanges).toEqual([diagnostic.range]);
    expect(highlights.tokenIds.size).toBe(1);
    expect(highlights.unavailable).toBeUndefined();
  });

  it('maps an AST selection to its node, descendants, source range and tokens', () => {
    const result = compile('int main() { return 1 + 2; }');
    expect(result.ast).not.toBeNull();
    const binary = Object.values(result.ast!.nodes).find(
      (candidate) => candidate.kind === 'BinaryOperator' && candidate.op === '+',
    );
    expect(binary).toBeDefined();

    const highlights = computeHighlights(
      { kind: 'ast', nodeId: binary!.id, origin: 'stage' },
      result,
    );

    expect(highlights.primary).toEqual({ stage: 'parse', id: binary!.id });
    expect(highlights.sourceRanges).toEqual([binary!.range]);
    expect(result.source.slice(binary!.range.start, binary!.range.end)).toBe('1 + 2');
    expect(highlights.astNodeIds).toEqual(
      new Set([binary!.id, ...binary!.childIds]),
    );
    const insideTokenIds = result.tokens
      .filter(
        (token) =>
          token.range.start >= binary!.range.start && token.range.end <= binary!.range.end,
      )
      .map((token) => token.id);
    expect(highlights.tokenIds).toEqual(new Set(insideTokenIds));
    expect(highlights.tokenIds.size).toBe(3);
    expect(highlights.unavailable).toBeUndefined();
  });

  it('returns a clear unavailable reason for mappings that cannot be made', () => {
    const result = compile(PROGRAM);
    for (const selection of [
      { kind: 'symbol', symbolId: 999, origin: 'stage' },
      { kind: 'ir', instrId: 999, origin: 'stage' },
    ] as Selection[]) {
      const highlights = computeHighlights(selection, result);
      expect(highlights.unavailable).toBeTruthy();
      expect(highlights.sourceRanges).toEqual([]);
    }

    // A program with a syntax error has no symbol table or IR to map into.
    const broken = compile('int main() { return 1 }');
    for (const selection of [
      { kind: 'symbol', symbolId: 1, origin: 'stage' },
      { kind: 'ir', instrId: 1, origin: 'stage' },
    ] as Selection[]) {
      const highlights = computeHighlights(selection, broken);
      expect(highlights.unavailable).toBeTruthy();
    }

    const missingNode = computeHighlights(
      { kind: 'ast', nodeId: 999, origin: 'stage' },
      result,
    );
    expect(missingNode.unavailable).toBeTruthy();

    const parseError = compile('int main() { return 1 }');
    expect(parseError.ast).toBeNull();
    const noTree = computeHighlights(
      { kind: 'ast', nodeId: 1, origin: 'stage' },
      parseError,
    );
    expect(noTree.unavailable).toBeTruthy();
  });

  it('reports missing result, token and diagnostic ids without guessing', () => {
    const noResult = computeHighlights(
      { kind: 'token', tokenId: 0, origin: 'stage' },
      null,
    );
    expect(noResult.unavailable).toBeTruthy();

    const result = compile(PROGRAM);
    const missingToken = computeHighlights(
      { kind: 'token', tokenId: 999, origin: 'stage' },
      result,
    );
    expect(missingToken.unavailable).toBeTruthy();

    const missingDiagnostic = computeHighlights(
      { kind: 'diagnostic', diagnosticId: 999, origin: 'stage' },
      result,
    );
    expect(missingDiagnostic.unavailable).toBeTruthy();
  });

  it('does not mutate the compile result', () => {
    const result = compile(PROGRAM);
    const before = JSON.stringify(result);
    const id = firstTokenId(PROGRAM, 'int');
    computeHighlights({ kind: 'token', tokenId: id, origin: 'stage' }, result);
    expect(JSON.stringify(result)).toBe(before);
  });

  it('returns fresh sets each time', () => {
    const a = createEmptyHighlights();
    const b = createEmptyHighlights();
    a.tokenIds.add(1);
    expect(b.tokenIds.size).toBe(0);
  });
});
