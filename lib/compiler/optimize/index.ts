import { printIR } from '../irprint';
import type { IRModule } from '../types';
import type {
  OptChange,
  OptPassId,
  OptPassState,
  OptRowStatus,
  OptimizationResult,
} from './types';
import { OPT_PASS_ORDER } from './types';
import { cloneModule, countInstructions, sameInstruction } from './support';
import { runForwarding } from './forwarding';
import { runFolding } from './folding';
import { runCSE } from './cse';
import { runDCE } from './dce';
import { verifyModule } from './verify';

export type { OptChange, OptPassId, OptPassState, OptRowStatus, OptimizationResult };
export { OPT_PASS_ORDER } from './types';
export { verifyModule, type IRVerifyIssue } from './verify';

type PendingChange = Omit<OptChange, 'id'>;

/**
 * Run the enabled optimisation passes over a **clone** of the IR module.
 *
 * The original module is never touched: the IR stage keeps showing exactly
 * what the compiler produced, and this function returns the optimised copy
 * together with everything the UI needs to explain it — which instruction each
 * transformation came from, what pass did it, and how the two modules differ
 * by instruction ID.
 *
 * Passes always run in `OPT_PASS_ORDER` regardless of the order they were
 * toggled in, so the result is a pure function of (module, enabled passes).
 * Before anything is returned the result is verified structurally; if a pass
 * ever produced broken IR the optimiser falls back to a plain clone and says
 * so in `fallback` rather than shipping it.
 */
export function optimizeModule(
  module: IRModule,
  enabledPasses: readonly OptPassId[],
): OptimizationResult {
  const originalCount = countInstructions(module);
  const enabled = new Set(enabledPasses);
  const enabledInOrder = OPT_PASS_ORDER.filter((pass) => enabled.has(pass));

  const working = cloneModule(module);
  const pending: PendingChange[] = [];
  const passStates: OptPassState[] = [];

  for (const pass of OPT_PASS_ORDER) {
    const isEnabled = enabled.has(pass);
    let produced: PendingChange[] = [];

    if (isEnabled) {
      switch (pass) {
        case 'forwarding':
          produced = runForwarding(working);
          break;
        case 'folding':
          produced = runFolding(working);
          break;
        case 'cse':
          produced = runCSE(working);
          break;
        case 'dce':
          produced = runDCE(working);
          break;
      }
      pending.push(...produced);
    }

    passStates.push({
      id: pass,
      enabled: isEnabled,
      status: !isEnabled ? 'disabled' : produced.length > 0 ? 'applied' : 'clean',
      changeCount: isEnabled ? produced.length : 0,
      instructionCountAfter: isEnabled ? countInstructions(working) : null,
    });
  }

  const issues = verifyModule(working);
  if (issues.length > 0) {
    return fallback(module, enabledInOrder, issues[0].message);
  }

  const changes: OptChange[] = pending.map((change, index) => ({ ...change, id: index }));

  return {
    module: working,
    lines: printIR(working),
    originalCount,
    optimizedCount: countInstructions(working),
    changes,
    rowStatus: computeRowStatus(module, working, changes),
    passStates,
    enabledPasses: enabledInOrder,
    fallback: null,
  };
}

/** The optimiser's own safety net: never return IR it could not verify. */
function fallback(
  module: IRModule,
  enabledInOrder: OptPassId[],
  reason: string,
): OptimizationResult {
  const clean = cloneModule(module);
  const count = countInstructions(clean);
  const passStates: OptPassState[] = OPT_PASS_ORDER.map((id) => ({
    id,
    enabled: enabledInOrder.includes(id),
    status: enabledInOrder.includes(id) ? 'clean' : 'disabled',
    changeCount: 0,
    instructionCountAfter: enabledInOrder.includes(id) ? count : null,
  }));

  return {
    module: clean,
    lines: printIR(clean),
    originalCount: count,
    optimizedCount: count,
    changes: [],
    rowStatus: computeRowStatus(module, clean, []),
    passStates,
    enabledPasses: enabledInOrder,
    fallback: reason,
  };
}

/**
 * Diff the two modules **by instruction ID**: an ID that vanished was removed
 * (or replaced by a literal, when the last change for it says so), an ID whose
 * text differs changed, an ID only the optimised module has was added.
 */
function computeRowStatus(
  original: IRModule,
  optimized: IRModule,
  changes: OptChange[],
): Record<number, OptRowStatus> {
  const status: Record<number, OptRowStatus> = {};

  // The last pass to touch an instruction decides how its row reads.
  const lastChange = new Map<number, OptChange>();
  for (const change of changes) {
    for (const id of [change.beforeInstrId, change.afterInstrId]) {
      if (id !== null) lastChange.set(id, change);
    }
  }

  for (const idText of Object.keys(original.instrs)) {
    const id = Number(idText);
    const before = original.instrs[id];
    const after = optimized.instrs[id];
    if (before === undefined) continue;
    if (after === undefined) {
      const change = lastChange.get(id);
      status[id] = change?.kind === 'replaced' ? 'replaced' : 'removed';
    } else {
      status[id] = sameInstruction(before, after) ? 'unchanged' : 'changed';
    }
  }

  for (const idText of Object.keys(optimized.instrs)) {
    const id = Number(idText);
    if (status[id] === undefined) status[id] = 'added';
  }

  return status;
}

/**
 * Which transformation explains this instruction, for selection sync:
 *
 * 1. the last change *about* the instruction (it was folded, forwarded away,
 *    merged or marked dead), otherwise
 * 2. the last change that *rewrote* the instruction's operands.
 *
 * Falls back to null when the instruction is untouched, in which case the UI
 * selects the plain original instruction instead.
 */
export function findChangeForInstruction(
  result: OptimizationResult | null,
  instrId: number,
): OptChange | null {
  if (result === null) return null;

  let primary: OptChange | null = null;
  let related: OptChange | null = null;
  for (const change of result.changes) {
    if (change.beforeInstrId === instrId || change.afterInstrId === instrId) primary = change;
    else if (change.relatedInstrIds.includes(instrId)) related = change;
  }
  return primary ?? related;
}
