import type { IRModule } from '../types';
import type { OptChange, OptChangeFacts } from './types';
import { dropInstructions, functionInstrIds, isTerminator } from './support';

/** A change before the orchestrator assigns it a stable index. */
export type PendingChange = Omit<OptChange, 'id'>;

/**
 * Instructions DCE may delete: they write no memory, call nothing and never
 * trap in this dialect, so their only effect is producing a value.
 * `alloca` is kept on purpose — it names a source variable and reserves the
 * frame cell the Execution stage shows.
 */
const REMOVABLE = new Set(['load', 'add', 'sub', 'mul', 'sdiv', 'srem', 'icmp', 'zext']);

/**
 * Pass 4 — Dead-Code Elimination.
 *
 * Delete instructions whose result nobody reads, then repeat: removing one
 * instruction can leave its operands unused, so this is a fixpoint, not a
 * single sweep.
 *
 * `store`, `call` and the terminators are never candidates — they are how the
 * program does something, not how it computes a value. `alloca` stays too (it
 * is the identity of a source variable). Loads are removed when unused: a load
 * has no side effect in this language (there is no `volatile`), so dropping it
 * cannot change what the program observes.
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
