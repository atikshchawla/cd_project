import type { IRModule } from '../types';
import type { OptChange, OptChangeFacts } from './types';
import { dropInstructions, findUses, rewriteUses, usesConfinedToBlock } from './support';

/** A change before the orchestrator assigns it a stable index. */
export type PendingChange = Omit<OptChange, 'id'>;

/** Opcodes that are pure: identical inputs always mean an identical result. */
const PURE_OPCODES = new Set(['add', 'sub', 'mul', 'sdiv', 'srem', 'icmp', 'zext']);

/** Canonical key of a pure instruction: opcode, type, predicate and operands. */
function cseKey(module: IRModule, instrId: number): string | null {
  const instr = module.instrs[instrId];
  if (instr === undefined || !PURE_OPCODES.has(instr.opcode)) return null;
  return JSON.stringify([
    instr.opcode,
    instr.type,
    instr.predicate ?? null,
    instr.toType ?? null,
    instr.operands,
  ]);
}

/**
 * Pass 3 — Block-Local Common Subexpression Elimination.
 *
 * Inside one basic block, if a pure instruction computes exactly what an
 * earlier instruction already computed, the later one is redundant: its uses
 * are pointed at the earlier result and it is deleted.
 *
 * Only genuinely pure opcodes take part. `load` is deliberately excluded —
 * memory can change, so two loads are only equal if something proved they are,
 * and that is what pass 1 does. `store` and `call` are never candidates
 * either, so no side effect is ever dropped or reordered.
 *
 * The kept instruction is earlier in the same block, so it dominates every use
 * the duplicate had (the optimiser refuses to merge when a use escapes the
 * block). Because the duplicate's uses become the kept instruction's uses,
 * dead-code elimination will keep it alive.
 */
export function runCSE(module: IRModule): PendingChange[] {
  const changes: PendingChange[] = [];

  for (const fn of module.functions) {
    if (fn.isDeclaration) continue;

    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) continue;

      /** key → the first instruction in this block that produced that value. */
      const seen = new Map<string, number>();
      const removed = new Set<number>();

      for (const instrId of block.instrIds) {
        const instr = module.instrs[instrId];
        if (instr === undefined || instr.result === undefined) continue;

        const key = cseKey(module, instrId);
        if (key === null) continue;

        const kept = seen.get(key);
        if (kept === undefined) {
          seen.set(key, instrId);
          continue;
        }

        const keptInstr = module.instrs[kept];
        if (keptInstr === undefined || keptInstr.result === undefined) continue;

        if (!usesConfinedToBlock(module, fn, instrId)) continue;
        const uses = findUses(module, fn, instr.result);
        if (uses.length === 0) continue; // dead: let DCE take it

        const rewritten = rewriteUses(module, fn, instr.result, {
          kind: 'value',
          name: keptInstr.result,
        });
        removed.add(instrId);

        const facts: OptChangeFacts = {
          variant: 'cse-duplicate',
          keptInstrId: kept,
          usesRewritten: rewritten.length,
        };
        changes.push({
          pass: 'cse',
          kind: 'removed',
          beforeInstrId: instrId,
          afterInstrId: null,
          astNodeId: instr.astNodeId ?? null,
          relatedInstrIds: [...new Set([kept, ...rewritten])],
          facts,
        });
      }

      if (removed.size > 0) dropInstructions(module, blockId, removed);
    }
  }

  return changes;
}
