import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '@/content/examples';
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

function outcome(sim: SimulationResult) {
  const last = sim.steps[sim.steps.length - 1];
  return {
    outcome: sim.outcome,
    result: sim.result,
    globals: last === undefined ? {} : last.state.globals,
  };
}

function compileOk(source: string) {
  const result = compile(source);
  expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(result.ir).not.toBeNull();
  return result.ir!.module;
}

describe('optimised vs unoptimised semantics', () => {
  it('behaves identically for every example and every pass combination', () => {
    const compared: string[] = [];

    for (const example of EXAMPLES) {
      const result = compile(example.code);
      if (result.ir === null) continue;
      const original: IRModule = result.ir.module;
      const baseline = outcome(simulate(original));

      for (const passes of PASS_SUBSETS) {
        const optimization = optimizeModule(original, passes);
        expect(optimization.fallback).toBeNull();
        expect(verifyModule(optimization.module)).toEqual([]);

        const optimised = simulate(optimization.module);
        const after = outcome(optimised);

        const label = `${example.id} [${passes.join('+') || 'none'}]`;
        expect(after.outcome, label).toBe(baseline.outcome);
        expect(after.result, label).toBe(baseline.result);
        expect(after.globals, label).toEqual(baseline.globals);

        // An optimisation may only ever remove work from the trace.
        expect(optimised.steps.length, label).toBeLessThanOrEqual(
          simulate(original).steps.length,
        );
        compared.push(label);
      }
    }

    expect(compared.length).toBeGreaterThan(100);
  });

  it('preserves runtime errors instead of folding them away', () => {
    // `touch()` has no body: the interpreter must refuse to run it, with or
    // without optimisation.
    const source = `int touch();
int main() {
  return touch();
}
`;
    const original = compileOk(source);
    for (const passes of PASS_SUBSETS) {
      const optimization = optimizeModule(original, passes);
      const sim = simulate(optimization.module);
      expect(sim.outcome).toBe('error');
      expect(sim.result).toBeNull();
      expect(Object.values(optimization.module.instrs).some((i) => i.opcode === 'call')).toBe(
        true,
      );
    }
  });

  it('preserves the same values the interpreter computes at 32 bits', () => {
    const source = `int main() {
  int a = 2147483647;
  int b = 2;
  int c = a * b;
  int d = c / b;
  int e = c % b;
  return d + e;
}
`;
    const original = compileOk(source);
    const baseline = outcome(simulate(original));
    for (const passes of PASS_SUBSETS) {
      const optimization = optimizeModule(original, passes);
      const after = outcome(simulate(optimization.module));
      expect(after).toEqual(baseline);
    }
    expect(baseline.outcome).toBe('finished');
    expect(typeof baseline.result).toBe('number');
  });

  it('never mutates the module it is given', () => {
    const original = compileOk('int main() { int a = 5; return a + a; }');
    const snapshot = JSON.stringify(original);
    for (const passes of PASS_SUBSETS) {
      optimizeModule(original, passes);
      expect(JSON.stringify(original)).toBe(snapshot);
    }
  });
});
