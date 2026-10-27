import type { IRModule, IROperand } from '../types';
import type { OptChange, OptChangeFacts } from './types';
import {
  callMayEscape,
  dropInstructions,
  findUses,
  isDirectPointer,
  isGlobalKey,
  ptrKey,
  rewriteUses,
  usesConfinedToBlock,
} from './support';

/** A change before the orchestrator assigns it a stable index. */
export type PendingChange = Omit<OptChange, 'id'>;

interface CachedLoad {
  result: string;
  instrId: number;
}

/**
 * Pass 1 — Local Value Forwarding (block-local).
 *
 * Inside one basic block this pass remembers what each pointer cell holds:
 *
 * - `store C, %p` … `load %p` → the load's uses read `C` directly;
 * - `store %v, %p` … `load %p` → the load's uses read `%v` directly;
 * - `%a = load %p` … `%b = load %p` → `%b`'s uses read `%a` directly.
 *
 * Pointers make that knowledge fragile, so it is written down only where it is
 * provably safe:
 *
 * - only **direct** targets — an `alloca` or a `@global` — are recorded. Those
 *   blocks are disjoint from one another, so remembering `%a` says nothing
 *   wrong about `%b`;
 * - a store through a *computed* pointer (`ptradd`, a loaded address) forgets
 *   **everything**, because that address may be any cell the frame can reach;
 * - a store through a direct pointer forgets every computed key (which might
 *   alias it) and keeps the other direct ones;
 * - a call forgets globals, and forgets locals too as soon as any argument is
 *   a pointer — the callee could then write back through it;
 *
 * Knowledge never leaves the block it was recorded in, which is what makes the
 * pass safe: the instruction it deletes is replaced by something that provably
 * holds the same value at every use, and only when every use sits in the same
 * block (so the kept value dominates it).
 *
 * Loads nobody reads are left for dead-code elimination instead.
 */
export function runForwarding(module: IRModule): PendingChange[] {
  const changes: PendingChange[] = [];

  for (const fn of module.functions) {
    if (fn.isDeclaration) continue;

    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) continue;

      // Block-local memory knowledge: what each cell last held, and which
      // register still holds it.
      const lastStore = new Map<string, IROperand>();
      const lastLoad = new Map<string, CachedLoad>();
      const removed = new Set<number>();

      /** Forget every remembered cell the predicate selects. */
      const forget = (predicate: (key: string) => boolean): void => {
        for (const key of [...lastStore.keys()]) {
          if (predicate(key)) lastStore.delete(key);
        }
        for (const key of [...lastLoad.keys()]) {
          if (predicate(key)) lastLoad.delete(key);
        }
      };

      /** A key naming an `alloca` or a `@global`: a block nobody else can reach. */
      const isDirectKey = (key: string): boolean =>
        isGlobalKey(key) || isDirectPointer(module, { kind: 'value', name: key.slice(2) });

      for (const instrId of block.instrIds) {
        const instr = module.instrs[instrId];
        if (instr === undefined) continue;

        if (instr.opcode === 'store') {
          const ptr = instr.operands[1];
          const stored = instr.operands[0];
          if (ptr === undefined || stored === undefined) continue;

          if (!isDirectPointer(module, ptr)) {
            // A computed address may alias anything, including cells we are
            // already remembering: drop all of it.
            forget(() => true);
            continue;
          }
          const key = ptrKey(ptr);
          if (key === null) continue;
          // Other direct blocks are disjoint, so they survive; computed
          // pointers might have been pointing here, so they do not.
          forget((other) => !isDirectKey(other));
          lastStore.set(key, stored);
          lastLoad.delete(key); // the cached register may now be stale
          continue;
        }

        if (instr.opcode === 'call') {
          if (callMayEscape(module, fn, instr)) {
            // The callee got an address out of this frame: assume it wrote
            // through it, so nothing we remember about a cell survives.
            forget(() => true);
          } else {
            // With no pointer leaving the frame it can only have touched globals.
            forget(isGlobalKey);
          }
          continue;
        }

        if (instr.opcode !== 'load' || instr.result === undefined) continue;

        const ptr = instr.operands[0];
        const key = ptr === undefined ? null : ptrKey(ptr);
        if (key === null) continue;

        const stored = lastStore.get(key);
        const cached = lastLoad.get(key);
        const candidate: IROperand | null =
          stored !== undefined
            ? stored
            : cached !== undefined
              ? { kind: 'value', name: cached.result }
              : null;

        if (candidate === null) {
          // Nothing known about this cell yet: remember the load — but only
          // when it has uses, so DCE cannot delete it out from under us.
          if (findUses(module, fn, instr.result).length > 0) {
            lastLoad.set(key, { result: instr.result, instrId });
          }
          continue;
        }

        if (!usesConfinedToBlock(module, fn, instrId)) continue;
        const uses = findUses(module, fn, instr.result);
        if (uses.length === 0) continue; // dead: let DCE take it

        const rewritten = rewriteUses(module, fn, instr.result, candidate);
        removed.add(instrId);
        changes.push(
          recordForwarding(
            module,
            instrId,
            candidate,
            stored === undefined ? (cached?.instrId ?? null) : null,
            rewritten,
          ),
        );
      }

      if (removed.size > 0) dropInstructions(module, blockId, removed);
    }
  }

  return changes;
}

function recordForwarding(
  module: IRModule,
  instrId: number,
  operand: IROperand,
  keptInstrId: number | null,
  rewritten: number[],
): PendingChange {
  const instr = module.instrs[instrId];
  const ptr = instr?.operands[0];
  const ptrLabel =
    ptr === undefined
      ? ''
      : ptr.kind === 'global'
        ? `@${ptr.name}`
        : ptr.kind === 'value'
          ? ptr.name
          : '';
  const facts: OptChangeFacts = {
    variant: 'forwarded-load',
    ptrLabel,
    forwarded: operand,
    keptInstrId,
    usesRewritten: rewritten.length,
  };
  return {
    pass: 'forwarding',
    kind: 'removed',
    beforeInstrId: instrId,
    afterInstrId: null,
    astNodeId: instr?.astNodeId ?? null,
    relatedInstrIds: [
      ...new Set([...(keptInstrId === null ? [] : [keptInstrId]), ...rewritten]),
    ],
    facts,
  };
}
