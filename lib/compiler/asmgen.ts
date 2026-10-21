import type { AsmLine, AsmModule, IRFunction, IRInstr, IRModule, IROperand } from './types';

/**
 * Naive x86-64 (Intel syntax) lowering of the unoptimised IR (SPEC §13.2).
 *
 * Every IR value lives in its own 4-byte stack slot; each assembly line
 * records the `irInstrId` it lowers so source ↔ IR ↔ assembly mapping is
 * exact. Prologue, labels and epilogue have no mapping. This is illustrative
 * assembly *text* produced by this app's own compiler — it is never assembled
 * or executed here (the Execution stage interprets the IR directly).
 */

const ARG_REGS = ['edi', 'esi', 'edx', 'ecx', 'r8d', 'r9d'];

const SETCC: Record<string, string> = {
  eq: 'e',
  ne: 'ne',
  slt: 'l',
  sle: 'le',
  sgt: 'g',
  sge: 'ge',
};

export function generateAsm(module: IRModule): AsmModule {
  const lines: AsmLine[] = [];
  let lineNo = 0;

  const push = (
    text: string,
    kind: AsmLine['kind'],
    extra: { irInstrId?: number; funcName?: string } = {},
  ): void => {
    lines.push({ lineNo: (lineNo += 1), text, kind, ...extra });
  };

  push('; Illustrative x86-64 assembly lowered from this app\u2019s own IR.', 'comment');
  push('; Text only \u2014 never assembled or executed by this app.', 'comment');

  if (module.globals.length > 0) {
    push('  .data', 'directive');
    for (const global of module.globals) {
      push(`${global.name}:`, 'label');
      push(`  .long ${global.init}`, 'directive');
    }
    push('  .text', 'directive');
  }

  for (const fn of module.functions) {
    if (fn.isDeclaration) {
      push(`; declare @${fn.name} (external, not lowered)`, 'comment', { funcName: fn.name });
      continue;
    }
    emitFunction(push, module, fn);
  }

  return { lines };
}

type Push = (
  text: string,
  kind: AsmLine['kind'],
  extra?: { irInstrId?: number; funcName?: string },
) => void;

