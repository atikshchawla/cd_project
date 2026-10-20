import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import { tokenize } from '@/lib/compiler/lexer';
import { parse } from '@/lib/compiler/parser';
import type { Ast, AstKind, AstNode, Diagnostic, Token } from '@/lib/compiler/types';

function parseSource(source: string): {
  ast: Ast | null;
  diagnostics: Diagnostic[];
  tokens: Token[];
} {
  const lexed = tokenize(source);
  expect(lexed.diagnostics).toEqual([]);
  const parsed = parse(lexed.tokens, source);
  return { ...parsed, tokens: lexed.tokens };
}

function nodesOfKind(ast: Ast, kind: AstKind): AstNode[] {
  return Object.values(ast.nodes).filter((node) => node.kind === kind);
}

function textOf(source: string, node: AstNode): string {
  return source.slice(node.range.start, node.range.end);
}

describe('parser', () => {
  it('builds a tree with exact ranges and consistent links', () => {
    const source = 'int main() {\n  return 0;\n}\n';
    const { ast, diagnostics } = parseSource(source);

    expect(diagnostics).toEqual([]);
    expect(ast).not.toBeNull();
    expect(ast!.rootId).toBe(0);
    const root = ast!.nodes[ast!.rootId];
    expect(root.kind).toBe('TranslationUnit');
    expect(root.range).toEqual({ start: 0, end: source.length });
    expect(root.parentId).toBeNull();
    expect(root.childIds).toHaveLength(1);

    const [functionId] = root.childIds;
    const functionNode = ast!.nodes[functionId];
    expect(functionNode.kind).toBe('FunctionDecl');
    expect(functionNode.name).toBe('main');
    expect(textOf(source, functionNode)).toBe('int main() {\n  return 0;\n}');

    const [blockId] = functionNode.childIds;
    const block = ast!.nodes[blockId];
    expect(block.kind).toBe('CompoundStmt');
    expect(textOf(source, block)).toBe('{\n  return 0;\n}');

    const [returnId] = block.childIds;
    const returnNode = ast!.nodes[returnId];
    expect(returnNode.kind).toBe('ReturnStmt');
    expect(textOf(source, returnNode)).toBe('return 0;');

    const [literalId] = returnNode.childIds;
    const literal = ast!.nodes[literalId];
    expect(literal.kind).toBe('IntegerLiteral');
    expect(literal.value).toBe(0);
    expect(textOf(source, literal)).toBe('0');

    // Every node has contiguous ids and consistent parent/child links.
    const nodes = Object.values(ast!.nodes);
    expect(nodes.map((node) => node.id).sort((a, b) => a - b)).toEqual(
      nodes.map((_, index) => index),
    );
    for (const node of nodes) {
      for (const childId of node.childIds) {
        expect(ast!.nodes[childId].parentId).toBe(node.id);
      }
      if (node.parentId !== null) {
        expect(ast!.nodes[node.parentId].childIds).toContain(node.id);
      }
    }
  });

  it('parses parameters, prototypes and global declarations', () => {
    const source = 'int add(int a, int b);\nint g = 1 + 2;\nvoid noop(void);\n';
    const { ast, diagnostics } = parseSource(source);

    expect(diagnostics).toEqual([]);
    const functions = nodesOfKind(ast!, 'FunctionDecl');
    expect(functions.map((node) => node.name)).toEqual(['add', 'noop']);
    expect(functions[0].childIds).toHaveLength(2);
    const parameters = nodesOfKind(ast!, 'ParamDecl');
    expect(parameters.map((node) => node.name)).toEqual(['a', 'b']);
    expect(textOf(source, parameters[0])).toBe('int a');

    const global = nodesOfKind(ast!, 'VarDecl')[0];
    expect(global.name).toBe('g');
    // The declaration range covers the declarator and initialiser, not the ';'.
    expect(textOf(source, global)).toBe('int g = 1 + 2');
    const init = ast!.nodes[global.childIds[0]];
    expect(init.kind).toBe('BinaryOperator');
    expect(init.op).toBe('+');
    expect(nodesOfKind(ast!, 'CompoundStmt')).toHaveLength(0);
  });

  it('ignores directive tokens', () => {
    const source = '#include <stdio.h>\nint main() { return 0; }';
    const { ast, diagnostics } = parseSource(source);

    expect(diagnostics).toEqual([]);
    expect(ast!.nodes[ast!.rootId].childIds).toHaveLength(1);
    expect(ast!.nodes[ast!.nodes[ast!.rootId].childIds[0]].kind).toBe('FunctionDecl');
  });

  it('applies multiplicative precedence over additive', () => {
    const first = parseSource('int main() { return 2 + 3 * 4; }').ast!;
    const firstRoot = nodesOfKind(first, 'BinaryOperator').find(
      (node) => node.op === '+',
    )!;
    expect(first.nodes[firstRoot.childIds[0]].kind).toBe('IntegerLiteral');
    expect(first.nodes[firstRoot.childIds[0]].value).toBe(2);
    expect(first.nodes[firstRoot.childIds[1]].op).toBe('*');

    const second = parseSource('int main() { return 2 * 3 + 4; }').ast!;
    const secondRoot = nodesOfKind(second, 'BinaryOperator').find(
      (node) => node.op === '+',
    )!;
    expect(second.nodes[secondRoot.childIds[0]].op).toBe('*');
    expect(second.nodes[secondRoot.childIds[1]].kind).toBe('IntegerLiteral');
    expect(second.nodes[secondRoot.childIds[1]].value).toBe(4);
  });

  it('applies comparison, equality and logical precedence', () => {
    const { ast } = parseSource('int main() { return a < b == c && d; }');
    const andNode = nodesOfKind(ast!, 'BinaryOperator').find((node) => node.op === '&&')!;
    const equalityNode = ast!.nodes[andNode.childIds[0]];
    expect(equalityNode.op).toBe('==');
    const relationalNode = ast!.nodes[equalityNode.childIds[0]];
    expect(relationalNode.op).toBe('<');
    expect(relationalNode.childIds).toHaveLength(2);
  });

  it('keeps additive and multiplicative operators left-associative', () => {
    const { ast } = parseSource('int main() { return 1 - 2 - 3; }');
    const root = nodesOfKind(ast!, 'BinaryOperator').findLast((node) => node.op === '-')!;
    const left = ast!.nodes[root.childIds[0]];
    expect(left.op).toBe('-');
    expect(ast!.nodes[root.childIds[1]].kind).toBe('IntegerLiteral');
    expect(ast!.nodes[root.childIds[1]].value).toBe(3);
  });

  it('keeps assignment right-associative and typed correctly', () => {
    const { ast } = parseSource('int main() { int a; int b; int c; a = b = c; return a; }');
    const assignment = nodesOfKind(ast!, 'BinaryOperator').find((node) => node.op === '=')!;
    expect(assignment.childIds).toHaveLength(2);
    const right = ast!.nodes[assignment.childIds[1]];
    expect(right.kind).toBe('BinaryOperator');
    expect(right.op).toBe('=');
    expect(ast!.nodes[assignment.childIds[0]].kind).toBe('DeclRefExpr');

    const compound = parseSource('int main() { int a; a += 1; return a; }').ast!;
    const compoundAssign = nodesOfKind(compound, 'CompoundAssignOperator')[0];
    expect(compoundAssign.op).toBe('+=');
  });

  it('parses unary, prefix and postfix operators', () => {
    const source = 'int main() { int i; int a; a = -i + !i; ++i; i++; i--; return a; }';
    const { ast } = parseSource(source);
    const unaries = nodesOfKind(ast!, 'UnaryOperator');
    expect(unaries.map((node) => node.op).sort()).toEqual([
      'postfix++',
      'postfix--',
      'prefix!',
      'prefix++',
      'prefix-',
    ]);
  });

  it('keeps ParenExpr nodes', () => {
    const source = 'int main() { return (1 + 2) * 3; }';
    const { ast } = parseSource(source);
    const parens = nodesOfKind(ast!, 'ParenExpr');
    expect(parens).toHaveLength(1);
    expect(textOf(source, parens[0])).toBe('(1 + 2)');
    const multiplication = nodesOfKind(ast!, 'BinaryOperator').find(
      (node) => node.op === '*',
    )!;
    expect(ast!.nodes[multiplication.childIds[0]].kind).toBe('ParenExpr');
  });

  it('parses function calls with arguments', () => {
    const source = 'int f(int x);\nint main() { return f(1, 2); }';
    const { ast } = parseSource(source);
    const call = nodesOfKind(ast!, 'CallExpr')[0];
    expect(textOf(source, call)).toBe('f(1, 2)');
    expect(call.childIds).toHaveLength(3);
    expect(ast!.nodes[call.childIds[0]].kind).toBe('DeclRefExpr');
    expect(call.childIds.slice(1).map((id) => ast!.nodes[id].value)).toEqual([1, 2]);

    const emptyCall = parseSource('int f(void);\nint main() { return f(); }').ast!;
    expect(nodesOfKind(emptyCall, 'CallExpr')[0].childIds).toHaveLength(1);
  });

  it('parses if/else, while, for, break, continue and empty statements', () => {
    const source = `int main() {
  int i;
  for (i = 0; i < 3; i = i + 1) {
    if (i == 1) continue; else break;
  }
  while (i) i--;
  ;
  return i;
}
`;
    const { ast, diagnostics } = parseSource(source);
    expect(diagnostics).toEqual([]);

    const forLoop = nodesOfKind(ast!, 'ForStmt')[0];
    expect(forLoop.childIds).toHaveLength(4);
    const ifStatement = nodesOfKind(ast!, 'IfStmt')[0];
    expect(ifStatement.childIds).toHaveLength(3);
    expect(textOf(source, ifStatement)).toBe('if (i == 1) continue; else break;');
    expect(nodesOfKind(ast!, 'ContinueStmt')).toHaveLength(1);
    expect(nodesOfKind(ast!, 'BreakStmt')).toHaveLength(1);
    expect(nodesOfKind(ast!, 'WhileStmt')).toHaveLength(1);
    expect(nodesOfKind(ast!, 'NullStmt')).toHaveLength(1);
    const body = ast!.nodes[nodesOfKind(ast!, 'CompoundStmt')[1].id];
    expect(body.kind).toBe('CompoundStmt');
  });

  it('parses a for loop with a declaration initialiser', () => {
    const source = 'int main() { for (int i = 0; i < 3; i++) { } return 0; }';
    const { ast } = parseSource(source);
    const forLoop = nodesOfKind(ast!, 'ForStmt')[0];
    expect(forLoop.childIds).toHaveLength(4);
    expect(ast!.nodes[forLoop.childIds[0]].kind).toBe('VarDecl');
    expect(ast!.nodes[forLoop.childIds[1]].op).toBe('<');
    expect(ast!.nodes[forLoop.childIds[2]].op).toBe('postfix++');
    expect(ast!.nodes[forLoop.childIds[3]].kind).toBe('CompoundStmt');
  });

  it('parses void functions and valueless return', () => {
    const source = 'void f(void) { return; }';
    const { ast } = parseSource(source);
    const returnNode = nodesOfKind(ast!, 'ReturnStmt')[0];
    expect(returnNode.childIds).toHaveLength(0);
    expect(textOf(source, returnNode)).toBe('return;');
  });

  it('reports a missing semicolon at the end of the previous token (E2001)', () => {
    const source = 'int main() { return 1 }';
    const { ast, diagnostics } = parseSource(source);

    expect(ast).toBeNull();
    expect(diagnostics).toHaveLength(1);
    const literalEnd = tokenize(source).tokens.find(
      (token) => token.text === '1',
    )!.range.end;
    expect(diagnostics[0]).toMatchObject({ code: 'E2001', stage: 'parse' });
    expect(diagnostics[0].range).toEqual({ start: literalEnd, end: literalEnd });
    expect(diagnostics[0].message).toContain("expected ';'");
  });

  it('reports the first unexpected token with its range (E2002)', () => {
    const source = 'int main() { return 0; } }';
    const { ast, diagnostics } = parseSource(source);

    expect(ast).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'E2002', stage: 'parse' });
    const strayBrace = tokenize(source).tokens.findLast(
      (token) => token.text === '}',
    )!;
    expect(diagnostics[0].range).toEqual(strayBrace.range);
    expect(diagnostics[0].message).toContain("unexpected token '}'");

    const emptyInitialiser = parseSource('int x = ;');
    expect(emptyInitialiser.ast).toBeNull();
    expect(emptyInitialiser.diagnostics[0].code).toBe('E2002');

    const notAnIdentifier = parseSource('int 1;');
    expect(notAnIdentifier.ast).toBeNull();
    expect(notAnIdentifier.diagnostics[0].code).toBe('E2001');

    const strayExpression = parseSource('x;');
    expect(strayExpression.ast).toBeNull();
    expect(strayExpression.diagnostics[0].code).toBe('E2002');
    expect(strayExpression.diagnostics[0].message).toContain('at file scope');
  });

  it('reports reserved words as unsupported (E1010)', () => {
    for (const source of ['char x;', 'int main() { switch (x) { } }', 'int main() { do ; }']) {
      const { ast, diagnostics } = parseSource(source);
      expect(ast).toBeNull();
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ code: 'E1010', stage: 'unsupported' });
      expect(diagnostics[0].message).toContain('does not support');
      expect(diagnostics[0].notes?.[0]?.message).toContain('Supported types are int and void');
    }
  });

  it('reports an unclosed block at the end of input', () => {
    const { ast, diagnostics } = parseSource('int main() {');
    expect(ast).toBeNull();
    expect(diagnostics[0].code).toBe('E2002');
    expect(diagnostics[0].message).toContain('unexpected end of input');
  });

  it('reports only the first syntax error and never partially succeeds', () => {
    const { ast, diagnostics } = parseSource('int main() { int a = ; return }');
    expect(ast).toBeNull();
    expect(diagnostics).toHaveLength(1);
  });

  it('never throws and produces deterministic output', () => {
    const source = 'int main() { return 2 + 3 * 4; }';
    expect(() => parseSource(source)).not.toThrow();
    const first = compile(source);
    const second = compile(source);
    expect(second).toEqual(first);
    expect(first.completed).toMatchObject({ lex: 'ok', parse: 'ok', sema: 'ok' });
    expect(first.ast).not.toBeNull();
  });
});
