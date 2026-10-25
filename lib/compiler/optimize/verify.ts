import type { IRModule } from '../types';

/**
 * Structural verification of an IR module (§6.4 / §6.10).
 *
 * Used by the optimiser as a safety net before it ships anything, and by the
 * tests as the invariant every pass must preserve:
 *
 * 1. every block listed by a function exists and every instruction sits in
 *    exactly one of that function's blocks;
 * 2. each block of a defined function ends in exactly one terminator, and it
 *    is the last instruction;
 * 3. no operand refers to a value the function never defines (no instruction
 *    may be removed while something still reads it);
 * 4. branch targets are labels of blocks that belong to the function.
 */
export interface IRVerifyIssue {
  kind: 'structure' | 'terminator' | 'dangling-use' | 'branch-target';
  message: string;
  instrId?: number;
  blockId?: number;
}

export function verifyModule(module: IRModule): IRVerifyIssue[] {
  const issues: IRVerifyIssue[] = [];

  for (const fn of module.functions) {
    if (fn.isDeclaration) continue;

    const blockIds = new Set(fn.blockIds);
    const members = new Map<number, number>(); // instrId → blockId

    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) {
        issues.push({
          kind: 'structure',
          message: `Function @${fn.name} lists block ${blockId}, which does not exist.`,
          blockId,
        });
        continue;
      }

      for (const instrId of block.instrIds) {
        const instr = module.instrs[instrId];
        if (instr === undefined) {
          issues.push({
            kind: 'structure',
            message: `Block ${block.label} lists instruction ${instrId}, which does not exist.`,
            blockId,
          });
          continue;
        }
        const seen = members.get(instrId);
        if (seen !== undefined) {
          issues.push({
            kind: 'structure',
            message: `Instruction ${instrId} appears in two blocks.`,
            instrId,
            blockId,
          });
        }
        members.set(instrId, blockId);
      }

      const terminators = block.instrIds.filter((instrId) => {
        const opcode = module.instrs[instrId]?.opcode;
        return opcode === 'br' || opcode === 'ret' || opcode === 'unreachable';
      });
      const last = block.instrIds[block.instrIds.length - 1];
      if (terminators.length !== 1 || terminators[0] !== last) {
        issues.push({
          kind: 'terminator',
          message: `Block ${block.label} must end in exactly one terminator (found ${terminators.length}).`,
          blockId,
        });
      }
    }

    // Values the function itself binds: parameters plus every result defined
    // by one of its instructions.
    const defined = new Set(fn.params.map((param) => param.name));
    for (const instrId of members.keys()) {
      const result = module.instrs[instrId]?.result;
      if (result !== undefined) defined.add(result);
    }

    for (const instrId of members.keys()) {
      const instr = module.instrs[instrId];
      if (instr === undefined) continue;
      for (const operand of instr.operands) {
        if (operand.kind === 'value' && !defined.has(operand.name)) {
          issues.push({
            kind: 'dangling-use',
            message: `Instruction ${instrId} reads ${operand.name}, which nothing in @${fn.name} defines.`,
            instrId,
          });
        }
        if (operand.kind === 'label' && !blockIds.has(operand.blockId)) {
          issues.push({
            kind: 'branch-target',
            message: `Instruction ${instrId} jumps to block ${operand.blockId}, which is not part of @${fn.name}.`,
            instrId,
          });
        }
      }
    }
  }

  return issues;
}
