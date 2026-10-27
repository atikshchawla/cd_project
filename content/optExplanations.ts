import type { IROperand } from '@/lib/compiler/types';
import type { OptChange, OptPassId, OptRowStatus } from '@/lib/compiler';

/**
 * Every hand-written word the Optimization stage shows.
 *
 * The *facts* in this file are illustrative prose: they explain, in general,
 * why a transformation is legal. The concrete before/after lines the UI shows
 * are derived from the two IR modules at runtime (see `renderInstr` in
 * `lib/compiler/irprint.ts`) — this module never asserts anything about a
 * particular program's text, so nothing here is ever matched against output.
 */

export const OPT_NO_RESULT =
  'There is no IR to optimise yet. Fix the errors above — the Optimization stage runs on the IR the compiler produced.';

export const OPT_NO_CHANGES =
  'Nothing changed with this pass selection. The optimiser looked at every block and found no transformation to apply.';

export const OPT_PASS_ALL_OFF =
  'All four passes are switched off, so the optimised IR is a copy of the original one. Turn a pass on to see what it would do.';

export const OPT_FALLBACK_NOTE =
  'The optimiser could not verify its own output, so the optimised view below is the original IR unchanged. This is a safety net, not a result: no transformation was shipped.';

export const OPT_NOT_LLVM_NOTE =
  'These are this application’s own four passes, written in TypeScript for this project. They are not LLVM passes and no LLVM is involved.';

export const OPT_PASSES_HEADING = 'Passes';
export const OPT_TIMELINE_HEADING = 'Optimization timeline';
export const OPT_LEGEND_HEADING = 'Legend';
export const OPT_CHANGES_HEADING = 'Transformations';
export const OPT_PANE_HEADING_ORIGINAL = 'Original IR';
export const OPT_PANE_HEADING_OPTIMISED = 'Optimised IR';
export const OPT_VERSION_HEADING = 'IR version';

export const OPT_STATS_INSTRUCTIONS = 'instructions';
export const OPT_STATS_REMOVED = 'removed';
export const OPT_STATS_APPLIED = 'pass applied';
export const OPT_STATS_NO_PASS = 'no pass changed anything';

export function optInstructionsLabel(before: number, after: number): string {
  return `${before} → ${after} ${OPT_STATS_INSTRUCTIONS}`;
}

export function optRemovedLabel(count: number): string {
  return `${count} ${OPT_STATS_REMOVED}`;
}

export const OPT_CHANGE_NONE = 'Select a transformation to see what it changed and why.';

export const OPT_CHANGE_MISSING =
  'This transformation is no longer in the list — the pass selection changed. Pick one again from the Optimization stage.';

export const OPT_ORIGINAL_MISSING = 'This instruction no longer exists in the original IR.';
export const OPT_OPTIMISED_MISSING = 'No instruction remains at this ID: it was removed.';

/** The provenance note repeated in the stage header and the panel. */
export const OPT_PROVENANCE_NOTE =
  'Instruction text and counts are derived from the two IR modules. The reason and safety notes below are hand-written explanations.';

// ---------------------------------------------------------------------------
// Pass descriptions
// ---------------------------------------------------------------------------

export interface PassExplanation {
  label: string;
  tagline: string;
  simple: string;
  technical: string;
  /** Why the transformation is safe, in general. */
  whySafe: string;
}

