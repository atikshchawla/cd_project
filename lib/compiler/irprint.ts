import type { IRInstr, IRLine, IROperand, IRModule } from './types';

/** Render one operand as the IR printer prints it (`%x`, `5`, `%label`, `@g`). */
export function renderOperand(module: IRModule, operand: IROperand): string {
  switch (operand.kind) {
    case 'value':
      return operand.name;
    case 'const':
      return String(operand.value);
    case 'label':
      return `%${module.blocks[operand.blockId]?.label ?? `block${operand.blockId}`}`;
    case 'global':
      return `@${operand.name}`;
  }
}

function typedOperandText(module: IRModule, operand: IROperand, type: string): string {
  return operand.kind === 'const'
    ? `${operand.type} ${operand.value}`
    : `${type} ${renderOperand(module, operand)}`;
}

/**
 * Render a single instruction exactly as `printIR` would (without the
 * two-space indent). Pure and derived from the structured instruction — it
 * never inspects or parses text.
 */
export function renderInstr(module: IRModule, instr: IRInstr): string {
  const result = instr.result !== undefined ? `${instr.result} = ` : '';
  const ops = instr.operands.map((operand) => renderOperand(module, operand));

  switch (instr.opcode) {
    case 'alloca':
      return `${result}alloca ${instr.type}, align 4`;
    case 'load':
      return `${result}load ${instr.type}, ${typedOperandText(module, instr.operands[0], 'ptr')}, align 4`;
    case 'store': {
      const [stored, ptr] = instr.operands;
      return `store ${typedOperandText(module, stored, instr.type)}, ${typedOperandText(module, ptr, 'ptr')}, align 4`;
    }
    case 'add':
    case 'sub':
    case 'mul':
      return `${result}${instr.opcode} nsw ${instr.type} ${ops[0]}, ${ops[1]}`;
    case 'sdiv':
    case 'srem':
      return `${result}${instr.opcode} ${instr.type} ${ops[0]}, ${ops[1]}`;
    case 'icmp':
      return `${result}icmp ${instr.predicate ?? 'ne'} i32 ${ops[0]}, ${ops[1]}`;
    case 'zext':
      return `${result}zext i1 ${ops[0]} to ${instr.toType ?? 'i32'}`;
    case 'br':
      if (instr.operands.length === 1) return `br label ${ops[0]}`;
      return `br i1 ${ops[0]}, label ${ops[1]}, label ${ops[2]}`;
    case 'ret':
      if (instr.operands.length === 0) return `ret void`;
      return `ret ${instr.type} ${ops[0]}`;
    case 'call': {
      const args = instr.operands
        .map((operand) => typedOperandText(module, operand, 'i32'))
        .join(', ');
      const call = `call ${instr.type} @${instr.callee ?? ''}(${args})`;
      return instr.result !== undefined ? `${result}${call}` : call;
    }
    case 'unreachable':
      return `unreachable`;
  }
}

/**
 * Print an IR module as text lines (§6.4 rule 10).
 *
 * Pure: never mutates the module. Every instruction line records its
 * `instrId`, `blockId` and `funcName` so the UI can map rows back to the
 * structured IR without parsing text.
 */
export function printIR(module: IRModule): IRLine[] {
  const lines: IRLine[] = [];
  let lineNo = 0;

  const push = (
    text: string,
    extra: { instrId?: number; blockId?: number; funcName?: string } = {},
  ): void => {
    lines.push({ lineNo: (lineNo += 1), text, ...extra });
  };

  // Globals first: `@g = global i32 <init>`.
  for (const global of module.globals) {
    push(`@${global.name} = global i32 ${global.init}`);
  }
  if (module.globals.length > 0 && module.functions.length > 0) push('');

  for (const fn of module.functions) {
    if (fn.isDeclaration) {
      const params = fn.params.map((param) => param.type).join(', ');
      push(`declare ${fn.ret} @${fn.name}(${params})`, { funcName: fn.name });
      continue;
    }

    const params = fn.params.map((param) => `${param.type} ${param.name}`).join(', ');
    push(`define ${fn.ret} @${fn.name}(${params}) {`, { funcName: fn.name });

    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block === undefined) continue;
      push(`${block.label}:`, { blockId, funcName: fn.name });
      for (const instrId of block.instrIds) {
        const instr = module.instrs[instrId];
        if (instr === undefined) continue;
        push(`  ${renderInstr(module, instr)}`, { instrId, blockId, funcName: fn.name });
      }
    }

    push('}', { funcName: fn.name });
  }

  return lines;
}
