import { describe, expect, it } from 'vitest';
import { tokenize } from '@/lib/compiler/lexer';
import type { Token } from '@/lib/compiler/types';

function normalise(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

function expectRangesToMatchSource(source: string, tokens: Token[]) {
  const text = normalise(source);
  for (const token of tokens) {
    expect(text.slice(token.range.start, token.range.end)).toBe(token.text);
  }
}

describe('lexer', () => {
  it('produces all six token kinds', () => {
    const source = `#include <stdio.h>
int main() {
  int x = 42;
  return x + 1;
}
`;
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(new Set(tokens.map((token) => token.kind))).toEqual(
      new Set(['directive', 'keyword', 'identifier', 'integer-literal', 'operator', 'punctuator']),
    );
    expect(tokens[0]).toMatchObject({
      kind: 'directive',
      text: '#include <stdio.h>',
      line: 1,
      col: 1,
    });
    expectRangesToMatchSource(source, tokens);
  });

  it('lexes supported and reserved words as keywords without lexer diagnostics', () => {
    const source =
      'int void if else while for return break continue char struct float double long unsigned switch case default goto typedef enum union static const sizeof do class new delete namespace template';
    const { tokens, diagnostics } = tokenize(source);

    expect(tokens).toHaveLength(31);
    expect(tokens.every((token) => token.kind === 'keyword')).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it('uses longest-match for operators', () => {
    const source = '++ -- += -= *= /= %= == != <= >= && || + - * / % < > = !';
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(tokens.map((token) => token.text)).toEqual([
      '++', '--', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||',
      '+', '-', '*', '/', '%', '<', '>', '=', '!',
    ]);
    expect(tokens.every((token) => token.kind === 'operator')).toBe(true);
  });

  it('lexes punctuators', () => {
    const { tokens } = tokenize('( ) { } ; ,');
    expect(tokens.map((token) => token.text)).toEqual(['(', ')', '{', '}', ';', ',']);
    expect(tokens.every((token) => token.kind === 'punctuator')).toBe(true);
  });

  it('lexes identifiers and integer literals with exact ranges', () => {
    const source = '_x1 A_b2 0 2147483647';
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(tokens.map((token) => [token.kind, token.text])).toEqual([
      ['identifier', '_x1'],
      ['identifier', 'A_b2'],
      ['integer-literal', '0'],
      ['integer-literal', '2147483647'],
    ]);
    expectRangesToMatchSource(source, tokens);
    expect(tokens.map((token) => token.id)).toEqual([0, 1, 2, 3]);
  });

  it('tracks 1-based line/column positions across tabs and CRLF', () => {
    const source = 'int\tx;\r\nint y;';
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(
      tokens.map((token) => [token.text, token.line, token.col, token.endLine, token.endCol]),
    ).toEqual([
      ['int', 1, 1, 1, 4],
      ['x', 1, 5, 1, 6],
      [';', 1, 6, 1, 7],
      ['int', 2, 1, 2, 4],
      ['y', 2, 5, 2, 6],
      [';', 2, 6, 2, 7],
    ]);
    expectRangesToMatchSource(source, tokens);
  });

  it('skips line and block comments but counts their newlines', () => {
    const source = 'int a; // one\n/* two\nthree */int b;\n';
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(tokens.map((token) => token.text)).toEqual(['int', 'a', ';', 'int', 'b', ';']);
    expect(tokens[3]).toMatchObject({ line: 3, col: 9 });
  });

  it('handles a line comment at end of file', () => {
    expect(tokenize('// nothing here').tokens).toEqual([]);
    expect(tokenize('// nothing here').diagnostics).toEqual([]);
  });

  it('reports an unterminated block comment with E1002 and keeps earlier tokens', () => {
    const source = 'int a; /* not closed';
    const { tokens, diagnostics } = tokenize(source);

    expect(tokens.map((token) => token.text)).toEqual(['int', 'a', ';']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'E1002',
      stage: 'lex',
      severity: 'error',
    });
    expect(diagnostics[0].range).toEqual({ start: 7, end: source.length });
  });

  it('reports unsupported characters as E1010 and continues lexing', () => {
    const source = '& | ^ ~ ? : . [ ] " \'';
    const { tokens, diagnostics } = tokenize(source);

    expect(tokens).toEqual([]);
    expect(diagnostics).toHaveLength(11);
    expect(diagnostics.every((diagnostic) => diagnostic.code === 'E1010')).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.stage === 'unsupported')).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);

    const continued = tokenize('int a = 1; & int b = 2;');
    expect(continued.diagnostics).toHaveLength(1);
    expect(continued.tokens.map((token) => token.text)).toContain('b');
  });

  it('reports truly invalid characters as E1001', () => {
    const control = tokenize('int a;\u0001');
    expect(control.diagnostics).toHaveLength(1);
    expect(control.diagnostics[0]).toMatchObject({ code: 'E1001', stage: 'lex' });
    expect(control.diagnostics[0].range).toEqual({ start: 6, end: 7 });

    const nonAscii = tokenize('int €;');
    expect(nonAscii.diagnostics).toHaveLength(1);
    expect(nonAscii.diagnostics[0]).toMatchObject({ code: 'E1001', stage: 'lex' });
    expect(nonAscii.diagnostics[0].message).toContain('U+20AC');
  });

  it('rejects a # that is not at the start of a line', () => {
    const { tokens, diagnostics } = tokenize('int a # b;');
    expect(tokens.map((token) => token.text)).toEqual(['int', 'a', 'b', ';']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'E1001', stage: 'lex' });
  });

  it('lexes #include as one ignored directive token', () => {
    const source = '#include <stdio.h>\nint main() { return 0; }';
    const { tokens, diagnostics } = tokenize(source);

    expect(diagnostics).toEqual([]);
    expect(tokens[0].kind).toBe('directive');
    expect(tokens[0].text).toBe('#include <stdio.h>');
    expect(tokens[0].range).toEqual({ start: 0, end: 18 });
  });

  it('reports other directives as unsupported E1010 but still emits one directive token', () => {
    const { tokens, diagnostics } = tokenize('#define X 1\nint a;');
    expect(tokens[0]).toMatchObject({ kind: 'directive', text: '#define X 1' });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'E1010', stage: 'unsupported' });
  });

  it('reports integer literals above 2147483647 as E1004', () => {
    const { tokens, diagnostics } = tokenize('2147483648 999999999999999999999');
    expect(tokens).toHaveLength(2);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.code === 'E1004')).toBe(true);
    expect(diagnostics.every((diagnostic) => diagnostic.stage === 'lex')).toBe(true);
    expect(diagnostics[0].range).toEqual({ start: 0, end: 10 });
    expect(diagnostics[1].range).toEqual({ start: 11, end: 32 });
  });

  it('assigns diagnostic ids in order', () => {
    const { diagnostics } = tokenize('& 2147483648 "');
    expect(diagnostics.map((diagnostic) => diagnostic.id)).toEqual([1, 2, 3]);
  });

  it('never throws and returns nothing for empty or non-string input', () => {
    expect(tokenize('')).toEqual({ tokens: [], diagnostics: [] });
    expect(tokenize(undefined as unknown as string)).toEqual({ tokens: [], diagnostics: [] });
    expect(tokenize(null as unknown as string)).toEqual({ tokens: [], diagnostics: [] });
  });
});
