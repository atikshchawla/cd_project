import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import type { CompileResult, Diagnostic } from '@/lib/compiler/types';

function analyseCode(source: string): CompileResult {
  return compile(source);
}

function errorsOf(result: CompileResult): Diagnostic[] {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

function warningsOf(result: CompileResult): Diagnostic[] {
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');
}

function codesOf(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe('semantic analysis', () => {
  it('annotates the AST with types and builds a symbol table', () => {
    const result = analyseCode('int main() { int x = 1; return x; }');

    expect(result.completed.sema).toBe('ok');
    expect(result.symbols).not.toBeNull();
    const table = result.symbols!;
    const names = table.symbols.map((symbol) => symbol.name);
    expect(names).toContain('main');
    expect(names).toContain('x');

    const x = table.symbols.find((symbol) => symbol.name === 'x')!;
    expect(x.kind).toBe('local');
    expect(x.type).toEqual({ kind: 'int' });
    expect(x.useNodeIds.length).toBe(1);

    // The AST node for `x` in `return x` links back to its declaration.
    const ref = Object.values(result.ast!.nodes).find(
      (node) => node.kind === 'DeclRefExpr' && node.name === 'x',
    )!;
    expect(ref.refDeclId).toBe(x.declNodeId);
    expect(ref.type).toEqual({ kind: 'int' });
  });

  it('E3001: use of undeclared identifier (failing + passing)', () => {
    const failing = analyseCode('int main() { return y; }');
    expect(codesOf(errorsOf(failing))).toEqual(['E3001']);
    expect(failing.diagnostics[0].message).toContain("'y'");
    expect(failing.completed).toMatchObject({ sema: 'failed', ir: 'blocked' });

    const passing = analyseCode('int main() { int y = 2; return y; }');
    expect(errorsOf(passing)).toEqual([]);
  });

  it('E3001: calling an undeclared function (failing + passing)', () => {
    const failing = analyseCode('int main() { return f(); }');
    expect(codesOf(errorsOf(failing))).toEqual(['E3001']);
    expect(failing.diagnostics[0].message).toContain('undeclared function');

    const passing = analyseCode('int f(void) { return 1; } int main() { return f(); }');
    expect(errorsOf(passing)).toEqual([]);
  });

  it('E3002: redeclaration in the same scope, with a note (failing + passing)', () => {
    const failing = analyseCode('int main() { int x = 1; int x = 2; return x; }');
    expect(codesOf(errorsOf(failing))).toEqual(['E3002']);
    expect(failing.diagnostics[0].notes?.[0].message).toContain('previous declaration');

    const passing = analyseCode('int main() { int x = 1; { int x = 2; } return x; }');
    expect(errorsOf(passing)).toEqual([]);
  });

  it('allows shadowing in a nested scope and links uses to the inner declaration', () => {
    const result = analyseCode('int main() { int x = 1; { int x = 2; return x; } }');
    expect(errorsOf(result)).toEqual([]);

    const table = result.symbols!;
    const xs = table.symbols.filter((symbol) => symbol.name === 'x');
    expect(xs).toHaveLength(2);
    const outer = xs.find((symbol) => symbol.useNodeIds.length === 0)!;
    const inner = xs.find((symbol) => symbol.useNodeIds.length === 1)!;
    expect(outer.scopeId).not.toBe(inner.scopeId);
  });

  it('E3003: assignment to a non-lvalue and void misuse (failing + passing)', () => {
    const nonLvalue = analyseCode('int main() { 1 = 2; return 0; }');
    expect(codesOf(errorsOf(nonLvalue))).toContain('E3003');

    const voidValue = analyseCode('void f(void) { return; } int main() { int x = f(); return x; }');
    expect(codesOf(errorsOf(voidValue))).toContain('E3003');

    const passing = analyseCode('int main() { int x = 1; x = 2; return x; }');
    expect(errorsOf(passing)).toEqual([]);
  });

  it('E3004: wrong number of arguments (failing + passing)', () => {
    const tooMany = analyseCode(
      'int add(int a, int b) { return a + b; } int main() { return add(1, 2, 3); }',
    );
    expect(codesOf(errorsOf(tooMany))).toEqual(['E3004']);
    expect(tooMany.diagnostics[0].message).toContain('expected 2, have 3');

    const tooFew = analyseCode(
      'int add(int a, int b) { return a + b; } int main() { return add(1); }',
    );
    expect(codesOf(errorsOf(tooFew))).toEqual(['E3004']);

    const passing = analyseCode(
      'int add(int a, int b) { return a + b; } int main() { return add(1, 2); }',
    );
    expect(errorsOf(passing)).toEqual([]);
  });

  it('E3006: break/continue outside a loop (failing + passing)', () => {
    const failingBreak = analyseCode('int main() { break; return 0; }');
    expect(codesOf(errorsOf(failingBreak))).toEqual(['E3006']);

    const failingContinue = analyseCode('int main() { continue; return 0; }');
    expect(codesOf(errorsOf(failingContinue))).toEqual(['E3006']);

    const passing = analyseCode('int main() { while (1) { break; } return 0; }');
    expect(errorsOf(passing)).toEqual([]);

    const passingFor = analyseCode('int main() { for (int i = 0; i < 3; i++) { continue; } return 0; }');
    expect(errorsOf(passingFor)).toEqual([]);
  });

  it('E3009: return value mismatch (failing + passing)', () => {
    const returnValueInVoid = analyseCode('void f(void) { return 1; }');
    expect(codesOf(errorsOf(returnValueInVoid))).toEqual(['E3009']);

    const missingValue = analyseCode('int f(void) { return; }');
    expect(codesOf(errorsOf(missingValue))).toContain('E3009');

    const passing = analyseCode('int f(void) { return 1; } void g(void) { return; }');
    expect(errorsOf(passing)).toEqual([]);
  });

  it('W4001: unused local variable (failing/passing as warnings)', () => {
    const warning = analyseCode('int main() { int unused = 1; return 0; }');
    expect(errorsOf(warning)).toEqual([]);
    expect(codesOf(warningsOf(warning))).toContain('W4001');
    expect(warning.completed).toMatchObject({ sema: 'warnings', ir: 'ok' });

    const passing = analyseCode('int main() { int used = 1; return used; }');
    expect(warningsOf(passing)).toEqual([]);
  });

  it('W4002: non-void function may end without return (not for main)', () => {
    const warning = analyseCode('int f(int x) { x = x + 1; }');
    expect(codesOf(warningsOf(warning))).toContain('W4002');

    const passing = analyseCode('int f(int x) { if (x > 0) { return 1; } return 0; }');
    expect(warningsOf(passing)).toEqual([]);

    const mainPasses = analyseCode('int main() { int x = 1; return x; }');
    expect(warningsOf(mainPasses)).toEqual([]);
  });

  it('collects multiple semantic errors in one pass', () => {
    const result = analyseCode('int main() { int x = unknown1; y = 2; return z; }');
    expect(errorsOf(result).length).toBeGreaterThanOrEqual(2);
  });

  it('records global variables and function symbols with kinds', () => {
    const result = analyseCode(
      'int counter = 0; int bump(int by) { counter = counter + by; return counter; } int main() { return bump(1); }',
    );
    expect(errorsOf(result)).toEqual([]);
    const table = result.symbols!;
    expect(table.symbols.find((symbol) => symbol.name === 'counter')?.kind).toBe('global');
    expect(table.symbols.find((symbol) => symbol.name === 'bump')?.kind).toBe('function');
    expect(table.symbols.find((symbol) => symbol.name === 'by')?.kind).toBe('param');
  });

  it('does not run sema after a syntax error', () => {
    const result = analyseCode('int main() { return 1 }');
    expect(result.symbols).toBeNull();
    expect(result.completed.sema).toBe('blocked');
  });

  it('E1010: a global initialiser must be a literal or a { } list of them', () => {
    const expression = analyseCode('int g = 1 + 2;\nint main() { return g; }');
    expect(codesOf(errorsOf(expression))).toEqual(['E1010']);
    expect(errorsOf(expression)[0].stage).toBe('sema');
    expect(errorsOf(expression)[0].message).toContain('global initialiser');
    expect(expression.completed).toMatchObject({ sema: 'failed', ir: 'blocked' });

    const nested = analyseCode('int g[2] = {1, 1 + 1};\nint main() { return g[0]; }');
    expect(codesOf(errorsOf(nested))).toEqual(['E1010']);

    const literal = analyseCode('int g = 7;\nint g2[3] = {1, 2, 3};\nint main() { return g + g2[0]; }');
    expect(errorsOf(literal)).toEqual([]);
    expect(literal.completed.ir).toBe('ok');
  });

  it('decays array parameters to pointers and accepts pointer conditions', () => {
    const result = analyseCode(`
void f(int a[3]) {
  a[0] = 1;
}
int main() {
  int x = 0;
  int *p = &x;
  if (p) {
    f(&x);
  }
  while (p != 0) {
    p = 0;
  }
  return 0;
}
`);
    expect(errorsOf(result)).toEqual([]);
    const param = result.symbols!.symbols.find((symbol) => symbol.name === 'a')!;
    expect(param.kind).toBe('param');
    expect(param.type).toEqual({ kind: 'pointer', pointee: { kind: 'int' } });
  });

  it('E3003: a whole record cannot be copied by assignment', () => {
    const result = analyseCode(`
struct Point { int x; int y; };
int main() {
  struct Point a = {1, 2};
  struct Point b;
  b = a;
  return 0;
}
`);
    expect(codesOf(errorsOf(result))).toEqual(['E3003']);
    expect(errorsOf(result)[0].message).toContain("cannot assign a whole 'struct Point'");
  });
});
