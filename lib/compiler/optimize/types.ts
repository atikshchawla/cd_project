import type { IRLine, IRModule, IROperand } from '../types';

/**
 * The four optimisation passes of this app (SPEC §13.2).
 *
 * These are original educational passes written in TypeScript for this
 * visualizer. They are **not** LLVM's passes and nothing here is produced by
 * Clang or LLVM — the IR style is LLVM-like, the optimiser is ours.
 *
 * The order is fixed and is the order in which the passes run: forwarding
 * creates constant opportunities, folding creates redundancies, CSE removes
 * them, and DCE cleans up whatever became dead.
 */
export type OptPassId = 'forwarding' | 'folding' | 'cse' | 'dce';

export const OPT_PASS_ORDER: OptPassId[] = ['forwarding', 'folding', 'cse', 'dce'];

/** What happened to one instruction, as the side-by-side view shows it. */
export type OptChangeKind =
  /** Operands changed in place; the instruction is still there. */
  | 'changed'
  /** The instruction is gone and its uses now read a literal constant. */
  | 'replaced'
  /** The instruction is gone; its uses now read an existing value (or none). */
  | 'removed'
  /** A brand-new instruction that exists only in the optimised module. */
  | 'added';

/**
 * Per-instruction diff status, computed by comparing the original and the
 * optimised module by instruction **ID** (never by text).
 */
export type OptRowStatus = 'unchanged' | 'changed' | 'replaced' | 'removed' | 'added';

/** Structured facts behind one transformation; the UI turns them into prose. */
export type OptChangeFacts =
  | {
      variant: 'forwarded-load';
      /** The pointer cell the load read, e.g. `%a.addr` or `@counter`. */
      ptrLabel: string;
      /** The value every use now reads instead of the removed load. */
      forwarded: IROperand;
      /** The earlier load kept instead, when the value came from another load. */
      keptInstrId: number | null;
      usesRewritten: number;
    }
  | {
      variant: 'constant-folded';
      /** The opcode that evaluated to a literal, e.g. `add`. */
      opcode: string;
      value: number;
      usesRewritten: number;
    }
  | {
      variant: 'branch-folded';
      /** The condition value the branch tested (0 = false, else true). */
      condition: number;
      /** The block the branch always jumps to now. */
      takenBlockId: number;
    }
  | {
      variant: 'cse-duplicate';
      /** The earlier, identical instruction whose value is reused. */
      keptInstrId: number;
      usesRewritten: number;
    }
  | {
      variant: 'dead-code';
      /** The opcode of the instruction whose result nobody read. */
      opcode: string;
    };

/**
 * One transformation recorded by one pass, keyed to instruction IDs and (via
 * the original instruction) to an AST node / source range.
 */
export interface OptChange {
  /** Stable index inside one `OptimizationResult.changes` array. */
  id: number;
  pass: OptPassId;
  kind: OptChangeKind;
  /** The original instruction this is about (null only for `added`). */
  beforeInstrId: number | null;
  /** The optimised instruction (same ID when mutated in place, null when gone). */
  afterInstrId: number | null;
  /** Origin AST node of the instruction, when it has an honest origin. */
  astNodeId: number | null;
  /** Other original instructions this transformation touched (e.g. rewritten uses). */
  relatedInstrIds: number[];
  facts: OptChangeFacts;
}

export type OptPassStatus = 'disabled' | 'clean' | 'applied';

export interface OptPassState {
  id: OptPassId;
  enabled: boolean;
  status: OptPassStatus;
  /** How many transformations this pass produced. */
  changeCount: number;
  /** Instruction count after this pass (null when the pass did not run). */
  instructionCountAfter: number | null;
}

export interface OptimizationResult {
  /** Deep clone of the original module with the enabled passes applied. */
  module: IRModule;
  /** The optimised module printed as lines (same printer as the IR stage). */
  lines: IRLine[];
  originalCount: number;
  optimizedCount: number;
  /** Every transformation, in pass order, each with its structured facts. */
  changes: OptChange[];
  /** Diff status per instruction ID across both modules. */
  rowStatus: Record<number, OptRowStatus>;
  /** One entry per pass, in `OPT_PASS_ORDER`, enabled or not. */
  passStates: OptPassState[];
  enabledPasses: OptPassId[];
  /**
   * Non-null when the optimiser's own verification failed and it fell back to
   * a plain clone of the original IR instead of shipping broken output.
   */
  fallback: string | null;
}
