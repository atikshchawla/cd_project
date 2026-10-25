import { compare32, div32, mul32, rem32, wrap32 } from '../int32';
import type { IRInstr, IRModule, IROperand, IRType } from '../types';
import type { OptChange, OptChangeFacts } from './types';
import { dropInstructions, rewriteUses } from './support';

/** A change before the orchestrator assigns it a stable index. */
export type PendingChange = Omit<OptChange, 'id'>;

/** Folding stops short of absurd nesting; more depth than this is not reached. */
const MAX_PASSES = 64;

function constTypeFor(instr: IRInstr): IRType {
  switch (instr.opcode) {
    case 'icmp':
      return 'i32'; // icmp compares two i32 values
    case 'zext':
      return 'i1'; // zext widens an i1
    case 'br':
      return 'i1'; // a branch condition is i1
    case 'call':
      return 'i32'; // arguments are always i32, whatever the call returns
    default:
      return instr.type;
  }
}

function constValueAt(operand: IROperand | undefined): number | null {
  return operand !== undefined && operand.kind === 'const' ? operand.value : null;
}

/**
 * Evaluate an instruction whose operands are all known at compile time.
 *
 * Returns null when the opcode is not a pure constant expression. Every
 * arithmetic helper and the `icmp` comparison are the exact ones the simulator
 * uses, so a folded program computes what the interpreter would have computed —
 * including 32-bit wrap-around and `x / 0 == 0`.
 */
function foldValue(instr: IRInstr): number | null {
  const a = constValueAt(instr.operands[0]);
  const b = constValueAt(instr.operands[1]);

  switch (instr.opcode) {
    case 'add':
      return a === null || b === null ? null : wrap32(a + b);
    case 'sub':
      return a === null || b === null ? null : wrap32(a - b);
    case 'mul':
      return a === null || b === null ? null : mul32(a, b);
    case 'sdiv':
      return a === null || b === null ? null : div32(a, b);
    case 'srem':
      return a === null || b === null ? null : rem32(a, b);
    case 'icmp':
      return a === null || b === null
        ? null
        : compare32(instr.predicate ?? 'ne', a, b)
          ? 1
          : 0;
    case 'zext':
      return a === null ? null : a !== 0 ? 1 : 0;
    default:
      return null;
  }
}

/**
 * Pass 2 — Constant & Branch Folding.
 *
 * When every operand of a pure instruction is a literal, the instruction
 * evaluates to a literal: its uses are rewritten to that literal and the
 * instruction itself disappears. `br i1 <literal>` loses its condition and
 * becomes a plain `br label`, which is still a valid terminator.
 *
 * Because a rewritten use may itself now be constant, the pass sweeps the
 * whole function until nothing more changes (expression depth, not program
 * size, decides how many sweeps are needed).
 *
 * Only opcodes with no side effects are folded: `store`, `call` and every
 * terminator other than the branch condition are left alone, so evaluation
 * order and side effects never move. `icmp`/`zext` use the shared `int32`
 * helpers, so their answers match the interpreter bit for bit.
 */
export function runFolding(module: IRModule): PendingChange[] {
  const changes: PendingChange[] = [];

  for (const fn of module.functions) {
    if (fn.isDeclaration) continue;

    for (let sweep = 0; sweep < MAX_PASSES; sweep += 1) {
      let progress = false;

      for (const blockId of fn.blockIds) {
        const block = module.blocks[blockId];
        if (block === undefined) continue;

        const removed = new Set<number>();

        for (const instrId of block.instrIds) {
          const instr = module.instrs[instrId];
          if (instr === undefined) continue;

          const branchCondition = foldBranch(instr);
          if (branchCondition !== null) {
            progress = true;
            changes.push(recordBranch(instr, branchCondition));
            continue;
          }

          if (instr.result === undefined) continue;
          const value = foldValue(instr);
          if (value === null) continue;

          const replacement: IROperand = {
            kind: 'const',
            value,
            type: constTypeFor(instr),
          };
          const rewritten = rewriteUses(module, fn, instr.result, replacement);
          removed.add(instrId);
          progress = true;

          const facts: OptChangeFacts = {
            variant: 'constant-folded',
            opcode: instr.opcode,
            value,
            usesRewritten: rewritten.length,
          };
          changes.push({
            pass: 'folding',
            kind: 'replaced',
            beforeInstrId: instrId,
            afterInstrId: null,
            astNodeId: instr.astNodeId ?? null,
            relatedInstrIds: rewritten,
            facts,
          });
        }

        if (removed.size > 0) dropInstructions(module, blockId, removed);
      }

      if (!progress) break;
    }
  }

  return changes;
}

/**
 * Collapse `br i1 <const>, label A, label B` into `br label A` (in place).
 *
 * Returns the condition value that was tested, or null when the branch is
 * conditional and must stay as it is.
 */
function foldBranch(instr: IRInstr): number | null {
  if (instr.opcode !== 'br' || instr.operands.length !== 3) return null;
  const condition = instr.operands[0];
  if (condition.kind !== 'const') return null;

  const target = condition.value !== 0 ? instr.operands[1] : instr.operands[2];
  if (target === undefined || target.kind !== 'label') return null;

  instr.operands = [target];
  instr.type = 'void';
  return condition.value;
}

function recordBranch(instr: IRInstr, condition: number): PendingChange {
  const taken = instr.operands[0];
  const facts: OptChangeFacts = {
    variant: 'branch-folded',
    condition,
    takenBlockId: taken !== undefined && taken.kind === 'label' ? taken.blockId : -1,
  };
  return {
    pass: 'folding',
    kind: 'changed',
    beforeInstrId: instr.id,
    afterInstrId: instr.id,
    astNodeId: instr.astNodeId ?? null,
    relatedInstrIds: [],
    facts,
  };
}
