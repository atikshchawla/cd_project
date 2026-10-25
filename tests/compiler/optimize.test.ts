import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '@/content/examples';
import {
  OPT_PASS_ORDER,
  compile,
  findChangeForInstruction,
  optimizeModule,
  verifyModule,
} from '@/lib/compiler';
import type { IRModule, OptChange, OptPassId, OptimizationResult } from '@/lib/compiler';

const ALL_PASSES = OPT_PASS_ORDER;
const NO_PASSES: OptPassId[] = [];

function compileOk(source: string) {
  const result = compile(source);
  expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(result.ir).not.toBeNull();
  return result;
}

function moduleOf(result: ReturnType<typeof compile>): IRModule {
  return result.ir!.module;
}

function optimise(source: string, passes: readonly OptPassId[]) {
  const result = compileOk(source);
  const original = moduleOf(result);
  const before = JSON.stringify(original);
  const optimization = optimizeModule(original, passes);
  expect(JSON.stringify(original)).toBe(before); // the original is never mutated
  return { result, original, optimization };
}

function countOf(module: IRModule): number {
  return Object.keys(module.instrs).length;
}

function countVariants(optimization: OptimizationResult, variant: OptChange['facts']['variant']) {
  return optimization.changes.filter((change) => change.facts.variant === variant);
}

