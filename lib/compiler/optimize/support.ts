import type { IRFunction, IRInstr, IRModule, IROperand, IRType } from '../types';

/**
 * Shared plumbing for the optimisation passes.
 *
 * Everything here is pure and works on the *clone* the optimiser owns, so the
 * original IR the IR stage printed is never touched. All lookups are by
 * instruction / block ID; nothing in this file ever parses or matches text.
 */

/** Deep clone of a JSON-serialisable IR module (§6 rule 6). */
export function cloneModule(module: IRModule): IRModule {
  return JSON.parse(JSON.stringify(module)) as IRModule;
}

export function isTerminator(opcode: string): boolean {
  return opcode === 'br' || opcode === 'ret' || opcode === 'unreachable';
}

export function countInstructions(module: IRModule): number {
  return placedInstructionIds(module).size;
}

/**
 * Instruction IDs that actually sit in a block — the ones the printer, the
 * assembler and the simulator all walk. (IR generation can leave an unused
 * `unreachable` in the map when a block already ended; it is never printed.)
 */
export function placedInstructionIds(module: IRModule): Set<number> {
  const placed = new Set<number>();
  for (const fn of module.functions) {
    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) continue;
      for (const instrId of block.instrIds) placed.add(instrId);
    }
  }
  return placed;
}

/** Key for a pointer operand so `%x` and `@x` can never collide. */
export function ptrKey(operand: IROperand): string | null {
  if (operand.kind === 'value') return `v:${operand.name}`;
  if (operand.kind === 'global') return `g:${operand.name}`;
  return null;
}

export function isGlobalKey(key: string): boolean {
  return key.startsWith('g:');
}

/** The instruction that defines `name` anywhere in `module`, if any. */
export function definitionOf(module: IRModule, name: string): IRInstr | undefined {
  for (const fn of module.functions) {
    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) continue;
      for (const instrId of block.instrIds) {
        const instr = module.instrs[instrId];
        if (instr?.result === name) return instr;
      }
    }
  }
  return undefined;
}

/**
 * True when the operand names storage the module allocates itself — an
 * `alloca` result or a `@global`.
 *
 * Those blocks are created by the very instruction that names them, so
 * reading or writing through one can only ever land inside a live cell: the
 * access never reports an invalid pointer, a null dereference or a
 * use-after-free at run time. Anything else (a loaded pointer, a `ptradd`
 * result) may point anywhere, which is what makes it unsafe to touch.
 */
export function isDirectPointer(module: IRModule, operand: IROperand): boolean {
  if (operand.kind === 'global') return true;
  if (operand.kind !== 'value') return false;
  return definitionOf(module, operand.name)?.opcode === 'alloca';
}

/**
 * The IR type of an operand, so passes can tell a pointer from a plain value.
 *
 * `alloca` results always count as pointers (they are addresses even when the
 * array they name is spelled `i32` with a `shape`), and anything unresolvable
 * reports `ptr` so callers stay conservative.
 */
export function operandType(module: IRModule, fn: IRFunction, operand: IROperand): IRType {
  switch (operand.kind) {
    case 'const':
      return operand.type;
    case 'global':
    case 'string':
      return 'ptr';
    case 'label':
      return 'i1';
    case 'value': {
      const param = fn.params.find((candidate) => candidate.name === operand.name);
      if (param !== undefined) return param.type;
      const defining = definitionOf(module, operand.name);
      if (defining === undefined) return 'ptr';
      if (defining.opcode === 'alloca') return 'ptr';
      if (defining.opcode === 'icmp') return 'i1';
      return defining.type;
    }
  }
}

/**
 * True when any argument of a call could carry this function's own memory out
 * to the callee (an address of a local, an array's base, a pointer value).
 *
 * A callee that receives one can write back through it, so it may change any
 * cell this frame can reach; a call whose arguments are all plain integers can
 * still touch globals, but never the caller's stack.
 */
export function callMayEscape(module: IRModule, fn: IRFunction, instr: IRInstr): boolean {
  if (BUILTIN_CALLS.has(instr.callee ?? '')) return false; // they never touch our memory
  return instr.operands.some((operand) => operandType(module, fn, operand) === 'ptr');
}

/** The language's own calls: they write neither globals nor the caller's frame. */
export const BUILTIN_CALLS = new Set(['malloc', 'free', 'delete', 'print', 'printf']);

