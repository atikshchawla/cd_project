import type { IRModule, IROperand } from '../types';
import type { OptChange, OptChangeFacts } from './types';
import {
  dropInstructions,
  functionInstrIds,
  isDirectPointer,
  isTerminator,
} from './support';

/** A change before the orchestrator assigns it a stable index. */
export type PendingChange = Omit<OptChange, 'id'>;

/**
 * Instructions DCE may delete: they write no memory, call nothing and never
 * trap in this dialect, so their only effect is producing a value.
 * `alloca` is kept on purpose — it names a source variable and reserves the
 * frame cell the Execution stage shows, and `ptradd` / `ptrdiff` are kept
 * because they are addressed computations the stage explains (and `ptrdiff`
 * can fail at run time on unrelated pointers).
 *
 * `load` and `sdiv` / `srem` need extra proof, which `canRemove` checks: a
 * load of a bad pointer and a division by zero both stop the program, so
 * deleting them would change what the program does.
 */
const REMOVABLE = new Set(['load', 'add', 'sub', 'mul', 'sdiv', 'srem', 'icmp', 'zext']);

/** Is `operand` a constant that is definitely not zero? */
function isNonZeroConst(operand: IROperand | undefined): boolean {
  return operand !== undefined && operand.kind === 'const' && operand.value !== 0;
}

/**
 * May this instruction be deleted when its result is unused?
 *
 * - `sdiv` / `srem` only when the divisor is a non-zero literal, because
 *   dividing by zero is a runtime error this interpreter reports;
 * - `load` only when the pointer is a variable or a global the module itself
 *   allocates, because loading through anything else could be an invalid or
 *   freed pointer — again a runtime error worth preserving.
 */
function canRemove(module: IRModule, instrId: number): boolean {
  const instr = module.instrs[instrId];
  if (instr === undefined) return false;
  if (instr.opcode === 'sdiv' || instr.opcode === 'srem') {
    return isNonZeroConst(instr.operands[1]);
  }
  if (instr.opcode === 'load') {
    const pointer = instr.operands[0];
    if (pointer === undefined) return false;
    return isDirectPointer(module, pointer);
  }
  return true;
}

/**
 * Pass 4 — Dead-Code Elimination.
 *
 * Delete instructions whose result nobody reads, then repeat: removing one
 * instruction can leave its operands unused, so this is a fixpoint, not a
 * single sweep.
 *
 * `store`, `call` and the terminators are never candidates — they are how the
 * program does something, not how it computes a value. `alloca` stays too (it
 * is the identity of a source variable).
 */
export function runDCE(module: IRModule): PendingChange[] {
  const changes: PendingChange[] = [];

  for (let sweep = 0; sweep < 64; sweep += 1) {
    let progress = false;

    for (const fn of module.functions) {
      if (fn.isDeclaration) continue;

      // Every value name some surviving instruction still reads.
      const used = new Set<string>();
      for (const instrId of functionInstrIds(module, fn)) {
        const instr = module.instrs[instrId];
        if (instr === undefined) continue;
        for (const operand of instr.operands) {
          if (operand.kind === 'value') used.add(operand.name);
        }
      }

      const removed = new Set<number>();

      for (const instrId of functionInstrIds(module, fn)) {
        const instr = module.instrs[instrId];
        if (instr === undefined) continue;
        if (instr.result === undefined) continue;
        if (isTerminator(instr.opcode)) continue;
        if (!REMOVABLE.has(instr.opcode)) continue;
        if (used.has(instr.result)) continue;
        if (!canRemove(module, instrId)) continue;

        removed.add(instrId);
        progress = true;

        const facts: OptChangeFacts = { variant: 'dead-code', opcode: instr.opcode };
        changes.push({
          pass: 'dce',
          kind: 'removed',
          beforeInstrId: instrId,
          afterInstrId: null,
          astNodeId: instr.astNodeId ?? null,
          relatedInstrIds: [],
          facts,
        });
      }

      if (removed.size > 0) {
        for (const blockId of fn.blockIds) dropInstructions(module, blockId, removed);
      }
    }

    if (!progress) break;
  }

  return changes;
}