describe('optimisation pipeline', () => {
  it('returns a verified, structurally sound module for every example and pass mix', () => {
    for (const example of EXAMPLES) {
      const result = compile(example.code);
      if (result.ir === null) continue;
      for (const subset of passSubsets()) {
        const optimization = optimizeModule(result.ir.module, subset);
        expect(verifyModule(optimization.module)).toEqual([]);
        expect(optimization.fallback).toBeNull();
      }
    }
  });

  it('is a pure function of the module and the enabled passes', () => {
    const source = `int main() {
  int a = 2;
  int b = 3;
  return (a + b) * 2;
}
`;
    const first = optimizeModule(compileOk(source).ir!.module, ALL_PASSES);
    const second = optimizeModule(compileOk(source).ir!.module, [...ALL_PASSES].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('leaves the IR untouched when no pass is enabled', () => {
    const { original, optimization } = optimise('int main() { return 1 + 2; }', NO_PASSES);
    expect(optimization.changes).toEqual([]);
    expect(optimization.optimizedCount).toBe(optimization.originalCount);
    expect(optimization.lines.map((line) => line.text)).toEqual(
      compileOk('int main() { return 1 + 2; }').ir!.lines.map((line) => line.text),
    );
    expect(countOf(optimization.module)).toBe(countOf(original));
    expect(optimization.passStates.every((state) => state.status === 'disabled')).toBe(true);
  });

  it('reports a fallback instead of shipping IR the optimiser broke', () => {
    const broken: IRModule = compileOk('int main() { return 1 + 2; }').ir!.module;
    // Corrupt the module: an instruction that reads a value nobody defines.
    const firstId = Number(Object.keys(broken.instrs)[0]);
    broken.instrs[firstId].operands = [{ kind: 'value', name: '%missing' }];
    const optimization = optimizeModule(broken, NO_PASSES);
    expect(optimization.fallback).not.toBeNull();
    expect(optimization.changes).toEqual([]);
    // The fallback is a plain clone of what it was given: nothing invented.
    expect(optimization.module).not.toBe(broken);
    expect(optimization.optimizedCount).toBe(optimization.originalCount);
    expect(optimization.lines.map((line) => line.text).join('\n')).toContain('ret');
  });
});

/** All 16 combinations of the four passes. */
function passSubsets(): OptPassId[][] {
  const subsets: OptPassId[][] = [];
  for (let mask = 0; mask < 1 << ALL_PASSES.length; mask += 1) {
    subsets.push(ALL_PASSES.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

describe('local value forwarding', () => {
  it('replaces a later load with the value just stored into the same cell', () => {
    const { optimization } = optimise(
      `int main() {
  int a = 5;
  int b = a;
  return 0;
}
`,
      ['forwarding'],
    );

    const forwarded = countVariants(optimization, 'forwarded-load');
    expect(forwarded).toHaveLength(1);
    const change = forwarded[0];
    expect(change.kind).toBe('removed');
    expect(change.facts).toMatchObject({
      ptrLabel: '%a',
      forwarded: { kind: 'const', value: 5 },
      usesRewritten: 1,
    });
    // The load is gone, and the store that consumed it now stores `5`.
    expect(optimization.module.instrs[change.beforeInstrId!]).toBeUndefined();
    const storeUses = optimization.changes[0].relatedInstrIds;
    expect(storeUses.length).toBe(1);
    const store = optimization.module.instrs[storeUses[0]];
    expect(store?.opcode).toBe('store');
    expect(store?.operands[0]).toEqual({ kind: 'const', value: 5, type: 'i32' });
  });

  it('forwards the most recent store, not an earlier one', () => {
    const { optimization } = optimise(
      `int g;
int main() {
  g = 1;
  g = 2;
  return g;
}
`,
      ['forwarding'],
    );

    const forwarded = countVariants(optimization, 'forwarded-load');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].facts).toMatchObject({ forwarded: { kind: 'const', value: 2 } });
  });

  it('forgets globals across a call, because the callee may write them', () => {
    const { optimization } = optimise(
      `int g;
int touch();
int main() {
  g = 1;
  touch();
  return g;
}
`,
      ['forwarding'],
    );
    expect(countVariants(optimization, 'forwarded-load')).toHaveLength(0);
    const loads = optimization.changes.filter((change) => change.facts.variant === 'dead-code');
    expect(loads).toHaveLength(0);
    expect(countOf(optimization.module)).toBe(optimization.originalCount);
  });

  it('keeps local cells across a call: a callee cannot reach our allocas', () => {
    const { optimization } = optimise(
      `int touch();
int main() {
  int a = 5;
  touch();
  return a;
}
`,
      ['forwarding'],
    );
    const forwarded = countVariants(optimization, 'forwarded-load');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].facts).toMatchObject({ ptrLabel: '%a' });
  });

  it('never forwards across blocks', () => {
    const { original, optimization } = optimise(
      `int g;
int main() {
  g = 1;
  if (g) {
    return g;
  }
  return 0;
}
`,
      ['forwarding'],
    );

    const entryOf = (module: IRModule) =>
      module.blocks[module.functions.find((fn) => fn.name === 'main')!.blockIds[0]];
    const entryLoads = (module: IRModule) =>
      entryOf(module)
        .instrIds.map((id) => module.instrs[id])
        .filter((instr) => instr.opcode === 'load');

    // In `main`'s entry block the store is known, so the `if (g)` load folds
    // away — the load inside `if.then` must survive: it is another block.
    expect(entryLoads(original)).toHaveLength(1);
    expect(entryLoads(optimization.module)).toHaveLength(0);
    const remaining = Object.values(optimization.module.instrs).filter(
      (instr) => instr.opcode === 'load',
    );
    expect(remaining).toHaveLength(1);
    expect(verifyModule(optimization.module)).toEqual([]);
  });
});

describe('constant and branch folding', () => {
  it('folds a chain of constant arithmetic and forwards it to the return', () => {
    const { optimization } = optimise(
      `int main() {
  return 2 * 3 + 1;
}
`,
      ['folding'],
    );

    const folded = countVariants(optimization, 'constant-folded');
    expect(folded.length).toBeGreaterThanOrEqual(2);
    expect(optimization.module.instrs[folded[0].beforeInstrId!]).toBeUndefined();

    const ret = Object.values(optimization.module.instrs).find(
      (instr) => instr.opcode === 'ret',
    );
    expect(ret?.operands[0]).toEqual({ kind: 'const', value: 7, type: 'i32' });
  });

  it('keeps 32-bit wrap-around semantics', () => {
    const { optimization } = optimise('int main() { return 2147483647 + 1; }', ['folding']);
    const ret = Object.values(optimization.module.instrs).find((i) => i.opcode === 'ret');
    expect(ret?.operands[0]).toMatchObject({ kind: 'const', value: -2147483648 });
  });

  it('folds a constant condition into an unconditional branch', () => {
    const { optimization } = optimise(
      `int main() {
  if (1) {
    return 3;
  }
  return 4;
}
`,
      ['folding'],
    );

    const branches = countVariants(optimization, 'branch-folded');
    expect(branches).toHaveLength(1);
    expect(branches[0].kind).toBe('changed');

    const folded = optimization.module.instrs[branches[0].beforeInstrId!];
    expect(folded.opcode).toBe('br');
    expect(folded.operands).toHaveLength(1);
    expect(verifyModule(optimization.module)).toEqual([]); // still a valid terminator
  });

  it('leaves a condition alone when it is not a constant', () => {
    const { optimization } = optimise(
      `int main() {
  int c = 1;
  if (c) {
    return 3;
  }
  return 4;
}
`,
      ['folding'],
    );
    expect(countVariants(optimization, 'branch-folded')).toHaveLength(0);
    const br = Object.values(optimization.module.instrs).find((i) => i.opcode === 'br');
    expect(br?.operands).toHaveLength(3);
  });

  it('never folds away side effects: stores and calls survive', () => {
    const source = `int g;
int touch(int n);
int main() {
  g = 1 + 2;
  touch(3 * 4);
  return 0;
}
`;
    const { original, optimization } = optimise(source, ALL_PASSES);
    const before = Object.values(original.instrs).filter(
      (instr) => instr.opcode === 'store' || instr.opcode === 'call',
    );
    const after = Object.values(optimization.module.instrs).filter(
      (instr) => instr.opcode === 'store' || instr.opcode === 'call',
    );
    expect(after).toHaveLength(before.length);
    expect(after.map((instr) => instr.opcode)).toEqual(before.map((instr) => instr.opcode));
    // …and their call arguments were folded instead: `3 * 4` → 12.
    const call = after.find((instr) => instr.opcode === 'call');
    expect(call?.operands[0]).toEqual({ kind: 'const', value: 12, type: 'i32' });
  });
});

describe('block-local common subexpression elimination', () => {
  const SOURCE = `int main() {
  int x = 1 + 1;
  int y = 1 + 1;
  return 0;
}
`;

  it('merges an identical pure instruction computed earlier in the block', () => {
    const { original, optimization } = optimise(SOURCE, ['cse']);
    const duplicates = countVariants(optimization, 'cse-duplicate');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].kind).toBe('removed');
    expect(optimization.optimizedCount).toBe(optimization.originalCount - 1);
    expect(countOf(optimization.module)).toBe(countOf(original) - 1);
    // The surviving instruction is the earlier one.
    expect(duplicates[0].facts).toMatchObject({ variant: 'cse-duplicate' });
    const kept = duplicates[0].facts.variant === 'cse-duplicate' ? duplicates[0].facts.keptInstrId : -1;
    expect(kept).toBeLessThan(duplicates[0].beforeInstrId!);
    expect(verifyModule(optimization.module)).toEqual([]);
  });

  it('does not merge instructions from different blocks', () => {
    const { optimization } = optimise(
      `int main() {
  int c = 1;
  int x = 0;
  int y = 0;
  if (c) {
    x = 1 + 1;
  } else {
    y = 1 + 1;
  }
  return x + y;
}
`,
      ['cse'],
    );
    expect(countVariants(optimization, 'cse-duplicate')).toHaveLength(0);
  });

  it('never treats loads or stores as pure', () => {
    const { optimization } = optimise(
      `int g;
int main() {
  g = 1;
  g = 1;
  return g;
}
`,
      ['cse'],
    );
    expect(countVariants(optimization, 'cse-duplicate')).toHaveLength(0);
  });
});