/** Instruction IDs of one function, in block order then program order. */
export function functionInstrIds(module: IRModule, fn: IRFunction): number[] {
  const ids: number[] = [];
  for (const blockId of fn.blockIds) {
    const block = module.blocks[blockId];
    if (block === undefined) continue;
    for (const instrId of block.instrIds) ids.push(instrId);
  }
  return ids;
}

/** Names bound by the function itself (parameters), which no instruction defines. */
export function paramNames(fn: IRFunction): Set<string> {
  const names = new Set<string>();
  for (const param of fn.params) names.add(param.name);
  return names;
}

/** Every instruction ID whose result is defined in `fn`. */
export function definedInstrIds(module: IRModule, fn: IRFunction): Set<number> {
  const defined = new Set<number>();
  for (const instrId of functionInstrIds(module, fn)) defined.add(instrId);
  return defined;
}

/** The block that contains an instruction, or null. */
export function blockOf(module: IRModule, fn: IRFunction, instrId: number): number | null {
  for (const blockId of fn.blockIds) {
    const block = module.blocks[blockId];
    if (block === undefined) continue;
    if (block.instrIds.includes(instrId)) return blockId;
  }
  return null;
}

/** Instruction IDs in `fn` that read the value named `name`. */
export function findUses(module: IRModule, fn: IRFunction, name: string): number[] {
  const uses: number[] = [];
  for (const instrId of functionInstrIds(module, fn)) {
    const instr = module.instrs[instrId];
    if (instr === undefined) continue;
    if (instr.operands.some((operand) => operand.kind === 'value' && operand.name === name)) {
      uses.push(instrId);
    }
  }
  return uses;
}

/**
 * Point every `name` value operand in `fn` at `replacement`.
 *
 * Returns the IDs of the instructions that actually changed. Callers only do
 * this when the replacement is provably equal to the old value (the definition
 * dominates every use, or the replacement is a compile-time constant).
 */
export function rewriteUses(
  module: IRModule,
  fn: IRFunction,
  name: string,
  replacement: IROperand,
): number[] {
  const changed: number[] = [];
  for (const instrId of functionInstrIds(module, fn)) {
    const instr = module.instrs[instrId];
    if (instr === undefined) continue;
    let touched = false;
    const operands = instr.operands.map((operand) => {
      if (operand.kind === 'value' && operand.name === name) {
        touched = true;
        return replacement;
      }
      return operand;
    });
    if (touched) {
      instr.operands = operands;
      changed.push(instrId);
    }
  }
  return changed;
}

/**
 * True when every use of an instruction's result sits in the instruction's own
 * block. The optimiser only forwards / merges values when this holds, so the
 * value it keeps is always visible at the use site (it dominates it).
 */
export function usesConfinedToBlock(
  module: IRModule,
  fn: IRFunction,
  instrId: number,
): boolean {
  const instr = module.instrs[instrId];
  if (instr === undefined || instr.result === undefined) return false;
  const blockId = blockOf(module, fn, instrId);
  if (blockId === null) return false;
  const block = module.blocks[blockId];
  if (block === undefined) return false;
  const allowed = new Set(block.instrIds);
  for (const useId of findUses(module, fn, instr.result)) {
    if (!allowed.has(useId)) return false;
  }
  return true;
}

/**
 * Delete instructions for good: drop them from their block and erase them from
 * the module's instruction map (so counts, diffs and verification only ever see
 * instructions that still exist).
 */
export function dropInstructions(
  module: IRModule,
  blockId: number,
  removed: Set<number>,
): void {
  const block = module.blocks[blockId];
  if (block !== undefined) {
    block.instrIds = block.instrIds.filter((instrId) => !removed.has(instrId));
  }
  for (const instrId of removed) delete module.instrs[instrId];
}

/** Structural equality used for the by-ID diff (ignores ID and origin only). */
export function sameInstruction(a: IRInstr, b: IRInstr): boolean {
  return (
    a.opcode === b.opcode &&
    a.type === b.type &&
    a.result === b.result &&
    a.predicate === b.predicate &&
    a.toType === b.toType &&
    a.callee === b.callee &&
    a.varName === b.varName &&
    JSON.stringify(a.operands) === JSON.stringify(b.operands)
  );
}
