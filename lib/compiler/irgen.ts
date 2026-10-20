import { wrap32 } from './int32';
import type {
  Ast,
  AstNode,
  IRFunction,
  IRGlobal,
  IRInstr,
  IRModule,
  IROperand,
  IRType,
} from './types';

const I32: IRType = 'i32';
const PTR: IRType = 'ptr';
const I1: IRType = 'i1';
const VOID: IRType = 'void';

/** Values produced by expression codegen: an operand plus its IR type. */
interface GenValue {
  operand: IROperand;
  type: IRType;
}

/**
 * LLVM-style, `-O0`-like IR generation from the annotated AST (§6.4).
 *
 * Only called when semantic analysis produced no errors. The irModule it builds
 * satisfies the builder invariant: every block ends in exactly one terminator.
 */
export function generateIR(ast: Ast): IRModule {
  const nodes = ast.nodes;
  const irModule: IRModule = { functions: [], globals: [], blocks: {}, instrs: {} };
  let nextInstrId = 0;
  let nextBlockId = 0;

  // ---- Global variables ----------------------------------------------------

  /** Top-level `int` variables become `@name` globals (rule 8). */
  const globalDecls = new Map<number, string>(); // decl node id -> global name
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'VarDecl') continue;
    if (nodes[node.parentId ?? -1]?.kind !== 'TranslationUnit') continue;
    let init = 0;
    if (node.childIds.length > 0) {
      const initNode = nodes[node.childIds[0]];
      if (initNode.kind === 'IntegerLiteral') init = wrap32(initNode.value ?? 0);
    }
    const global: IRGlobal = { name: node.name ?? '', init, astNodeId: node.id };
    irModule.globals.push(global);
    globalDecls.set(node.id, global.name);
  }

  // ---- Function-level builder ---------------------------------------------

  interface FunctionBuilder {
    fn: IRFunction;
    usedNames: Set<string>;
    labelCounts: Map<string, number>;
    tempCounter: number;
    currentBlockId: number;
    /** Alloca instruction ids for params and locals, inserted at top of entry. */
    entryAllocaIds: number[];
    /** Declaring AST node id -> the pointer that holds the variable. */
    slots: Map<number, IROperand>;
    loopStack: { breakLabel: number; continueLabel: number }[];
  }

  let builder: FunctionBuilder | null = null;

  const isTerminator = (opcode: IRInstr['opcode']): boolean =>
    opcode === 'br' || opcode === 'ret' || opcode === 'unreachable';

  const blockTerminated = (blockId: number): boolean => {
    const instrIds = irModule.blocks[blockId].instrIds;
    return instrIds.length > 0 && isTerminator(irModule.instrs[instrIds[instrIds.length - 1]].opcode);
  };

  const createBlock = (hint: string): number => {
    const count = builder!.labelCounts.get(hint) ?? 0;
    builder!.labelCounts.set(hint, count + 1);
    const label = count === 0 ? hint : `${hint}${count}`;
    const id = nextBlockId++;
    irModule.blocks[id] = { id, label, instrIds: [] };
    builder!.fn.blockIds.push(id);
    return id;
  };

  /** Rule 1: code is never emitted into an already-terminated block. */
  const emit = (instr: Omit<IRInstr, 'id'>): IRInstr => {
    if (builder!.currentBlockId === -1 || blockTerminated(builder!.currentBlockId)) {
      builder!.currentBlockId = createBlock('dead');
    }
    const full: IRInstr = { ...instr, id: nextInstrId++ };
    irModule.instrs[full.id] = full;
    irModule.blocks[builder!.currentBlockId].instrIds.push(full.id);
    return full;
  };

  /** Rule 2: allocas are collected and inserted at the top of `entry`. */
  const emitAlloca = (instr: Omit<IRInstr, 'id' | 'opcode'>): IRInstr => {
    const full: IRInstr = { ...instr, id: nextInstrId++, opcode: 'alloca' };
    irModule.instrs[full.id] = full;
    builder!.entryAllocaIds.push(full.id);
    return full;
  };

  const uniqueName = (hint: string): string => {
    let name = hint;
    let suffix = 1;
    while (builder!.usedNames.has(name)) {
      name = `${hint}${suffix}`;
      suffix += 1;
    }
    builder!.usedNames.add(name);
    return name;
  };

  /** Rule 3: hint names plus numeric temps; unique per function, never renumbered. */
  const tempName = (hint?: string): string => {
    if (hint !== undefined) return uniqueName(`%${hint}`);
    const name = `%${builder!.tempCounter}`;
    builder!.tempCounter += 1;
    return name;
  };

  const value = (name: string): IROperand => ({ kind: 'value', name });
  const constant = (v: number, type: IRType = I32): IROperand => ({
    kind: 'const',
    value: wrap32(v),
    type,
  });
  const label = (blockId: number): IROperand => ({ kind: 'label', blockId });

  const emitBr = (targetBlockId: number, astNodeId?: number): void => {
    emit({ opcode: 'br', type: VOID, operands: [label(targetBlockId)], astNodeId });
  };

  const emitCondBr = (
    cond: IROperand,
    trueBlockId: number,
    falseBlockId: number,
    astNodeId?: number,
  ): void => {
    emit({
      opcode: 'br',
      type: I1,
      operands: [cond, label(trueBlockId), label(falseBlockId)],
      astNodeId,
    });
  };

  const emitRet = (operand: IROperand | null, type: IRType, astNodeId?: number): void => {
    emit({ opcode: 'ret', type, operands: operand === null ? [] : [operand], astNodeId });
  };

  /** Rule 4: int -> i1 for branches via `icmp ne i32 %v, 0`; i1 passes through. */
  const toCondition = (operand: IROperand, type: IRType, astNodeId: number): IROperand => {
    if (type === I1) return operand;
    const instr = emit({
      opcode: 'icmp',
      type: I1,
      result: tempName(),
      predicate: 'ne',
      operands: [operand, constant(0)],
      astNodeId,
    });
    return value(instr.result!);
  };

  /** Rule 4: i1 -> i32 via `zext i1 %c to i32`; i32 passes through. */
  const widenToI32 = (operand: IROperand, type: IRType, astNodeId: number): IROperand => {
    if (type === I32) return operand;
    const instr = emit({
      opcode: 'zext',
      type: I32,
      result: tempName(),
      operands: [operand],
      toType: I32,
      astNodeId,
    });
    return value(instr.result!);
  };

  // ---- Expressions ---------------------------------------------------------

  /** The pointer (alloca result or `@global`) holding a variable. */
  const pointerForDecl = (declNodeId: number): IROperand => {
    const slot = builder!.slots.get(declNodeId);
    if (slot !== undefined) return slot;
    const globalName = globalDecls.get(declNodeId);
    if (globalName !== undefined) return { kind: 'global', name: globalName };
    return constant(0, PTR);
  };

  /** Lvalue pointer of an assignment target, unwrapping parentheses. */
  const slotOf = (lhs: AstNode): IROperand => {
    let target = lhs;
    while (target.kind === 'ParenExpr' && target.childIds.length === 1) {
      target = nodes[target.childIds[0]];
    }
    return pointerForDecl(target.refDeclId ?? -1);
  };

  const ARITH_OPS: Record<string, { opcode: 'add' | 'sub' | 'mul' | 'sdiv' | 'srem'; hint: string }> = {
    '+': { opcode: 'add', hint: 'add' },
    '-': { opcode: 'sub', hint: 'sub' },
    '*': { opcode: 'mul', hint: 'mul' },
    '/': { opcode: 'sdiv', hint: 'div' },
    '%': { opcode: 'srem', hint: 'rem' },
  };

  const COMPARISONS: Record<string, 'slt' | 'sgt' | 'sle' | 'sge' | 'eq' | 'ne'> = {
    '<': 'slt',
    '>': 'sgt',
    '<=': 'sle',
    '>=': 'sge',
    '==': 'eq',
    '!=': 'ne',
  };

  const applyArithmetic = (
    op: string,
    left: IROperand,
    right: IROperand,
    astNodeId: number,
  ): GenValue => {
    const entry = ARITH_OPS[op];
    const instr = emit({
      opcode: entry.opcode,
      type: I32,
      result: tempName(entry.hint),
      operands: [left, right],
      astNodeId,
    });
    return { operand: value(instr.result!), type: I32 };
  };

  const genExpr = (nodeId: number): GenValue => {
    const node = nodes[nodeId];
    switch (node.kind) {
      case 'IntegerLiteral':
        return { operand: constant(node.value ?? 0), type: I32 };

      case 'ParenExpr':
        return genExpr(node.childIds[0]);

      case 'DeclRefExpr': {
        const ptr = pointerForDecl(node.refDeclId ?? -1);
        const instr = emit({
          opcode: 'load',
          type: I32,
          result: tempName(),
          operands: [ptr],
          astNodeId: node.id,
        });
        return { operand: value(instr.result!), type: I32 };
      }

      case 'BinaryOperator': {
        const op = node.op ?? '+';
        if (op === '&&' || op === '||') return genLogical(node, op);
        if (op === '=') return genAssign(node);
        return genBinary(node, op);
      }

      case 'CompoundAssignOperator': {
        // Rule 7: load, op, store.
        const op = (node.op ?? '+=').slice(0, -1); // '+=' -> '+'
        const lhs = nodes[node.childIds[0]];
        const slot = slotOf(lhs);
        const loaded = emit({
          opcode: 'load',
          type: I32,
          result: tempName(),
          operands: [slot],
          astNodeId: lhs.id,
        });
        const rhs = genExpr(node.childIds[1]);
        const rhsOperand = widenToI32(rhs.operand, rhs.type, node.childIds[1]);
        const result = applyArithmetic(op, value(loaded.result!), rhsOperand, node.id);
        emit({ opcode: 'store', type: I32, operands: [result.operand, slot], astNodeId: node.id });
        return { operand: result.operand, type: I32 };
      }

      case 'UnaryOperator':
        return genUnary(node);

      case 'CallExpr': {
        const callee = nodes[node.childIds[0]];
        const args: IROperand[] = [];
        for (const argId of node.childIds.slice(1)) {
          const arg = genExpr(argId);
          args.push(widenToI32(arg.operand, arg.type, argId));
        }
        const retType: IRType = node.type?.kind === 'void' ? VOID : I32;
        const instr = emit({
          opcode: 'call',
          type: retType,
          ...(retType === VOID ? {} : { result: tempName('call') }),
          callee: callee.name ?? '',
          operands: args,
          astNodeId: node.id,
        });
        if (retType === VOID) return { operand: constant(0), type: VOID };
        return { operand: value(instr.result!), type: I32 };
      }

      default:
        return { operand: constant(0), type: I32 };
    }
  };

  const genBinary = (node: AstNode, op: string): GenValue => {
    const left = genExpr(node.childIds[0]);
    const right = genExpr(node.childIds[1]);
    const leftOperand = widenToI32(left.operand, left.type, node.childIds[0]);
    const rightOperand = widenToI32(right.operand, right.type, node.childIds[1]);

    const predicate = COMPARISONS[op];
    if (predicate !== undefined) {
      const instr = emit({
        opcode: 'icmp',
        type: I1,
        result: tempName('cmp'),
        predicate,
        operands: [leftOperand, rightOperand],
        astNodeId: node.id,
      });
      return { operand: value(instr.result!), type: I1 };
    }
    return applyArithmetic(op, leftOperand, rightOperand, node.id);
  };

  const genAssign = (node: AstNode): GenValue => {
    const rhs = genExpr(node.childIds[1]);
    const operand = widenToI32(rhs.operand, rhs.type, node.childIds[1]);
    const slot = slotOf(nodes[node.childIds[0]]);
    emit({ opcode: 'store', type: I32, operands: [operand, slot], astNodeId: node.id });
    return { operand, type: I32 };
  };

  /** Rule 5: `&&` / `||` without phi, via a hidden i32 temp and two blocks. */
  const genLogical = (node: AstNode, op: '&&' | '||'): GenValue => {
    const prefix = op === '&&' ? 'land' : 'lor';

    const tempSlot = emitAlloca({
      type: I32,
      result: tempName(`${prefix}.tmp`),
      operands: [],
      astNodeId: node.id,
    });
    const tempPtr = value(tempSlot.result!);

    const left = genExpr(node.childIds[0]);
    const leftCond = toCondition(left.operand, left.type, node.childIds[0]);

    // Default value on the short-circuit path, stored before branching.
    emit({
      opcode: 'store',
      type: I32,
      operands: [constant(op === '&&' ? 0 : 1), tempPtr],
      astNodeId: node.id,
    });
    const rhsBlockId = createBlock(`${prefix}.rhs`);
    const endBlockId = createBlock(`${prefix}.end`);
    if (op === '&&') emitCondBr(leftCond, rhsBlockId, endBlockId, node.id);
    else emitCondBr(leftCond, endBlockId, rhsBlockId, node.id);

    // rhs block: evaluate the right operand and store its truthiness (0/1).
    builder!.currentBlockId = rhsBlockId;
    const right = genExpr(node.childIds[1]);
    const rightCond = toCondition(right.operand, right.type, node.childIds[1]);
    const truthiness = emit({
      opcode: 'zext',
      type: I32,
      result: tempName(),
      operands: [rightCond],
      toType: I32,
      astNodeId: node.id,
    });
    emit({
      opcode: 'store',
      type: I32,
      operands: [value(truthiness.result!), tempPtr],
      astNodeId: node.id,
    });
    emitBr(endBlockId, node.id);

    // end block: load the shared result.
    builder!.currentBlockId = endBlockId;
    const result = emit({
      opcode: 'load',
      type: I32,
      result: tempName(),
      operands: [tempPtr],
      astNodeId: node.id,
    });
    return { operand: value(result.result!), type: I32 };
  };

  const genUnary = (node: AstNode): GenValue => {
    const op = node.op ?? 'prefix-';
    const operandId = node.childIds[0];

    if (op === 'prefix++' || op === 'prefix--' || op === 'postfix++' || op === 'postfix--') {
      // Rule 7: load, add/sub 1, store; value is new (prefix) or old (postfix).
      const target = nodes[operandId];
      const slot = slotOf(target);
      const loaded = emit({
        opcode: 'load',
        type: I32,
        result: tempName(),
        operands: [slot],
        astNodeId: operandId,
      });
      const delta = op.includes('++') ? 1 : -1;
      const arith = emit({
        opcode: delta > 0 ? 'add' : 'sub',
        type: I32,
        result: tempName(delta > 0 ? 'inc' : 'dec'),
        operands: [value(loaded.result!), constant(delta)],
        astNodeId: node.id,
      });
      emit({ opcode: 'store', type: I32, operands: [value(arith.result!), slot], astNodeId: node.id });
      const resultOperand = op.startsWith('prefix') ? value(arith.result!) : value(loaded.result!);
      return { operand: resultOperand, type: I32 };
    }

    const operand = genExpr(operandId);
    const operandOperand = widenToI32(operand.operand, operand.type, operandId);

    if (op === 'prefix-') {
      // Rule 4: unary minus -> `sub nsw i32 0, %x`.
      const instr = emit({
        opcode: 'sub',
        type: I32,
        result: tempName('neg'),
        operands: [constant(0), operandOperand],
        astNodeId: node.id,
      });
      return { operand: value(instr.result!), type: I32 };
    }

    // Rule 4: `!x` -> `icmp eq i32 %x, 0` (callers widen to i32 when needed).
    const cmp = emit({
      opcode: 'icmp',
      type: I1,
      result: tempName('lnot'),
      predicate: 'eq',
      operands: [operandOperand, constant(0)],
      astNodeId: node.id,
    });
    return { operand: value(cmp.result!), type: I1 };
  };

  // ---- Statements ----------------------------------------------------------

  const genStmt = (nodeId: number): void => {
    const node = nodes[nodeId];
    switch (node.kind) {
      case 'CompoundStmt':
        for (const childId of node.childIds) genStmt(childId);
        return;

      case 'VarDecl': {
        declareSlot(node, node.name ?? '');
        if (node.childIds.length > 0) {
          const init = genExpr(node.childIds[0]);
          const operand = widenToI32(init.operand, init.type, node.childIds[0]);
          emit({
            opcode: 'store',
            type: I32,
            operands: [operand, builder!.slots.get(node.id)!],
            astNodeId: node.id,
          });
        }
        return;
      }

      case 'ExprStmt':
        genExpr(node.childIds[0]);
        return;

      case 'NullStmt':
        return;

      case 'ReturnStmt': {
        if (node.childIds.length === 0) {
          emitRet(null, VOID, node.id);
          return;
        }
        const returned = genExpr(node.childIds[0]);
        const operand = widenToI32(returned.operand, returned.type, node.childIds[0]);
        emitRet(operand, I32, node.id);
        return;
      }

      case 'BreakStmt': {
        const loop = builder!.loopStack.at(-1);
        if (loop !== undefined) emitBr(loop.breakLabel, node.id);
        return;
      }

      case 'ContinueStmt': {
        const loop = builder!.loopStack.at(-1);
        if (loop !== undefined) emitBr(loop.continueLabel, node.id);
        return;
      }

      case 'IfStmt':
        genIf(node);
        return;

      case 'WhileStmt':
        genWhile(node);
        return;

      case 'ForStmt':
        genFor(node);
        return;

      default:
        return;
    }
  };

  const genIf = (node: AstNode): void => {
    const cond = genExpr(node.childIds[0]);
    const condOperand = toCondition(cond.operand, cond.type, node.childIds[0]);
    const hasElse = node.childIds.length === 3;
    const thenBlockId = createBlock('if.then');
    const elseBlockId = hasElse ? createBlock('if.else') : null;
    const endBlockId = createBlock('if.end');
    emitCondBr(condOperand, thenBlockId, elseBlockId ?? endBlockId, node.id);

    builder!.currentBlockId = thenBlockId;
    genStmt(node.childIds[1]);
    if (!blockTerminated(builder!.currentBlockId)) emitBr(endBlockId, node.id);

    if (elseBlockId !== null) {
      builder!.currentBlockId = elseBlockId;
      genStmt(node.childIds[2]);
      if (!blockTerminated(builder!.currentBlockId)) emitBr(endBlockId, node.id);
    }

    builder!.currentBlockId = endBlockId;
  };

  const genWhile = (node: AstNode): void => {
    const condBlockId = createBlock('while.cond');
    const bodyBlockId = createBlock('while.body');
    const endBlockId = createBlock('while.end');
    emitBr(condBlockId, node.id);

    builder!.currentBlockId = condBlockId;
    const cond = genExpr(node.childIds[0]);
    const condOperand = toCondition(cond.operand, cond.type, node.childIds[0]);
    emitCondBr(condOperand, bodyBlockId, endBlockId, node.id);

    builder!.loopStack.push({ breakLabel: endBlockId, continueLabel: condBlockId });
    builder!.currentBlockId = bodyBlockId;
    genStmt(node.childIds[1]);
    if (!blockTerminated(builder!.currentBlockId)) emitBr(condBlockId, node.id);
    builder!.loopStack.pop();

    builder!.currentBlockId = endBlockId;
  };

  const genFor = (node: AstNode): void => {
    const init = node.childIds.find((id) => nodes[id].forRole === 'init');
    const cond = node.childIds.find((id) => nodes[id].forRole === 'cond');
    const inc = node.childIds.find((id) => nodes[id].forRole === 'inc');
    const body = node.childIds.find((id) => nodes[id].forRole === 'body');

    if (init !== undefined) genStmt(init);

    const condBlockId = createBlock('for.cond');
    const bodyBlockId = createBlock('for.body');
    const incBlockId = createBlock('for.inc');
    const endBlockId = createBlock('for.end');
    emitBr(condBlockId, node.id);

    builder!.currentBlockId = condBlockId;
    if (cond !== undefined) {
      const condValue = genExpr(cond);
      const condOperand = toCondition(condValue.operand, condValue.type, cond);
      emitCondBr(condOperand, bodyBlockId, endBlockId, node.id);
    } else {
      emitBr(bodyBlockId, node.id);
    }

    builder!.loopStack.push({ breakLabel: endBlockId, continueLabel: incBlockId });
    builder!.currentBlockId = bodyBlockId;
    if (body !== undefined) genStmt(body);
    if (!blockTerminated(builder!.currentBlockId)) emitBr(incBlockId, node.id);

    // `continue` jumps to the increment; then fall back to the condition.
    builder!.currentBlockId = incBlockId;
    if (inc !== undefined) genExpr(inc);
    emitBr(condBlockId, node.id);
    builder!.loopStack.pop();

    builder!.currentBlockId = endBlockId;
  };

  const declareSlot = (node: AstNode, name: string): void => {
    const isParam = node.kind === 'ParamDecl';
    // Rule 2: param `x` -> `%x.addr`; local `x` -> `%x` (suffix when shadowed).
    const result = tempName(isParam ? `${name}.addr` : name);
    const alloca = emitAlloca({ type: I32, result, operands: [], varName: name, astNodeId: node.id });
    builder!.slots.set(node.id, value(alloca.result!));
  };

  // ---- Functions -----------------------------------------------------------

  const genFunction = (node: AstNode): void => {
    const bodyId = node.childIds.find((id) => nodes[id].kind === 'CompoundStmt');
    const paramNodes = node.childIds
      .filter((id) => nodes[id].kind === 'ParamDecl')
      .map((id) => nodes[id]);
    const retType: IRType = node.declRet === 'void' ? VOID : I32;

    const fn: IRFunction = {
      name: node.name ?? '',
      ret: retType,
      params: paramNodes.map((param) => ({ name: `%${param.name}`, type: I32 })),
      blockIds: [],
      isDeclaration: bodyId === undefined,
      astNodeId: node.id,
    };
    irModule.functions.push(fn);
    if (bodyId === undefined) return; // prototype becomes a `declare`

    builder = {
      fn,
      usedNames: new Set(paramNodes.map((param) => `%${param.name}`)),
      labelCounts: new Map(),
      tempCounter: 0,
      currentBlockId: -1,
      entryAllocaIds: [],
      slots: new Map(),
      loopStack: [],
    };

    const entryBlockId = createBlock('entry');
    builder.currentBlockId = entryBlockId;

    // Param allocas plus copies of the incoming SSA values (rule 2).
    for (const param of paramNodes) {
      declareSlot(param, param.name ?? '');
      emit({
        opcode: 'store',
        type: I32,
        operands: [value(`%${param.name}`), builder.slots.get(param.id)!],
        astNodeId: param.id,
      });
    }

    genStmt(bodyId);

    // Rule 1: close the open block honestly at function end.
    if (!blockTerminated(builder.currentBlockId)) {
      if (retType === VOID) emitRet(null, VOID);
      else if (node.name === 'main') emitRet(constant(0), I32); // no honest origin
      else emit({ opcode: 'unreachable', type: VOID, operands: [] });
    }

    // Rule 2: allocas first in `entry`.
    const entryBlock = irModule.blocks[entryBlockId];
    entryBlock.instrIds = [...builder.entryAllocaIds, ...entryBlock.instrIds];

    // Rule 1: prune blocks with no predecessors (except entry).
    const reachable = new Set<number>([entryBlockId]);
    const queue = [entryBlockId];
    while (queue.length > 0) {
      const blockId = queue.shift()!;
      for (const instrId of irModule.blocks[blockId].instrIds) {
        const instr = irModule.instrs[instrId];
        if (instr.opcode !== 'br') continue;
        for (const operand of instr.operands) {
          if (operand.kind === 'label' && !reachable.has(operand.blockId)) {
            reachable.add(operand.blockId);
            queue.push(operand.blockId);
          }
        }
      }
    }
    fn.blockIds = fn.blockIds.filter((blockId) => reachable.has(blockId));
    for (const blockId of Object.keys(irModule.blocks).map(Number)) {
      if (irModule.functions.some((other) => other.blockIds.includes(blockId))) continue;
      delete irModule.blocks[blockId];
    }

    builder = null;
  };

  // ---- Module --------------------------------------------------------------

  for (const childId of nodes[ast.rootId].childIds) {
    const node = nodes[childId];
    if (node.kind === 'FunctionDecl') genFunction(node);
  }

  return irModule;
}