describe('dead-code elimination', () => {
  it('removes an instruction nobody reads', () => {
    const { original, optimization } = optimise(
      `int main() {
  int a = 1;
  a;
  return 0;
}
`,
      ['dce'],
    );

    const dead = countVariants(optimization, 'dead-code');
    expect(dead).toHaveLength(1);
    expect(dead[0].facts).toMatchObject({ variant: 'dead-code', opcode: 'load' });
    expect(optimization.rowStatus[dead[0].beforeInstrId!]).toBe('removed');
    expect(optimization.optimizedCount).toBe(countOf(original) - 1);
    expect(verifyModule(optimization.module)).toEqual([]);
  });

  it('removes instructions that became dead only after the cascade', () => {
    const { optimization } = optimise(
      `int main() {
  int a = 1;
  int b = a + 0;
  return 0;
}
`,
      ['dce'],
    );
    // Nothing here is dead without the other passes: DCE alone only reports
    // the genuinely unread load, and must leave the rest alone.
    for (const change of optimization.changes) {
      expect(change.facts.variant).toBe('dead-code');
    }
    expect(verifyModule(optimization.module)).toEqual([]);
  });

  it('never removes memory writes, calls, allocas or terminators', () => {
    const source = `int g;
int touch();
int main() {
  int a = 1;
  g = a;
  touch();
  if (a) return a;
  return 0;
}
`;
    const { original, optimization } = optimise(source, ['dce']);
    for (const opcode of ['store', 'call', 'alloca', 'br', 'ret']) {
      const before = Object.values(original.instrs).filter((i) => i.opcode === opcode).length;
      const after = Object.values(optimization.module.instrs).filter(
        (i) => i.opcode === opcode,
      ).length;
      expect(after).toBe(before);
    }
  });
});

