import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import type { CompileResult, IRInstr, IRModule } from '@/lib/compiler/types';

function compileOk(source: string): CompileResult {
  const result = compile(source);
  expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(result.ir).not.toBeNull();
  return result;
}

function moduleOf(result: CompileResult): IRModule {
  return result.ir!.module;
}

function terminatorOf(irModule: IRModule, blockId: number): IRInstr | undefined {
  const instrIds = irModule.blocks[blockId].instrIds;
  if (instrIds.length === 0) return undefined;
  return irModule.instrs[instrIds[instrIds.length - 1]];
}

function everyBlockHasOneTerminator(irModule: IRModule): boolean {
  return Object.values(irModule.blocks).every((block) => {
    const terminators = block.instrIds.filter((instrId) => {
      const opcode = irModule.instrs[instrId].opcode;
      return opcode === 'br' || opcode === 'ret' || opcode === 'unreachable';
    });
    const last = terminatorOf(irModule, block.id);
    return terminators.length <= 1 && (terminators.length === 0 || last?.id === terminators[0]);
  });
}

const LEARNING_EXAMPLES: Record<string, string> = {
  arithmetic: 'int main() {\n  int a = 2;\n  int b = 3;\n  int sum = a + b * 2 - 1;\n  return sum;\n}\n',
  precedence: 'int main() {\n  return 2 + 3 * 4;\n}\n',
  ifElse: 'int main() {\n  int x = 5;\n  if (x > 3) {\n    return 1;\n  } else {\n    return 2;\n  }\n}\n',
  whileLoop: 'int main() {\n  int i = 1;\n  int sum = 0;\n  while (i <= 10) {\n    sum = sum + i;\n    i++;\n  }\n  return sum;\n}\n',
  forLoop: 'int main() {\n  int sum = 0;\n  for (int i = 0; i < 5; i++) {\n    if (i == 2) continue;\n    sum += i;\n  }\n  return sum;\n}\n',
  functionCall: 'int add(int a, int b) {\n  return a + b;\n}\n\nint main() {\n  return add(2, 3);\n}\n',
  recursion: 'int fact(int n) {\n  if (n <= 1) {\n    return 1;\n  }\n  return n * fact(n - 1);\n}\n\nint main() {\n  return fact(5);\n}\n',
  shortCircuit: 'int main() {\n  int a = 0;\n  int b = 7;\n  if (a != 0 && b / a > 1) {\n    return 1;\n  }\n  if (a == 0 || b > 3) {\n    return 2;\n  }\n  return 0;\n}\n',
};

