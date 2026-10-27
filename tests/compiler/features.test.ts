import { describe, expect, it } from 'vitest';
import { OPT_PASS_ORDER, compile, optimizeModule, verifyModule } from '@/lib/compiler';
import { simulate, type SimulationResult } from '@/lib/compiler/simulate';
import type { OptPassId } from '@/lib/compiler';
import type { IRModule } from '@/lib/compiler/types';

/** All 16 combinations of the four passes. */
const PASS_SUBSETS: OptPassId[][] = (() => {
  const subsets: OptPassId[][] = [];
  for (let mask = 0; mask < 1 << OPT_PASS_ORDER.length; mask += 1) {
    subsets.push(OPT_PASS_ORDER.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
})();

function compileFull(source: string) {
  return compile(source);
}

/** Compile without errors and hand back the module plus the printed IR. */
function irOf(source: string): { module: IRModule; text: string } {
  const result = compileFull(source);
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  expect(errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)).toEqual([]);
  expect(result.ir, 'program must reach the IR stage').not.toBeNull();
  return {
    module: result.ir!.module,
    text: result.ir!.lines.map((line) => line.text).join('\n'),
  };
}

function asmOf(source: string): string {
  const result = compileFull(source);
  expect(result.asm, 'program must reach the assembly stage').not.toBeNull();
  return result.asm!.lines.map((line) => line.text).join('\n');
}

/** Only the errors semantic analysis reported, as `CODE message` strings. */
function errorsOf(source: string): string[] {
  return compileFull(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
}

function run(source: string): SimulationResult {
  return simulate(irOf(source).module);
}

function outcome(sim: SimulationResult) {
  const last = sim.steps[sim.steps.length - 1];
  return {
    outcome: sim.outcome,
    message: sim.message,
    result: sim.result,
    globals: last === undefined ? {} : last.state.globals,
    output: last === undefined ? '' : last.state.output,
  };
}

/**
 * Every program in this file must survive all 16 pass combinations: same
 * outcome, same values, same output, and never more steps than before.
 */
function expectOptimiserSafe(source: string): void {
  const original = irOf(source).module;
  const baseline = outcome(simulate(original));
  for (const passes of PASS_SUBSETS) {
    const optimization = optimizeModule(original, passes);
    expect(optimization.fallback, passes.join('+')).toBeNull();
    expect(verifyModule(optimization.module), passes.join('+')).toEqual([]);
    const optimised = simulate(optimization.module);
    const label = passes.join('+') || 'none';
    expect(outcome(optimised), label).toEqual(baseline);
    expect(optimised.steps.length, label).toBeLessThanOrEqual(
      simulate(original).steps.length,
    );
  }
}

function runtimeError(source: string): string {
  const sim = run(source);
  expect(sim.outcome).toBe('error');
  expect(sim.message).toMatch(/^Runtime error/);
  return sim.message!;
}

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe('arrays', () => {
  it('sums a fixed-size array written with an initialiser list', () => {
    const { text } = irOf(`
int main() {
  int a[5] = {1, 2, 3, 4, 5};
  int s = 0;
  for (int i = 0; i < 5; i = i + 1) { s = s + a[i]; }
  return s;
}
`);
    // The whole array is one multi-cell slot, and every element address is a
    // ptradd (constant offsets fold into the operand).
    expect(text).toContain('alloca [5 x i32]');
    expect(text).toContain('ptradd ptr %a, i32 4');
    expect(run(`
int main() {
  int a[5] = {1, 2, 3, 4, 5};
  int s = 0;
  for (int i = 0; i < 5; i = i + 1) { s = s + a[i]; }
  return s;
}
`).result).toBe(15);
  });

  it('zero-fills the cells a short initialiser list leaves out', () => {
    expect(
      run(`int main() { int a[4] = {7}; return a[0] + a[1] + a[2] + a[3]; }`).result,
    ).toBe(7);
  });

  it('keeps multi-dimensional arrays in row-major order', () => {
    const sim = run(`
int main() {
  int m[2][3] = {{1, 2, 3}, {4, 5, 6}};
  return m[1][2] * 10 + m[0][1];
}
`);
    expect(sim.result).toBe(62);
  });

  it('rejects more initialiser values than the array holds (E3003)', () => {
    expect(errorsOf('int main() { int a[2] = {1, 2, 3}; return 0; }')[0]).toMatch(
      /^E3003: too many values in initialiser/,
    );
  });

  it('rejects a brace initialiser without a size (E1010)', () => {
    const errors = errorsOf('int main() { int a[] = {1, 2}; return 0; }');
    expect(errors[0]).toMatch(/^E1010/);
  });

  it('reports an out-of-bounds index at run time', () => {
    expect(runtimeError('int main() { int a[2]; a[5] = 1; return a[5]; }')).toContain(
      'out of bounds',
    );
  });

  it('folds sizeof to the cell count', () => {
    expect(run('int main() { return sizeof(int); }').result).toBe(1);
    expect(run('int main() { int *p = 0; return sizeof(int *); }').result).toBe(1);
    expect(
      run('struct P { int x; int y; }; int main() { return sizeof(struct P); }').result,
    ).toBe(2);
    // An array type inside sizeof is outside the supported subset (E2001).
    expect(errorsOf('int main() { return sizeof(int[3]); }')[0]).toMatch(/^E2001/);
  });

  it('lays global arrays out in the data segment', () => {
    const text = asmOf('int g[3] = {1, 2, 3}; int main() { return g[2]; }');
    expect(text).toContain('g:');
    expect(text).toContain('.long 1, 2, 3');
  });

  it('is safe under every optimiser pass combination', () => {
    expectOptimiserSafe(`
int main() {
  int a[4] = {1, 2, 3, 4};
  int s = 0;
  for (int i = 0; i < 4; i = i + 1) { s = s + a[i]; }
  return s;
}
`);
  });
});

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------

describe('pointers', () => {
  it('passes addresses and writes through them', () => {
    const sim = run(`
void swap(int *a, int *b) {
  int t = *a;
  *a = *b;
  *b = t;
}
int main() {
  int x = 3;
  int y = 9;
  swap(&x, &y);
  return x * 10 + y;
}
`);
    expect(sim.result).toBe(93);
  });

  it('walks an array with pointer arithmetic', () => {
    const sim = run(`
int main() {
  int a[4] = {2, 4, 6, 8};
  int *p = a;
  int *end = a + 4;
  int s = 0;
  while (p != end) {
    s = s + *p;
    p = p + 1;
  }
  return s + (end - a);
}
`);
    expect(sim.result).toBe(24);
  });

  it('allocates with malloc and releases with free', () => {
    const sim = run(`
int main() {
  int *p = malloc(3);
  p[0] = 1;
  p[2] = 5;
  int sum = p[0] + p[2];
  free(p);
  return sum;
}
`);
    expect(sim.result).toBe(6);
  });

  it('allocates with new[] and releases with delete', () => {
    const sim = run(`
int main() {
  int *p = new int[3];
  p[1] = 7;
  int v = p[1];
  delete p;
  return v;
}
`);
    expect(sim.result).toBe(7);
  });

  it('reports reading through a freed pointer (use-after-free)', () => {
    expect(runtimeError('int main() { int *p = malloc(2); free(p); return p[0]; }')).toContain(
      'use-after-free',
    );
  });

  it('reports freeing the same block twice (double free)', () => {
    expect(
      runtimeError('int main() { int *p = malloc(2); free(p); free(p); return 0; }'),
    ).toContain('double free');
  });

  it('refuses to delete null', () => {
    expect(runtimeError('int main() { int *p = 0; delete p; return 0; }')).toContain(
      'delete requires a heap pointer',
    );
  });

  it('refuses to free a stack address', () => {
    expect(runtimeError('int main() { int x = 1; free(&x); return 0; }')).toContain(
      'free requires a heap pointer',
    );
  });

  it('refuses to subtract pointers from different blocks', () => {
    expect(
      runtimeError(
        'int main() { int *p = malloc(2); int *q = malloc(2); return p - q; }',
      ),
    ).toContain('unrelated pointers');
  });

  it('refuses to dereference null', () => {
    expect(runtimeError('int main() { int *p = 0; return p[0]; }')).toContain('null pointer');
  });

  it('refuses to dereference after the frame that owned it returned', () => {
    expect(
      runtimeError(
        'int *f() { int a[3]; return a; } int main() { int *p = f(); return p[0]; }',
      ),
    ).toContain('use-after-free');
  });

  it('is safe under every optimiser pass combination', () => {
    expectOptimiserSafe(`
void bump(int *p) { *p = *p + 1; }
int main() {
  int a[3] = {1, 2, 3};
  for (int i = 0; i < 3; i = i + 1) bump(&a[i]);
  int s = 0;
  for (int i = 0; i < 3; i = i + 1) s = s + a[i];
  int *p = malloc(2);
  p[0] = 10;
  s = s + p[0];
  free(p);
  return s;
}
`);
  });
});

// ---------------------------------------------------------------------------
// Structs and unions
// ---------------------------------------------------------------------------

describe('structs and unions', () => {
  it('lays fields out at consecutive cells and reads them back', () => {
    const sim = run(`
struct Point { int x; int y; };
int main() {
  struct Point p = {3, 4};
  p.x = p.x + 1;
  return p.x * 10 + p.y;
}
`);
    expect(sim.result).toBe(44);
  });

  it('writes through a struct pointer with ->', () => {
    const sim = run(`
struct Point { int x; int y; };
void move(struct Point *p) { p->x = p->x + 10; }
int main() {
  struct Point p = {1, 2};
  move(&p);
  return p.x * 10 + p.y;
}
`);
    expect(sim.result).toBe(112);
  });

  it('overlaps union fields at offset 0', () => {
    const sim = run(`
union U { int a; int b; };
int main() {
  union U u;
  u.a = 5;
  u.b = 7;
  return u.a;
}
`);
    expect(sim.result).toBe(7);
  });

  it('accepts a record that points at itself', () => {
    const sim = run(`
struct Node { int value; struct Node *next; };
int main() {
  struct Node b = {2, 0};
  struct Node a = {1, &b};
  return a.value + a.next->value;
}
`);
    expect(sim.result).toBe(3);
  });

  it('E3005: no member with that name', () => {
    const errors = errorsOf(`
struct Point { int x; int y; };
int main() { struct Point p; return p.z; }
`);
    expect(errors[0]).toMatch(/^E3005: no member named 'z'/);
  });

  it('E3001: using a record type that was never declared', () => {
    expect(errorsOf('int main() { struct Missing m; return 0; }')[0]).toMatch(/^E3001/);
  });

  it('E1010: records are not passed or returned by value', () => {
    const byValue = errorsOf(`
struct Point { int x; int y; };
int dist(struct Point p) { return p.x; }
int main() { return 0; }
`);
    expect(byValue[0]).toMatch(/^E1010/);
    // The rejected signature must not cascade into a second complaint about the body.
    expect(byValue).toHaveLength(1);

    const returned = errorsOf(`
struct Point { int x; int y; };
struct Point origin() { struct Point p = {0, 0}; return p; }
int main() { return 0; }
`);
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatch(/^E1010/);

    const copy = errorsOf(`
struct Point { int x; int y; };
int main() { struct Point a; struct Point b = a; return 0; }
`);
    expect(copy[0]).toMatch(/^E3003/);
  });

  it('nests records to any depth, with brace initialisers and arrow chains', () => {
    const sim = run(`
struct L { int v; int u; };
struct M { struct L l; int w; };
int main() {
  struct M m = { {1, 2}, 3 };
  struct M *p = &m;
  p->l.v = p->l.v + 9;
  return m.l.v * 100 + m.l.u * 10 + m.w;
}
`);
    expect(sim.result).toBe(1023);

    const deep = run(`
struct L { int v; };
struct M { struct L l; int w; };
struct T { struct M m; int x; };
int main() {
  struct T t;
  t.m.l.v = 1;
  t.m.w = 2;
  t.x = 3;
  return t.m.l.v * 100 + t.m.w * 10 + t.x;
}
`);
    expect(deep.result).toBe(123);

    // A record's size counts every nested cell.
    expect(
      run(
        'struct L { int a; int b; }; struct M { struct L l; int c; }; int main() { return sizeof(struct M); }',
      ).result,
    ).toBe(3);
  });

  it('supports arrays of records and records inside unions', () => {
    const array = run(`
struct P { int x; int y; };
int main() {
  struct P a[3];
  a[0].x = 1;
  a[2].x = 9;
  return a[0].x + a[2].x;
}
`);
    expect(array.result).toBe(10);

    const union = run(`
struct L { int a; int b; };
union U { struct L l; int c; };
int main() {
  union U u;
  u.l.a = 4;
  u.c = 9;
  return u.l.a;
}
`);
    expect(union.result).toBe(9);
  });

  it('E1010: a record must exist before it is used by value', () => {
    const errors = errorsOf(`
struct A { struct B byValue; };
struct B { int x; };
int main() { return 0; }
`);
    expect(errors[0]).toMatch(/^E1010/);
  });

  it('is safe under every optimiser pass combination', () => {
    expectOptimiserSafe(`
struct Point { int x; int y; };
int main() {
  struct Point p = {1, 2};
  struct Point *q = &p;
  q->x = q->x + 4;
  return p.x * 10 + p.y;
}
`);
  });
});

// ---------------------------------------------------------------------------
// print / printf
// ---------------------------------------------------------------------------

describe('print and printf', () => {
  it('print writes the value and a newline', () => {
    expect(outcome(run('int main() { print(42); return 0; }')).output).toBe('42\n');
  });

  it('printf formats values and understands escapes', () => {
    const sim = run(`
int main() {
  int a = 3;
  printf("%d + %d = %d\\n", a, 4, a + 4);
  printf("done\\n");
  return 0;
}
`);
    expect(outcome(sim).output).toBe('3 + 4 = 7\ndone\n');
  });

  it('printf falls back to the raw format when it cannot convert', () => {
    // Extra arguments: the reference interpreter prints the format unchanged.
    expect(outcome(run('int main() { printf("%d", 1, 2); return 0; }')).output).toBe('%d');
  });

  it('keeps print/printf as typed calls with a string operand in the IR', () => {
    const { text, module } = irOf('int main() { print(1); printf("%d\\n", 2); return 0; }');
    expect(text).toContain('call i32 @print(i32 1)');
    expect(text).toContain('call i32 @printf(ptr "%d\\n", i32 2)');
    expect(module.functions.find((fn) => fn.name === 'printf')?.isDeclaration).toBe(true);
    expect(module.functions.find((fn) => fn.name === 'print')?.isDeclaration).toBe(true);
  });

  it('places the format in .rodata and loads its address', () => {
    const text = asmOf('int main() { printf("hi\\n"); return 0; }');
    expect(text).toContain('.section .rodata');
    expect(text).toContain('.LC0:');
    expect(text).toContain('.string "hi\\n"');
    expect(text).toMatch(/lea \w+, \[\.LC0\]/);
  });

  it('is safe under every optimiser pass combination', () => {
    expectOptimiserSafe(`
int main() {
  int a = 6;
  print(a * 7);
  printf("%d\\n", a);
  return 0;
}
`);
  });
});

// ---------------------------------------------------------------------------
// Runtime checks
// ---------------------------------------------------------------------------

describe('runtime checks', () => {
  it('stops on division and modulo by zero', () => {
    expect(runtimeError('int main() { int b = 0; return 6 / b; }')).toBe(
      'Runtime error: division by zero',
    );
    expect(runtimeError('int main() { int b = 0; return 6 % b; }')).toBe(
      'Runtime error: modulo by zero',
    );
  });

  it('is deterministic: the same program gives the same trace twice', () => {
    const source = `
struct P { int x; int y; };
int main() {
  int a[3] = {1, 2, 3};
  struct P p = {a[0], a[1]};
  int *q = malloc(2);
  q[0] = a[2];
  printf("%d\\n", p.x + p.y + q[0]);
  free(q);
  return 0;
}
`;
    const first = JSON.parse(JSON.stringify(run(source).steps));
    const second = JSON.parse(JSON.stringify(run(source).steps));
    expect(second).toEqual(first);
  });

  it('keeps every reported failure stage correct', () => {
    expect(compileFull('int main() { return a; }').diagnostics[0].stage).toBe('sema');
    expect(compileFull('int main() { return 1 }').diagnostics[0].stage).toBe('parse');
    expect(compileFull('int main() { return 1; } |').diagnostics[0].stage).toBe(
      'unsupported',
    );
  });
});
