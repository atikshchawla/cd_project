import { describe, expect, it } from 'vitest';
import { COMPILER_VERSION, compile, normaliseSource } from '@/lib/compiler';
import type { Stage } from '@/lib/compiler/types';
import { hashSource } from '@/lib/hash';

const ALL_STAGES: Stage[] = ['source', 'lex', 'parse', 'sema', 'ir', 'asm'];

describe('compiler pipeline (lexer milestone)', () => {
  it('normalises CRLF and bare CR to LF', () => {
    expect(normaliseSource('int a;\r\nint b;\rint c;\n')).toBe('int a;\nint b;\nint c;\n');
  });

  it('returns the normalised source and a matching deterministic hash', () => {
    const source = 'int main() {\r\n  return 0;\r\n}\r\n';
    const first = compile(source);
    const second = compile(source);

    expect(first.source).toBe('int main() {\n  return 0;\n}\n');
    expect(first.sourceHash).toBe(hashSource(first.source));
    expect(second).toEqual(first);
  });

  it('is JSON-serialisable and contains no cycles', () => {
    const result = compile('int main() { return 0; }');
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTripped).toEqual(result);
  });

  it('reports every stage status and produces tokens, tree, symbols and IR', () => {
    const result = compile('int main() { return 0; }');

    expect(Object.keys(result.completed).sort()).toEqual([...ALL_STAGES].sort());
    expect(result.completed).toMatchObject({
      source: 'ok',
      lex: 'ok',
      parse: 'ok',
      sema: 'ok',
      ir: 'ok',
      asm: 'blocked',
    });
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.ast).not.toBeNull();
    expect(result.symbols).not.toBeNull();
    expect(result.ir).not.toBeNull();
    expect(result.asm).toBeNull();
    expect(result.diagnostics).toEqual([]);
    expect(result.meta.compilerVersion).toBe(COMPILER_VERSION);
    expect(result.meta.target).toBe('Mini-C (educational)');
    expect(result.meta.flags).toEqual(['-O0']);
  });

  it('marks the parser failed and never runs later stages after a syntax error', () => {
    const result = compile('int main() { return 1 }');

    expect(result.completed).toMatchObject({
      lex: 'ok',
      parse: 'failed',
      sema: 'blocked',
      ir: 'blocked',
    });
    expect(result.ast).toBeNull();
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'E2001', stage: 'parse' });
  });

  it('marks the lexer failed and never runs later stages after a lexical error', () => {
    const result = compile('int a = 2147483648;');

    expect(result.completed.lex).toBe('failed');
    expect(result.completed.parse).toBe('blocked');
    expect(result.completed.sema).toBe('blocked');
    expect(result.completed.ir).toBe('blocked');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'E1004', stage: 'lex' });
    expect(result.tokens.map((token) => token.text)).toContain('2147483648');
  });

  it('never throws, even for non-string runtime input', () => {
    expect(() => compile('')).not.toThrow();
    expect(() => compile(undefined as unknown as string)).not.toThrow();
    expect(() => compile(null as unknown as string)).not.toThrow();

    const result = compile(undefined as unknown as string);
    expect(result.source).toBe('');
    expect(result.sourceHash).toBe(hashSource(''));
    expect(result.tokens).toEqual([]);
  });
});