export const OPT_PASS_EXPLANATIONS: Record<OptPassId, PassExplanation> = {
  forwarding: {
    label: 'Local Value Forwarding',
    tagline: 'Reuse a value that is already in hand instead of reading memory again.',
    simple:
      'The compiler already knows what a variable holds just before it reads it — the store above wrote it, or an earlier read in the same block just fetched it. Those reads can use the value directly.',
    technical:
      'Inside one basic block the pass tracks, per pointer cell, the last stored operand and the last load result. When a load appears whose cell has a known value and whose uses all sit in the same block, every use is rewritten to that value and the load is deleted. Any store to the cell, and any call (which may write a global), drops the knowledge; knowledge never crosses a block boundary.',
    whySafe:
      'The block is straight-line code, so nothing between the write and the read can change the cell, and keeping every use in that block guarantees the kept value is visible at each use.',
  },
  folding: {
    label: 'Constant & Branch Folding',
    tagline: 'Compute literal expressions while compiling, including which way a constant branch goes.',
    simple:
      'If every input to an instruction is a literal number, the answer is known right now: the instruction is replaced by that number, and a branch whose answer is known becomes a plain jump.',
    technical:
      'Pure instructions (add, sub, mul, sdiv, srem, icmp, zext) whose operands are all constants are evaluated with the same 32-bit helpers the interpreter uses, their uses are rewritten to the literal, and the instruction is removed — repeatedly, until nothing more folds. `br i1 <constant>` keeps the taken label and drops the condition, which is still a valid terminator.',
    whySafe:
      'Folding only removes instructions that compute, never ones that write or call, so evaluation order and side effects cannot move; and the arithmetic is bit-for-bit what the simulator would have done, wrap-around and `x / 0 == 0` included.',
  },
  cse: {
    label: 'Block-Local CSE',
    tagline: 'Compute the same pure expression once per block.',
    simple:
      'When a block computes the same expression twice from the same inputs, the second computation is redundant: its result is the first one’s result.',
    technical:
      'Within one basic block, each pure instruction is keyed by opcode, type, predicate and operands. A later instruction with the same key has its uses rewritten to the earlier result and is deleted. Loads, stores and calls are excluded because they are not pure — memory can change between two reads, which is precisely what pass 1 proves when it may.',
    whySafe:
      'The kept instruction is earlier in the same block, so it runs before every use of the duplicate and reaches the same inputs: no side effect is dropped, and the result is identical.',
  },
  dce: {
    label: 'Dead-Code Elimination',
    tagline: 'Delete instructions whose results nobody reads.',
    simple:
      'An instruction that computes a value nobody ever uses is work for nothing. Removing it cannot change what the program does.',
    technical:
      'The pass marks every value name still read by a surviving instruction, deletes removable instructions (arithmetic, comparisons, conversions and loads) whose results are unread, and repeats until nothing more dies — because deleting one instruction can leave its operands unused. Stores, calls, allocas and terminators are never candidates.',
    whySafe:
      'These instructions only produce a value; they write no memory, call nothing and cannot trap, so dropping them cannot be observed. Dead loads are safe to drop because nothing in this language is `volatile`.',
  },
};

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export interface LegendEntry {
  status: OptRowStatus;
  /** A text marker, so the state never depends on colour alone. */
  marker: string;
  label: string;
  description: string;
}

/** Row states in the side-by-side panes (diff by instruction ID). */
export const OPT_ROW_LEGEND: LegendEntry[] = [
  {
    status: 'unchanged',
    marker: '=',
    label: 'Unchanged',
    description: 'The same instruction, byte for byte, in both versions.',
  },
  {
    status: 'changed',
    marker: '±',
    label: 'Changed',
    description: 'Still here, but its operands or shape differ — a folded branch, for example.',
  },
  {
    status: 'replaced',
    marker: '→',
    label: 'Replaced',
    description: 'Computed to a literal; the instruction is gone and its uses read the number.',
  },
  {
    status: 'removed',
    marker: '−',
    label: 'Removed',
    description: 'Deleted outright: forwarded away, merged into an earlier copy, or dead.',
  },
  {
    status: 'added',
    marker: '+',
    label: 'Added',
    description: 'Present only in the optimised IR. The passes in this app never add instructions.',
  },
];

export const OPT_KIND_LABELS: Record<OptChange['kind'], string> = {
  changed: 'changed in place',
  replaced: 'replaced by a literal',
  removed: 'removed',
  added: 'added',
};