function emitFunction(push: Push, module: IRModule, fn: IRFunction): void {
  // ---- Slot assignment: one 4-byte cell per named value, plus one ----
  // anonymous pointee cell per alloca (the variable the pointer holds).
  const slotOf = new Map<string, number>(); // value name -> rbp offset
  const pointeeOf = new Map<string, number>(); // alloca result -> pointee offset
  let stackBytes = 0;

  const allocSlot = (): number => {
    stackBytes += 4;
    return stackBytes;
  };

  for (const param of fn.params) slotOf.set(param.name, allocSlot());

  for (const blockId of fn.blockIds) {
    const block = module.blocks[blockId];
    if (block === undefined) continue;
    for (const instrId of block.instrIds) {
      const instr = module.instrs[instrId];
      if (instr === undefined) continue;
      if (instr.opcode === 'alloca' && instr.result !== undefined) {
        pointeeOf.set(instr.result, allocSlot());
        slotOf.set(instr.result, allocSlot());
      } else if (instr.result !== undefined) {
        slotOf.set(instr.result, allocSlot());
      }
    }
  }

  const aligned = Math.ceil(stackBytes / 16) * 16;
  const slot = (name: string): number => slotOf.get(name) ?? 4;
  const local = (name: string): string => `DWORD PTR [rbp - ${slot(name)}]`;

  // ---- Prologue (no IR mapping) --------------------------------------------
  push(`${fn.name}:`, 'label', { funcName: fn.name });
  push('  push rbp', 'instruction', { funcName: fn.name });
  push('  mov rbp, rsp', 'instruction', { funcName: fn.name });
  if (aligned > 0) push(`  sub rsp, ${aligned}`, 'instruction', { funcName: fn.name });

  // Incoming parameters arrive in the first six integer registers.
  fn.params.forEach((param, index) => {
    const reg = ARG_REGS[index];
    if (reg === undefined) return;
    push(`  mov ${local(param.name)}, ${reg}`, 'instruction', { funcName: fn.name });
  });

  /** Load an operand's value into `reg`. */
  const loadValue = (operand: IROperand, reg: string, irInstrId: number): void => {
    switch (operand.kind) {
      case 'const':
        push(`  mov ${reg}, ${operand.value}`, 'instruction', { irInstrId, funcName: fn.name });
        return;
      case 'value':
        push(`  mov ${reg}, ${local(operand.name)}`, 'instruction', { irInstrId, funcName: fn.name });
        return;
      case 'global':
        push(`  mov ${reg}, [${operand.name}]`, 'instruction', { irInstrId, funcName: fn.name });
        return;
      case 'label':
        return; // labels are only used by terminators
    }
  };

  /** Load the *address* a pointer operand refers to into `reg`. */
  const loadAddress = (operand: IROperand, reg: string, irInstrId: number): void => {
    if (operand.kind === 'global') {
      push(`  lea ${reg}, [${operand.name}]`, 'instruction', { irInstrId, funcName: fn.name });
      return;
    }
    if (operand.kind === 'value') {
      const pointee = pointeeOf.get(operand.name);
      if (pointee !== undefined) {
        push(`  lea ${reg}, [rbp - ${pointee}]`, 'instruction', { irInstrId, funcName: fn.name });
        return;
      }
      // Pointer held in a cell (e.g. a copied address): load the address value.
      push(`  mov ${reg}, ${local(operand.name)}`, 'instruction', { irInstrId, funcName: fn.name });
      return;
    }
    push(`  mov ${reg}, 0`, 'instruction', { irInstrId, funcName: fn.name });
  };

  const storeResult = (name: string, reg: string, irInstrId: number): void => {
    push(`  mov ${local(name)}, ${reg}`, 'instruction', { irInstrId, funcName: fn.name });
  };

  const labelName = (blockId: number): string =>
    `.L${fn.name}.${module.blocks[blockId]?.label ?? `block${blockId}`}`;

  const emitInstr = (instr: IRInstr): void => {
    const id = instr.id;
    const ops = instr.operands;

    switch (instr.opcode) {
      case 'alloca': {
        if (instr.result === undefined) return;
        const pointee = pointeeOf.get(instr.result) ?? 4;
        push(`  lea eax, [rbp - ${pointee}]`, 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'load': {
        const ptr = ops[0];
        if (ptr === undefined || instr.result === undefined) return;
        loadAddress(ptr, 'edx', id);
        push('  mov eax, [edx]', 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'store': {
        const [stored, ptr] = ops;
        if (stored === undefined || ptr === undefined) return;
        loadValue(stored, 'eax', id);
        loadAddress(ptr, 'edx', id);
        push('  mov [edx], eax', 'instruction', { irInstrId: id, funcName: fn.name });
        return;
      }
      case 'add':
      case 'sub':
      case 'mul': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) return;
        loadValue(left, 'eax', id);
        loadValue(right, 'edx', id);
        push(`  ${instr.opcode} eax, edx`, 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'sdiv': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) return;
        loadValue(left, 'eax', id);
        loadValue(right, 'ecx', id);
        push('  cdq', 'instruction', { irInstrId: id, funcName: fn.name });
        push('  idiv ecx', 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'srem': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) return;
        loadValue(left, 'eax', id);
        loadValue(right, 'ecx', id);
        push('  cdq', 'instruction', { irInstrId: id, funcName: fn.name });
        push('  idiv ecx', 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'edx', id);
        return;
      }
      case 'icmp': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) return;
        loadValue(left, 'eax', id);
        loadValue(right, 'edx', id);
        push('  cmp eax, edx', 'instruction', { irInstrId: id, funcName: fn.name });
        push(
          `  set${SETCC[instr.predicate ?? 'ne'] ?? 'ne'} al`,
          'instruction',
          { irInstrId: id, funcName: fn.name },
        );
        push('  movzx eax, al', 'instruction', { irInstrId: id, funcName: fn.name });
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'zext': {
        const source = ops[0];
        if (source === undefined || instr.result === undefined) return;
        loadValue(source, 'eax', id);
        storeResult(instr.result, 'eax', id);
        return;
      }
      case 'br': {
        if (ops.length === 1 && ops[0].kind === 'label') {
          push(`  jmp ${labelName(ops[0].blockId)}`, 'instruction', { irInstrId: id, funcName: fn.name });
          return;
        }
        const [cond, trueOp, falseOp] = ops;
        if (cond === undefined || trueOp?.kind !== 'label' || falseOp?.kind !== 'label') return;
        loadValue(cond, 'eax', id);
        push('  cmp eax, 0', 'instruction', { irInstrId: id, funcName: fn.name });
        push(`  jne ${labelName(trueOp.blockId)}`, 'instruction', { irInstrId: id, funcName: fn.name });
        push(`  jmp ${labelName(falseOp.blockId)}`, 'instruction', { irInstrId: id, funcName: fn.name });
        return;
      }
      case 'ret': {
        const returned = ops[0];
        if (returned !== undefined) loadValue(returned, 'eax', id);
        push(`  jmp .L${fn.name}.epilogue`, 'instruction', { irInstrId: id, funcName: fn.name });
        return;
      }
      case 'call': {
        ops.slice(0, ARG_REGS.length).forEach((operand, index) => {
          loadValue(operand, ARG_REGS[index], id);
        });
        push(`  call ${instr.callee ?? ''}`, 'instruction', { irInstrId: id, funcName: fn.name });
        if (instr.result !== undefined) storeResult(instr.result, 'eax', id);
        return;
      }
      case 'unreachable':
        push('  ud2', 'instruction', { irInstrId: id, funcName: fn.name });
        return;
    }
  };

  for (const blockId of fn.blockIds) {
    const block = module.blocks[blockId];
    if (block === undefined) continue;
    push(`${labelName(blockId)}:`, 'label', { funcName: fn.name });
    for (const instrId of block.instrIds) {
      const instr = module.instrs[instrId];
      if (instr === undefined) continue;
      emitInstr(instr);
    }
  }

  push(`.L${fn.name}.epilogue:`, 'label', { funcName: fn.name });
  push('  mov rsp, rbp', 'instruction', { funcName: fn.name });
  push('  pop rbp', 'instruction', { funcName: fn.name });
  push('  ret', 'instruction', { funcName: fn.name });
}
