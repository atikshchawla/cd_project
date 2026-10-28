import type { IRGlobal, IRInstr, IRLine, IROperand, IRModule } from './types';

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
    case 'string':
      return `"${escapeForIR(operand.value)}"`;
  }
}

/** Re-escape a decoded string so it reads like source again (`"sum=%d\n"`). */
function escapeForIR(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\0/g, '\\0');
}

/**
 * Render a single instruction exactly as `printIR` would (without the
 * two-space indent). Pure and derived from the structured instruction — it
 * never inspects or parses text.
 *
 * The printed form is deliberately lean (§6.4 rule 10): a type is written only
 * where it *declares* something the line cannot otherwise show — the signature
 * of `define`/`declare`, the slot an `alloca` reserves, the target of a `zext`.
 * Everything else already implies its type (a load's type is its result's, a
 * store's is the value being written, arithmetic is always `i32`), so repeating
 * it would only bury the operands. Attributes that hold no information here are
 * left out too: every slot is one 4-byte-aligned cell, and arithmetic wraps at
 * 32 bits, so `align 4` and `nsw` would be noise — `nsw` would be a lie.
 */
export function renderInstr(module: IRModule, instr: IRInstr): string {
  const result = instr.result !== undefined ? `${instr.result} = ` : '';
  const ops = instr.operands.map((operand) => renderOperand(module, operand));

  switch (instr.opcode) {
    case 'alloca':
      // A multi-cell alloca prints its shape: `alloca [5 x i32]`.
      return `${result}alloca ${instr.shape ?? instr.type}`;
    case 'load':
      return `${result}load ${ops[0]}`;
    case 'store':
      return `store ${ops[0]}, ${ops[1]}`;
    case 'add':
    case 'sub':
    case 'mul':
    case 'sdiv':
    case 'srem':
      return `${result}${instr.opcode} ${ops[0]}, ${ops[1]}`;
    case 'ptradd':
      // Our dialect's simplified `getelementptr`: one cell per element.
      return `${result}ptradd ${ops[0]}, ${ops[1]}`;
    case 'ptrdiff':
      return `${result}ptrdiff ${ops[0]}, ${ops[1]}`;
    case 'icmp':
      return `${result}icmp ${instr.predicate ?? 'ne'} ${ops[0]}, ${ops[1]}`;
    case 'zext':
      return `${result}zext ${ops[0]} to ${instr.toType ?? 'i32'}`;
    case 'br':
      if (instr.operands.length === 1) return `br label ${ops[0]}`;
      return `br ${ops[0]}, label ${ops[1]}, label ${ops[2]}`;
    case 'ret':
      if (instr.operands.length === 0) return `ret void`;
      return `ret ${ops[0]}`;
    case 'call': {
      const args = ops.join(', ');
      const call = `call @${instr.callee ?? ''}(${args})`;
      return instr.result !== undefined ? `${result}${call}` : call;
    }
    case 'unreachable':
      return `unreachable`;
  }
}

/**
 * The right-hand side of a global definition.
 *
 * Scalars keep their type (`i32 0`), because that is the declaration. Arrays
 * and records print their shape and either `zeroinitializer` or the bare cell
 * list — the shape already says `x i32`, so repeating it per cell would only
 * bury the numbers. Very long lists are elided with `...`; this listing is
 * never assembled or parsed back.
 */
function globalText(global: IRGlobal): string {
  const cells = global.cells ?? 1;
  if (cells === 1) return `i32 ${global.init}`;
  const inits = global.inits;
  const values = inits ?? [];
  if (!values.some((value) => value !== 0)) return `[${cells} x i32] zeroinitializer`;
  const shown = values.slice(0, 64).map((value) => String(value));
  if (values.length > 64) shown.push('...');
  return `[${cells} x i32] [${shown.join(', ')}]`;
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

  // Globals first: `@g = global i32 <init>`, or `[N x i32]` for arrays/records.
  for (const global of module.globals) {
    push(`@${global.name} = global ${globalText(global)}`);
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