// ---------------------------------------------------------------------------
// Why a transformation happened, and why it is safe
// ---------------------------------------------------------------------------

function describeOperand(operand: IROperand): string {
  switch (operand.kind) {
    case 'const':
      return `the literal ${operand.value}`;
    case 'value':
      return `${operand.name}`;
    case 'global':
      return `@${operand.name}`;
    case 'label':
      return `block ${operand.blockId}`;
    case 'string':
      return `the format string ${JSON.stringify(operand.value)}`;
  }
}

export interface ChangeNarrative {
  /** What happened, in words. */
  reason: string;
  /** Why this is allowed to happen without changing behaviour. */
  safety: string;
}

/**
 * Hand-written reason and safety text for one recorded transformation.
 * The values interpolated here come from the pass itself (counts, opcodes,
 * names), never from parsing printed IR.
 */
export function explainChange(change: OptChange): ChangeNarrative {
  const facts = change.facts;
  const pass = OPT_PASS_EXPLANATIONS[change.pass];

  switch (facts.variant) {
    case 'forwarded-load': {
      const source =
        facts.keptInstrId !== null
          ? `the earlier load of ${facts.ptrLabel}`
          : `the value already stored in ${facts.ptrLabel}`;
      return {
        reason: `Every use of this load now reads ${source} directly: inside this block, ${facts.ptrLabel} is known to hold ${describeOperand(
          facts.forwarded,
        )}. ${facts.usesRewritten} instruction${
          facts.usesRewritten === 1 ? '' : 's'
        } pointed at the load’s result and now use that value instead, so the load itself is gone.`,
        safety: pass.whySafe,
      };
    }

    case 'constant-folded': {
      return {
        reason: `All operands of this ${facts.opcode} were literals, so the result is ${facts.value}. ${
          facts.usesRewritten
        } instruction${facts.usesRewritten === 1 ? '' : 's'} that read ${
          facts.usesRewritten === 1 ? 'its result' : 'its results'
        } now use ${facts.value} directly, and the ${facts.opcode} is removed.`,
        safety: pass.whySafe,
      };
    }

    case 'branch-folded': {
      const taken =
        facts.takenBlockId >= 0 ? `the branch to block ${facts.takenBlockId}` : 'the fall-through';
      return {
        reason: `The condition evaluated to ${facts.condition}, so ${taken} is the only outcome worth keeping. The instruction keeps its place and becomes an unconditional branch.`,
        safety: `Only the label that could never be reached is dropped. A branch with no condition is still a terminator, so the block structure the rest of the pipeline relies on is untouched — and the other block is simply not executed, exactly as it would not have been.`,
      };
    }

    case 'cse-duplicate': {
      return {
        reason: `This expression had already been computed in the same block by instruction ${facts.keptInstrId} with identical operands. Its ${
          facts.usesRewritten
        } use${facts.usesRewritten === 1 ? '' : 's'} now read that earlier result, so the duplicate is removed.`,
        safety: pass.whySafe,
      };
    }

    case 'dead-code': {
      return {
        reason: `Nothing in the function reads the result of this ${facts.opcode}, so it computed a value nobody wanted.`,
        safety: pass.whySafe,
      };
    }
  }
}

/** A short headline for a change, used in the list and the panel header. */
export function changeTitle(change: OptChange): string {
  switch (change.facts.variant) {
    case 'forwarded-load':
      return `Read ${change.facts.ptrLabel} without loading it`;
    case 'constant-folded':
      return `${change.facts.opcode} folded to ${change.facts.value}`;
    case 'branch-folded':
      return `Branch condition folded to ${change.facts.condition}`;
    case 'cse-duplicate':
      return `Duplicate expression merged with instruction ${change.facts.keptInstrId}`;
    case 'dead-code':
      return `Unused ${change.facts.opcode} deleted`;
  }
}

/** Which pass a change came from, for badges. */
export function passLabel(pass: OptPassId): string {
  return OPT_PASS_EXPLANATIONS[pass].label;
}