describe('IR generation', () => {
  it('matches the golden snapshot for every learning example', () => {
    for (const [name, source] of Object.entries(LEARNING_EXAMPLES)) {
      const result = compileOk(source);
      expect(result.ir!.lines.map((line) => line.text), name).toMatchSnapshot(name);
    }
  });

  it('gives every block exactly one terminator (builder invariant)', () => {
    for (const [name, source] of Object.entries(LEARNING_EXAMPLES)) {
      const irModule = moduleOf(compileOk(source));
      expect(everyBlockHasOneTerminator(irModule), name).toBe(true);
    }
  });

  it('emits entry-block allocas for params and locals first', () => {
    const irModule = moduleOf(compileOk('int add(int a, int b) { int c = a + b; return c; }'));
    const fn = irModule.functions.find((candidate) => candidate.name === 'add')!;
    const entry = irModule.blocks[fn.blockIds[0]];
    expect(entry.label).toBe('entry');
    const firstTwo = entry.instrIds.slice(0, 2).map((id) => irModule.instrs[id]);
    expect(firstTwo.map((instr) => instr.opcode)).toEqual(['alloca', 'alloca']);
    expect(firstTwo.map((instr) => instr.varName)).toEqual(['a', 'b']);
    expect(firstTwo.map((instr) => instr.result)).toEqual(['%a.addr', '%b.addr']);
  });

  it('prints `+` as a bare add with a hint name like %add', () => {
    const irModule = moduleOf(compileOk('int main() { int x = 1 + 2; return x; }'));
    const add = Object.values(irModule.instrs).find((instr) => instr.opcode === 'add' && instr.result === '%add');
    expect(add).toBeDefined();
    expect(add!.operands).toEqual([
      { kind: 'const', value: 1, type: 'i32' },
      { kind: 'const', value: 2, type: 'i32' },
    ]);
    const line = compileOk('int main() { int x = 1 + 2; return x; }').ir!.lines.find(
      (candidate) => candidate.instrId === add!.id,
    )!;
    // The type is implied (arithmetic is always i32) and `nsw` would be a lie,
    // so neither is printed (§6.4 rule 10).
    expect(line.text).toBe('  %add = add 1, 2');
  });

  it('models comparisons as i1 and widens with zext when used as int', () => {
    const source = 'int main() {\n  int x = 1 < 2;\n  return x;\n}\n';
    const result = compileOk(source);
    const irModule = moduleOf(result);
    const icmp = Object.values(irModule.instrs).find((instr) => instr.opcode === 'icmp')!;
    expect(icmp.type).toBe('i1');
    expect(icmp.predicate).toBe('slt');
    const zext = Object.values(irModule.instrs).find((instr) => instr.opcode === 'zext')!;
    expect(zext.toType).toBe('i32');
    const line = result.ir!.lines.find((candidate) => candidate.instrId === zext.id)!;
    expect(line.text).toMatch(/^ {2}%\d+ = zext %cmp to i32$/);
  });

  it('builds && and || without phi, using hidden temps and rhs/end blocks', () => {
    const source = 'int main() {\n  int a = 1;\n  int b = 2;\n  if (a != 0 && b != 0) {\n    return 1;\n  }\n  return 0;\n}\n';
    const irModule = moduleOf(compileOk(source));
    const labels = Object.values(irModule.blocks).map((block) => block.label);
    expect(labels).toContain('land.rhs');
    expect(labels).toContain('land.end');
    // No phi anywhere in the printed output (the type system also forbids it).
    const printed = compileOk(source).ir!.lines.map((line) => line.text).join('\n');
    expect(printed).not.toContain('phi');

    // The hidden temp is an alloca and the result is loaded in the end block.
    const landAlloca = Object.values(irModule.instrs).find(
      (instr) => instr.opcode === 'alloca' && instr.result === '%land.tmp',
    );
    expect(landAlloca).toBeDefined();

    const orModule = moduleOf(
      compileOk('int main() {\n  int a = 0;\n  int b = 2;\n  if (a == 0 || b > 1) {\n    return 1;\n  }\n  return 0;\n}\n'),
    );
    const orLabels = Object.values(orModule.blocks).map((block) => block.label);
    expect(orLabels).toContain('lor.rhs');
    expect(orLabels).toContain('lor.end');
  });

  it('routes break to the loop end and continue to cond (while) or inc (for)', () => {
    const whileModule = moduleOf(
      compileOk('int main() {\n  while (1) {\n    break;\n  }\n  return 0;\n}\n'),
    );
    const whileEnd = Object.values(whileModule.blocks).find((block) => block.label === 'while.end')!;
    const breakInstr = Object.values(whileModule.instrs).find(
      (instr) =>
        instr.opcode === 'br' &&
        instr.operands.length === 1 &&
        instr.operands[0].kind === 'label' &&
        instr.operands[0].blockId === whileEnd.id,
    );
    expect(breakInstr).toBeDefined();

    const forModule = moduleOf(
      compileOk('int main() {\n  for (int i = 0; i < 3; i++) {\n    continue;\n  }\n  return 0; }\n'),
    );
    const forInc = Object.values(forModule.blocks).find((block) => block.label === 'for.inc')!;
    const continueInstr = Object.values(forModule.instrs).find(
      (instr) =>
        instr.opcode === 'br' &&
        instr.operands.length === 1 &&
        instr.operands[0].kind === 'label' &&
        instr.operands[0].blockId === forInc.id,
    );
    expect(continueInstr).toBeDefined();
  });

  it('keeps one terminator per block when statements follow a return', () => {
    const result = compileOk('int main() {\n  return 1;\n  int dead = 2;\n}\n');
    const irModule = moduleOf(result);
    expect(everyBlockHasOneTerminator(irModule)).toBe(true);
    // The dead code block has no predecessors and is pruned.
    const fn = irModule.functions.find((candidate) => candidate.name === 'main')!;
    const labels = fn.blockIds.map((blockId) => irModule.blocks[blockId].label);
    expect(labels).toEqual(['entry']);
  });

  it('emits `ret i32 0` scaffolding for main without a return and `unreachable` elsewhere', () => {
    const mainModule = moduleOf(compileOk('int main() {\n  int x = 1;\n}\n'));
    const mainFn = mainModule.functions.find((candidate) => candidate.name === 'main')!;
    const last = terminatorOf(mainModule, mainFn.blockIds[mainFn.blockIds.length - 1])!;
    expect(last.opcode).toBe('ret');
    expect(last.astNodeId).toBeUndefined(); // scaffolding has no honest origin

    const otherModule = moduleOf(compileOk('int f(int x) {\n  x = x + 1;\n}\nint main() { return 0; }'));
    const fFn = otherModule.functions.find((candidate) => candidate.name === 'f')!;
    const fLast = terminatorOf(otherModule, fFn.blockIds[fFn.blockIds.length - 1])!;
    expect(fLast.opcode).toBe('unreachable');
  });

  it('declares prototypes and emits globals', () => {
    const result = compileOk(
      'int helper(int x);\nint counter = 5;\nint main() {\n  counter += 1;\n  return counter;\n}\n',
    );
    const irModule = moduleOf(result);
    expect(irModule.globals).toEqual([{ name: 'counter', init: 5, astNodeId: expect.any(Number) }]);
    const helper = irModule.functions.find((candidate) => candidate.name === 'helper')!;
    expect(helper.isDeclaration).toBe(true);
    expect(result.ir!.lines.some((line) => line.text === 'declare i32 @helper(i32)')).toBe(true);
    expect(result.ir!.lines.some((line) => line.text === '@counter = global i32 5')).toBe(true);

    // `counter += 1` loads from and stores to `ptr @counter`, and the final
    // `return counter` loads it once more.
    const globalRef = Object.values(irModule.instrs).filter(
      (instr) => instr.operands.some((operand) => operand.kind === 'global' && operand.name === 'counter'),
    );
    expect(globalRef.map((instr) => instr.opcode).sort()).toEqual(['load', 'load', 'store']);
  });

  it('generates calls with the callee name and argument operands', () => {
    const result = compileOk('int add(int a, int b) { return a + b; } int main() { return add(2, 3); }');
    const irModule = moduleOf(result);
    const call = Object.values(irModule.instrs).find((instr) => instr.opcode === 'call')!;
    expect(call.callee).toBe('add');
    expect(call.result).toBe('%call');
    expect(call.operands).toEqual([
      { kind: 'const', value: 2, type: 'i32' },
      { kind: 'const', value: 3, type: 'i32' },
    ]);
    const line = result.ir!.lines.find((candidate) => candidate.instrId === call.id)!;
    // The callee's types live on its define line, so the call itself is bare.
    expect(line.text).toBe('  %call = call @add(2, 3)');
  });

  it('prints a type only where it declares something, and never align or nsw', () => {
    const source = [
      'int g = 3;',
      'int a[4] = {1, 2, 3, 4};',
      'int main() {',
      '  int x = 1 + 2;',
      '  if (x > 2) { x = x - 1; }',
      '  printf("%d\\n", x);',
      '  return g + a[1];',
      '}',
    ].join('\n');
    const text = compileOk(source)
      .ir!.lines.map((line) => line.text)
      .join('\n');

    // Declared: signatures, slots, the global's own type and shape.
    expect(text).toContain('define i32 @main()');
    expect(text).toContain('declare i32 @printf(ptr, i32)');
    expect(text).toContain('%x = alloca i32');
    expect(text).toContain('@g = global i32 3');
    expect(text).toContain('[4 x i32] [1, 2, 3, 4]');

    // Implied or false: never printed (§6.4 rule 10).
    expect(text).not.toMatch(/\b(align|nsw)\b/);
    expect(text).not.toContain('store i32');
    expect(text).not.toContain('= load i32');
    expect(text).not.toMatch(/= add i32/);
    expect(text).not.toMatch(/call i32 @/);
    expect(text).not.toContain('ret i32 ');
  });

  it('records astNodeId provenance on every non-scaffolding instruction', () => {
    const irModule = moduleOf(compileOk('int main() { int x = 1 + 2; return x; }'));
    const withoutOrigin = Object.values(irModule.instrs).filter(
      (instr) => instr.astNodeId === undefined,
    );
    // Only the synthetic `ret i32 0` lacks an origin.
    expect(withoutOrigin.every((instr) => instr.opcode === 'ret')).toBe(true);
  });

  it('is deterministic: the same source yields identical IR lines', () => {
    const source = LEARNING_EXAMPLES.recursion;
    const first = compileOk(source).ir!.lines;
    const second = compileOk(source).ir!.lines;
    expect(second).toEqual(first);
  });

  it('never uses phi and always terminates', () => {
    for (const source of Object.values(LEARNING_EXAMPLES)) {
      const result = compileOk(source);
      const irModule = moduleOf(result);
      expect(result.ir!.lines.map((line) => line.text).join('\n')).not.toContain('phi');
      for (const fn of irModule.functions) {
        if (fn.isDeclaration) continue;
        for (const blockId of fn.blockIds) {
          const last = terminatorOf(irModule, blockId);
          expect(['br', 'ret', 'unreachable']).toContain(last?.opcode);
        }
      }
    }
  });
});