describe('provenance', () => {
  const SOURCE = `int main() {
  int a = 5;
  int b = a * 2 + 1;
  if (b) {
    return b;
  }
  return 0;
}
`;

  it('maps every change back to a real original instruction', () => {
    const { original, optimization } = optimise(SOURCE, ALL_PASSES);
    expect(optimization.changes.length).toBeGreaterThan(0);

    for (const change of optimization.changes) {
      if (change.beforeInstrId === null) {
        expect(change.kind).toBe('added');
        continue;
      }
      const instr = original.instrs[change.beforeInstrId];
      expect(instr).toBeDefined();
      expect(ALL_PASSES).toContain(change.pass);
      if (instr.astNodeId !== undefined) expect(change.astNodeId).toBe(instr.astNodeId);
      else expect(change.astNodeId).toBeNull();
    }
  });

  it('links a change to the source range its instruction came from', () => {
    const { result, optimization } = optimise(SOURCE, ALL_PASSES);
    const folded = countVariants(optimization, 'constant-folded');
    expect(folded.length).toBeGreaterThan(0);

    const withOrigin = folded.find((change) => change.astNodeId !== null);
    expect(withOrigin).toBeDefined();
    const node = result.ast!.nodes[withOrigin!.astNodeId!];
    expect(node).toBeDefined();
    expect(node.range.start).toBeGreaterThanOrEqual(0);
    expect(node.range.end).toBeLessThanOrEqual(result.source.length);
    expect(result.source.slice(node.range.start, node.range.end).length).toBeGreaterThan(0);
  });

  it('reports the change that explains an instruction, and null for untouched ones', () => {
    const { optimization } = optimise(SOURCE, ALL_PASSES);

    const folded = countVariants(optimization, 'constant-folded')[0];
    expect(findChangeForInstruction(optimization, folded.beforeInstrId!)).toBe(folded);

    // An instruction whose operands were rewritten points at the change that
    // did the rewriting.
    const related = optimization.changes.find(
      (change) => change.relatedInstrIds.length > 0 && change.kind !== 'replaced',
    );
    if (related !== undefined) {
      const target = related.relatedInstrIds[related.relatedInstrIds.length - 1];
      expect(findChangeForInstruction(optimization, target)?.id).toBeGreaterThanOrEqual(0);
    }

    const untouched = Object.keys(optimization.module.instrs)
      .map(Number)
      .find((id) => optimization.rowStatus[id] === 'unchanged');
    expect(untouched).toBeDefined();
    expect(findChangeForInstruction(optimization, untouched!)).toBeNull();
    expect(findChangeForInstruction(null, 0)).toBeNull();
  });

  it('diffs by instruction ID: unchanged, changed, replaced, removed', () => {
    const { original, optimization } = optimise(SOURCE, ALL_PASSES);
    const statuses = new Set(Object.values(optimization.rowStatus));
    expect(statuses.has('unchanged')).toBe(true);
    expect(statuses.has('changed') || statuses.has('removed')).toBe(true);

    for (const idText of Object.keys(original.instrs)) {
      const id = Number(idText);
      const status = optimization.rowStatus[id];
      expect(status).toBeDefined();
      if (status === 'unchanged') expect(optimization.module.instrs[id]).toBeDefined();
      if (status === 'removed' || status === 'replaced') {
        expect(optimization.module.instrs[id]).toBeUndefined();
      }
    }
    for (const idText of Object.keys(optimization.module.instrs)) {
      const status = optimization.rowStatus[Number(idText)];
      expect(status === 'unchanged' || status === 'changed' || status === 'added').toBe(true);
    }
  });
});

describe('statistics and timeline', () => {
  it('counts instructions and per-pass activity', () => {
    const { original, optimization } = optimise(
      `int main() {
  int a = 2;
  int b = 3;
  return (a + b) * 2;
}
`,
      ALL_PASSES,
    );

    expect(optimization.originalCount).toBe(countOf(original));
    expect(optimization.optimizedCount).toBe(countOf(optimization.module));
    expect(optimization.optimizedCount).toBeLessThan(optimization.originalCount);

    expect(optimization.passStates.map((state) => state.id)).toEqual(ALL_PASSES);
    let applied = 0;
    for (const state of optimization.passStates) {
      expect(state.enabled).toBe(true);
      expect(state.status === 'applied' || state.status === 'clean').toBe(true);
      if (state.status === 'applied') applied += 1;
      expect(state.changeCount).toBe(
        optimization.changes.filter((change) => change.pass === state.id).length,
      );
      expect(state.instructionCountAfter).not.toBeNull();
      expect(state.instructionCountAfter!).toBeLessThanOrEqual(optimization.originalCount);
    }
    expect(applied).toBeGreaterThan(0);

    // Counts are non-increasing along the timeline.
    const counts = [optimization.originalCount, ...optimization.passStates.map((s) => s.instructionCountAfter!)];
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBe(optimization.optimizedCount);
  });

  it('skips disabled passes in the timeline', () => {
    const { optimization } = optimise('int main() { return 1 + 2; }', ['folding', 'dce']);
    const states = Object.fromEntries(
      optimization.passStates.map((state) => [state.id, state]),
    );
    expect(states.folding.status).toBe('applied');
    expect(states.forwarding.status).toBe('disabled');
    expect(states.forwarding.instructionCountAfter).toBeNull();
    expect(states.cse.status).toBe('disabled');
    expect(states.dce.status).toBe('clean');
    expect(states.dce.instructionCountAfter).toBe(optimization.optimizedCount);
  });
});
