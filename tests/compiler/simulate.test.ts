import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import { simulate, SIM_STEP_LIMIT, type TraceStep } from '@/lib/compiler/simulate';
import type { IRModule } from '@/lib/compiler/types';

function simulateSource(source: string) {
  const result = compile(source);
  expect(result.ir, 'program must compile to IR').not.toBeNull();
  return simulate(result.ir!.module);
}

function findStep(steps: TraceStep[], predicate: (step: TraceStep) => boolean): TraceStep | undefined {
  return steps.find(predicate);
}

describe('simulate (trace-first IR interpreter)', () => {
  it('runs a returning main to completion', () => {
    const sim = simulateSource('int main() { return 42; }');

    expect(sim.outcome).toBe('finished');
    expect(sim.result).toBe(42);
    expect(sim.message).toBeNull();

    // Step 0 is the synthetic call into main; the trace ends with main's ret.
    expect(sim.steps[0].kind).toBe('start');
    expect(sim.steps[0].instrId).toBeNull();
    expect(sim.steps[0].state.frames.map((frame) => frame.funcName)).toEqual(['main']);

    const last = sim.steps[sim.steps.length - 1];
    expect(last.kind).toBe('ret');
    expect(last.state.frames).toHaveLength(0);
    expect(last.state.returnValue).toBe(42);
  });

  it('records a start step for every program and never leaves stale frames', () => {
    const sim = simulateSource('int main() { int a = 1; int b = a + 2; return b; }');

    expect(sim.outcome).toBe('finished');
    for (const step of sim.steps) {
      expect(step.index).toBeGreaterThanOrEqual(0);
      expect(step.index).toBeLessThan(SIM_STEP_LIMIT);
      expect(step.state.frames.length).toBeLessThanOrEqual(1);
    }
    expect(sim.steps[sim.steps.length - 1].state.frames).toHaveLength(0);
  });

  it('shows alloca reserving a cell that is released when main returns', () => {
    const sim = simulateSource('int main() { int x = 5; return x; }');

    const withCell = findStep(sim.steps, (step) => {
      const frame = step.state.frames[0];
      return frame !== undefined && Object.keys(frame.slots).some((name) => name.startsWith('%'));
    });
    expect(withCell).toBeDefined();

    // The cell records the exact step that allocated it.
    const frame = withCell!.state.frames[0];
    const slot = Object.values(frame.slots).find((candidate) => candidate.varName === 'x');
    expect(slot).toBeDefined();
    expect(slot!.allocatedAt).toBeLessThanOrEqual(withCell!.index);

    // At the alloca step the cell exists but is still empty; the store fills it.
    expect(slot!.value).toBe(0);
    const filled = findStep(
      sim.steps,
      (step) =>
        step.state.frames[0]?.slots[slot!.name]?.value === 5 &&
        step.state.frames[0]?.slots[slot!.name]?.varName === 'x',
    );
    expect(filled).toBeDefined();

    // Before allocation the cell did not exist; after the ret it is gone.
    const before = sim.steps[slot!.allocatedAt - 1];
    if (before !== undefined && before.state.frames[0] !== undefined) {
      expect(before.state.frames[0].slots[slot!.name]).toBeUndefined();
    }
    expect(sim.steps[sim.steps.length - 1].state.frames).toHaveLength(0);
  });

  it('pushes a frame on call and pops it on ret, passing the result back', () => {
    const sim = simulateSource(`
      int add(int a, int b) {
        return a + b;
      }
      int main() {
        return add(40, 2);
      }
    `);

    expect(sim.outcome).toBe('finished');
    expect(sim.result).toBe(42);

    const callStep = findStep(sim.steps, (step) => step.kind === 'call');
    expect(callStep).toBeDefined();
    expect(callStep!.state.frames.map((frame) => frame.funcName)).toEqual(['main', 'add']);
    // The callee frame starts with its arguments.
    const addFrame = callStep!.state.frames[1];
    const argValues = Object.values(addFrame.slots).map((slot) => slot.value);
    expect(argValues).toEqual(expect.arrayContaining([40, 2]));

    const retStep = findStep(sim.steps, (step) => step.kind === 'ret' && step.poppedFrame !== undefined);
    expect(retStep).toBeDefined();
    expect(retStep!.poppedFrame!.funcName).toBe('add');
    expect(retStep!.state.frames.map((frame) => frame.funcName)).toEqual(['main']);

    // main's cell for the call result now holds the callee's return value.
    const mainFrame = retStep!.state.frames[0];
    const returned = Object.values(mainFrame.slots).find((slot) => slot.value === 42);
    expect(returned).toBeDefined();
  });

  it('follows a loop through branches and finishes with the right value', () => {
    const sim = simulateSource(`
      int main() {
        int i = 0;
        while (i < 5) {
          i = i + 1;
        }
        return i;
      }
    `);

    expect(sim.outcome).toBe('finished');
    expect(sim.result).toBe(5);
    expect(findStep(sim.steps, (step) => step.kind === 'branch')).toBeDefined();
  });

  it('wraps arithmetic to 32-bit signed', () => {
    const sim = simulateSource('int main() { return 2147483647 + 1; }');
    expect(sim.outcome).toBe('finished');
    expect(sim.result).toBe(-2147483648);
  });

  it('stops runaway loops at the step limit instead of hanging', () => {
    const sim = simulateSource(`
      int main() {
        int i = 0;
        while (i < 100000000) {
          i = i + 1;
        }
        return i;
      }
    `);

    expect(sim.outcome).toBe('step-limit');
    expect(sim.steps.length).toBeLessThanOrEqual(SIM_STEP_LIMIT);
    expect(sim.message).toContain('step limit');
  });

  it('is deterministic: the same module always yields the same trace', () => {
    const result = compile('int main() { int i = 3; return i * i + 1; }');
    const first = simulate(result.ir!.module);
    const second = simulate(result.ir!.module);
    expect(second).toEqual(first);
  });

  it('snapshots states: later steps never mutate earlier ones', () => {
    const sim = simulateSource('int main() { int x = 1; x = x + 1; return x; }');

    const frameOf = (step: TraceStep) =>
      step.state.frames.find((candidate) => candidate.funcName === 'main');

    // The alloca step creates x's cell; find its name from the first snapshot that has it.
    const withCell = findStep(
      sim.steps,
      (step) =>
        Object.values(frameOf(step)?.slots ?? {}).some((slot) => slot.varName === 'x'),
    );
    expect(withCell).toBeDefined();
    const xName = Object.values(frameOf(withCell!)!.slots).find(
      (slot) => slot.varName === 'x',
    )!.name;

    // The step where x first becomes 2 (the store after `x + 1`).
    const firstTwo = sim.steps.findIndex(
      (step) => frameOf(step)?.slots[xName]?.value === 2,
    );
    expect(firstTwo).toBeGreaterThan(withCell!.index);

    // The write of 2 must never appear in a snapshot taken before that step —
    // the cell holds 0 (right after alloca) or 1 (after the initial store).
    for (const step of sim.steps.slice(0, firstTwo)) {
      const slot = frameOf(step)?.slots[xName];
      if (slot !== undefined) expect(slot.value).toBeLessThan(2);
    }
    // The write produced a brand-new state object rather than mutating history.
    expect(sim.steps[firstTwo].state).not.toBe(sim.steps[firstTwo - 1].state);
  });

  it('starts with globals loaded into the data segment', () => {
    const sim = simulateSource(`
      int counter = 5;
      int main() {
        counter += 1;
        return counter;
      }
    `);

    expect(sim.steps[0].state.globals).toEqual({ counter: 5 });
    expect(sim.outcome).toBe('finished');
    expect(sim.result).toBe(6);
    // The final snapshot shows the global write took effect.
    expect(sim.steps[sim.steps.length - 1].state.globals).toEqual({ counter: 6 });
  });

  it('reports no-main when there is nothing to execute', () => {
    // A declaration-only module (prototypes without bodies) has no entry point.
    const declarationOnly: IRModule = {
      globals: [],
      functions: [
        {
          name: 'helper',
          ret: 'i32',
          params: [],
          isDeclaration: true,
          blockIds: [],
        },
      ],
      blocks: [],
      instrs: [],
    };

    const sim = simulate(declarationOnly);
    expect(sim.outcome).toBe('no-main');
    expect(sim.steps).toHaveLength(0);
    expect(sim.result).toBeNull();
    expect(sim.message).toContain('main');
  });

  it('errors on a call to a prototype with no body', () => {
    const result = compile('int add(int a, int b); int main() { return add(1, 2); }');
    if (result.ir === null) {
      // The language rejected the prototype up front — nothing to simulate.
      expect(result.diagnostics.length).toBeGreaterThan(0);
      return;
    }
    const sim = simulate(result.ir.module);
    expect(sim.outcome).toBe('error');
    expect(sim.message).toContain('add');
  });
});
