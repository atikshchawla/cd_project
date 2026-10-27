import { wrap32 } from './int32';
import { cellsOf, isAddress, pointeeOf } from './typeutil';
import type {
  Ast,
  AstNode,
  IRFunction,
  IRGlobal,
  IRInstr,
  IRModule,
  IROperand,
  IRType,
  Type,
} from './types';

const I32: IRType = 'i32';
const PTR: IRType = 'ptr';
const I1: IRType = 'i1';
const VOID: IRType = 'void';

/** Default value type for nodes semantic analysis left unannotated. */
const INT_TYPE: Type = { kind: 'int' };

/**
 * The five calls the language provides itself. They are *declared* in the
 * module (never defined) so the IR printer can show their signatures; the
 * interpreter implements them directly.
 */
const BUILTINS: Record<string, { ret: IRType; params: IRType[] }> = {
  malloc: { ret: PTR, params: [I32] },
  free: { ret: I32, params: [PTR] },
  delete: { ret: I32, params: [PTR] },
  print: { ret: I32, params: [I32] },
  printf: { ret: I32, params: [PTR, I32] },
};

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

  /** Built-ins the program calls, so the module can declare them (`@malloc`). */
  const builtinUses = new Set<string>();

  // ---- Global variables ----------------------------------------------------

  /**
   * Write an initialiser into a flat cell array, honouring record offsets.
   *
   * Only integer literals reach this point: semantic analysis rejects every
   * other global initialiser, because a global's storage exists before the
   * program runs.
   */
  const fillCells = (cells: number[], base: number, type: Type, initNode: AstNode): void => {
    if (type.kind === 'array' && initNode.kind === 'InitListExpr') {
      const stride = cellsOf(type.element);
      initNode.childIds.forEach((childId, index) => {
        if (index >= type.size) return;
        fillCells(cells, base + index * stride, type.element, nodes[childId]);
      });
      return;
    }
    if (type.kind === 'record' && initNode.kind === 'InitListExpr') {
      initNode.childIds.forEach((childId, index) => {
        const field = type.fields[index];
        if (field !== undefined) fillCells(cells, base + field.offset, field.type, nodes[childId]);
      });
      return;
    }
    if (initNode.kind === 'IntegerLiteral') cells[base] = wrap32(initNode.value ?? 0);
  };

  /** Top-level variables become `@name` globals (rule 8). */
  const globalDecls = new Map<number, string>(); // decl node id -> global name
  for (const node of Object.values(nodes)) {
    if (node.kind !== 'VarDecl') continue;
    if (nodes[node.parentId ?? -1]?.kind !== 'TranslationUnit') continue;
    const declared = node.type;
    const cells = declared === undefined ? 1 : cellsOf(declared);
    const inits = new Array<number>(cells).fill(0);
    if (node.childIds.length > 0 && declared !== undefined) {
      fillCells(inits, 0, declared, nodes[node.childIds[0]]);
    }
    const hasValues = inits.some((value) => value !== 0);
    const global: IRGlobal = {
      name: node.name ?? '',
      init: inits[0] ?? 0,
      astNodeId: node.id,
      ...(cells > 1 ? { cells } : {}),
      ...(cells > 1 && hasValues ? { inits } : {}),
    };
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
    if (full.opcode === 'call' && full.callee !== undefined && BUILTINS[full.callee] !== undefined) {
      builtinUses.add(full.callee);
    }
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

  /** Rule 4: i1 -> i32 via `zext i1 %c to i32`; i32 and pointers pass through. */
  const widenToI32 = (operand: IROperand, type: IRType, astNodeId: number): IROperand => {
    if (type === I32 || type === PTR) return operand;
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

  /** Make an expression's value usable as a stored/call argument value. */
  const asValue = (val: GenValue, astNodeId: number): IROperand =>
    widenToI32(val.operand, val.type, astNodeId);

  // ---- Expressions ---------------------------------------------------------

  /** The pointer (alloca result or `@global`) holding a variable. */
  const pointerForDecl = (declNodeId: number): IROperand => {
    const slot = builder!.slots.get(declNodeId);
    if (slot !== undefined) return slot;
    const globalName = globalDecls.get(declNodeId);
    if (globalName !== undefined) return { kind: 'global', name: globalName };
    return constant(0, PTR);
  };

  /**
   * The address of an lvalue, as a `ptr` value.
   *
   * Variables are their own slot (an alloca already holds the address), `*p`
   * yields the pointer value itself, and `a[i]` / `p.f` are computed with
   * `ptradd`. Semantic analysis has already rejected anything else.
   */
  const addressOf = (node: AstNode): GenValue => {
    switch (node.kind) {
      case 'ParenExpr':
        return node.childIds.length === 1 ? addressOf(nodes[node.childIds[0]]) : nullAddr();
      case 'DeclRefExpr':
        return { operand: pointerForDecl(node.refDeclId ?? -1), type: PTR };
      case 'UnaryOperator': {
        if (node.op !== 'prefix*') return nullAddr();
        const inner = genExpr(node.childIds[0]);
        return { operand: inner.operand, type: PTR };
      }
      case 'ArraySubscriptExpr':
        return genSubscript(node);
      case 'MemberExpr':
        return genMember(node);
      default:
        return nullAddr();
    }
  };

  /** Address returned for an lvalue shape the front end already rejected. */
  const nullAddr = (): GenValue => ({ operand: constant(0, PTR), type: PTR });

  /** Lvalue pointer of an assignment target, unwrapping parentheses. */
  const slotOf = (lhs: AstNode): IROperand => addressOf(lhs).operand;

  /**
   * Index scaled to cells: `i * stride`. Constant indices fold here so that
   * `a[2]` is a single `ptradd %a, 2` — matching how a real GEP folds.
   */
  const scaledIndex = (index: GenValue, stride: number, astNodeId: number): IROperand => {
    const operand = asValue(index, astNodeId);
    if (index.operand.kind === 'const') return constant(index.operand.value * stride);
    if (stride === 1) return operand;
    const instr = emit({
      opcode: 'mul',
      type: I32,
      result: tempName('idx'),
      operands: [operand, constant(stride)],
      astNodeId,
    });
    return value(instr.result!);
  };

  /** `-operand`: folds constants, otherwise `sub i32 0, %x`. */
  const negate = (operand: IROperand, astNodeId: number): IROperand => {
    if (operand.kind === 'const') return constant(-operand.value);
    const instr = emit({
      opcode: 'sub',
      type: I32,
      result: tempName('neg'),
      operands: [constant(0), operand],
      astNodeId,
    });
    return value(instr.result!);
  };

  /** `base + cells` as a new pointer value (cells are element counts). */
  const ptradd = (base: IROperand, cells: number | IROperand, astNodeId: number): GenValue => {
    const offset = typeof cells === 'number' ? constant(cells) : cells;
    const instr = emit({
      opcode: 'ptradd',
      type: PTR,
      result: tempName('addr'),
      operands: [base, offset],
      astNodeId,
    });
    return { operand: value(instr.result!), type: PTR };
  };

  /** Address of `base[index]` where the element may itself be several cells. */
  const genSubscript = (node: AstNode): GenValue => {
    const base = genExpr(node.childIds[0]); // array decays to its own address
    const index = genExpr(node.childIds[1]);
    const stride = cellsOf(node.type ?? INT_TYPE);
    return ptradd(base.operand, scaledIndex(index, stride, node.id), node.id);
  };

  /** Address of `base.f` / `base->f`, always spelled out as a `ptradd`. */
  const genMember = (node: AstNode): GenValue => {
    const baseNode = nodes[node.childIds[0]];
    const base = genExpr(node.childIds[0]);
    const baseType = baseNode.type;
    const record =
      node.op === '->'
        ? baseType !== undefined && baseType.kind === 'pointer' && baseType.pointee.kind === 'record'
          ? baseType.pointee
          : null
        : baseType !== undefined && baseType.kind === 'record'
          ? baseType
          : null;
    const offset = record?.fields.find((field) => field.name === node.name)?.offset ?? 0;
    // Always emit the addressing step — even at offset 0 it documents that
    // every field access is an address computation.
    return ptradd(base.operand, constant(offset), node.id);
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
        const declared = node.type;
        // Arrays and records decay: their value *is* their address, so no load.
        if (declared !== undefined && (declared.kind === 'array' || declared.kind === 'record')) {
          return { operand: ptr, type: PTR };
        }
        const irType: IRType = declared?.kind === 'pointer' ? PTR : I32;
        const instr = emit({
          opcode: 'load',
          type: irType,
          result: tempName(),
          operands: [ptr],
          astNodeId: node.id,
        });
        return { operand: value(instr.result!), type: irType };
      }

      case 'ArraySubscriptExpr': {
        const addr = genSubscript(node);
        const elementType = node.type ?? INT_TYPE;
        if (elementType.kind === 'array' || elementType.kind === 'record') return addr;
        const irType: IRType = elementType.kind === 'pointer' ? PTR : I32;
        const instr = emit({
          opcode: 'load',
          type: irType,
          result: tempName(),
          operands: [addr.operand],
          astNodeId: node.id,
        });
        return { operand: value(instr.result!), type: irType };
      }

      case 'MemberExpr': {
        const addr = genMember(node);
        const fieldType = node.type ?? INT_TYPE;
        if (fieldType.kind === 'array' || fieldType.kind === 'record') return addr;
        const irType: IRType = fieldType.kind === 'pointer' ? PTR : I32;
        const instr = emit({
          opcode: 'load',
          type: irType,
          result: tempName(),
          operands: [addr.operand],
          astNodeId: node.id,
        });
        return { operand: value(instr.result!), type: irType };
      }

      case 'SizeOfExpr':
        // Semantic analysis folds `sizeof` into a compile-time cell count.
        return { operand: constant(node.value ?? 0), type: I32 };

      case 'NewExpr':
        return genNew(node);

      case 'StringLiteral':
        // Only reachable as printf's first argument, handled there.
        return { operand: { kind: 'string', value: node.stringValue ?? '' }, type: PTR };

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
        if (lhs.type?.kind === 'pointer') {
          // `p += n` / `p -= n` move an address by whole elements.
          const loaded = emit({
            opcode: 'load',
            type: PTR,
            result: tempName(),
            operands: [slot],
            astNodeId: lhs.id,
          });
          const rhs = genExpr(node.childIds[1]);
          const stride = cellsOf(pointeeOf(lhs.type) ?? INT_TYPE);
          const delta = scaledIndex(rhs, stride, node.childIds[1]);
          const result = ptradd(
            value(loaded.result!),
            op === '-' ? negate(delta, node.id) : delta,
            node.id,
          );
          emit({
            opcode: 'store',
            type: PTR,
            operands: [result.operand, slot],
            astNodeId: node.id,
          });
          return result;
        }
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
        const retKind = node.type?.kind;
        const retType: IRType = retKind === 'void' ? VOID : retKind === 'pointer' ? PTR : I32;
        const instr = emit({
          opcode: 'call',
          type: retType,
          ...(retType === VOID ? {} : { result: tempName('call') }),
          callee: callee.name ?? '',
          operands: args,
          astNodeId: node.id,
        });
        if (retType === VOID) return { operand: constant(0), type: VOID };
        return { operand: value(instr.result!), type: retType };
      }

      default:
        return { operand: constant(0), type: I32 };
    }
  };

  /**
   * `new T` / `new T[n]` → `call ptr @malloc(cells)`, with `n` scaled to the
   * element's cell count so the heap block is exactly as large as the object.
   */
  const genNew = (node: AstNode): GenValue => {
    const declared = node.type;
    const allocated = declared === undefined ? INT_TYPE : pointeeOf(declared) ?? INT_TYPE;
    const stride = cellsOf(allocated);
    let bytes: IROperand;
    if (node.op === 'new[]' && node.childIds.length > 0) {
      const count = genExpr(node.childIds[0]);
      bytes = scaledIndex(count, stride, node.childIds[0]);
    } else {
      bytes = constant(stride);
    }
    const instr = emit({
      opcode: 'call',
      type: PTR,
      result: tempName('call'),
      callee: 'malloc',
      operands: [bytes],
      astNodeId: node.id,
    });
    return { operand: value(instr.result!), type: PTR };
  };

  const genBinary = (node: AstNode, op: string): GenValue => {
    const leftId = node.childIds[0];
    const rightId = node.childIds[1];
    const leftType = nodes[leftId]?.type;
    const rightType = nodes[rightId]?.type;
    const left = genExpr(leftId);
    const right = genExpr(rightId);

    // Pointer arithmetic moves by whole elements, not by single cells:
    // `p + i` / `i + p` / `p - i` add cells, `p - q` measures cells between
    // two addresses. Semantic analysis has already checked the operand types.
    if (op === '+' || op === '-') {
      if (leftType !== undefined && isAddress(leftType)) {
        if (op === '-' && rightType !== undefined && isAddress(rightType)) {
          const instr = emit({
            opcode: 'ptrdiff',
            type: I32,
            result: tempName('pdiff'),
            operands: [left.operand, right.operand],
            astNodeId: node.id,
          });
          return { operand: value(instr.result!), type: I32 };
        }
        const stride = cellsOf(pointeeOf(leftType) ?? INT_TYPE);
        const delta = scaledIndex(right, stride, rightId);
        return ptradd(left.operand, op === '-' ? negate(delta, node.id) : delta, node.id);
      }
      if (op === '+' && rightType !== undefined && isAddress(rightType)) {
        const stride = cellsOf(pointeeOf(rightType) ?? INT_TYPE);
        return ptradd(right.operand, scaledIndex(left, stride, leftId), node.id);
      }
    }

    const leftOperand = asValue(left, leftId);
    const rightOperand = asValue(right, rightId);

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
    const operand = asValue(rhs, node.childIds[1]);
    const addr = addressOf(nodes[node.childIds[0]]);
    emit({
      opcode: 'store',
      type: rhs.type === VOID ? I32 : rhs.type,
      operands: [operand, addr.operand],
      astNodeId: node.id,
    });
    return { operand, type: rhs.type };
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

    if (op === 'prefix&') {
      // Taking an address emits nothing: an alloca already *is* one.
      return addressOf(nodes[operandId]);
    }

    if (op === 'prefix+') {
      // `+x` is the identity for the int operand semantic analysis checked.
      return genExpr(operandId);
    }

    const operand = genExpr(operandId);

    if (op === 'prefix*') {
      const pointee = node.type;
      if (pointee !== undefined && (pointee.kind === 'array' || pointee.kind === 'record')) {
        // Derefencing to an aggregate yields its address, not a copy.
        return { operand: operand.operand, type: PTR };
      }
      const irType: IRType = pointee?.kind === 'pointer' ? PTR : I32;
      const loaded = emit({
        opcode: 'load',
        type: irType,
        result: tempName(),
        operands: [operand.operand],
        astNodeId: node.id,
      });
      return { operand: value(loaded.result!), type: irType };
    }

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

  /**
   * Fill a `{ ... }` initialiser into `base + offset`, one `store` per literal.
   *
   * Struct fields keep their declared offsets, union fields all land at 0, and
   * a short list leaves the remaining cells zero — exactly what semantic
   * analysis already validated.
   */
  const genInitList = (base: IROperand, type: Type, offset: number, list: AstNode): void => {
    if (type.kind === 'array') {
      const stride = cellsOf(type.element);
      list.childIds.forEach((childId, index) => {
        if (index >= type.size) return;
        writeInitializer(base, offset + index * stride, type.element, childId);
      });
      return;
    }
    if (type.kind === 'record') {
      list.childIds.forEach((childId, index) => {
        const field = type.fields[index];
        if (field !== undefined) writeInitializer(base, offset + field.offset, field.type, childId);
      });
    }
  };

  /** A single initialiser element: a nested list recurses, a literal stores. */
  const writeInitializer = (
    base: IROperand,
    offset: number,
    type: Type,
    childId: number,
  ): void => {
    const child = nodes[childId];
    if (child.kind === 'InitListExpr') {
      genInitList(base, type, offset, child);
      return;
    }
    if (type.kind === 'array' || type.kind === 'record') return; // sema reported it
    const init = genExpr(childId);
    const operand = asValue(init, childId);
    const addr = offset === 0 ? base : ptradd(base, offset, childId).operand;
    emit({
      opcode: 'store',
      type: init.type === VOID ? I32 : init.type,
      operands: [operand, addr],
      astNodeId: childId,
    });
  };

  /** `print(x)` / `printf("fmt", ...)` lower to a call of the same name. */
  const genPrint = (node: AstNode): void => {
    const isPrintf = node.op === 'printf';
    const args: IROperand[] = [];
    let index = 0;
    if (isPrintf && node.childIds.length > 0) {
      const format = nodes[node.childIds[0]];
      args.push({ kind: 'string', value: format.stringValue ?? '' });
      index = 1;
    }
    for (const argId of node.childIds.slice(index)) {
      args.push(asValue(genExpr(argId), argId));
    }
    emit({
      opcode: 'call',
      type: I32,
      result: tempName('call'),
      callee: isPrintf ? 'printf' : 'print',
      operands: args,
      astNodeId: node.id,
    });
  };


  const genStmt = (nodeId: number): void => {
    const node = nodes[nodeId];
    switch (node.kind) {
      case 'CompoundStmt':
        for (const childId of node.childIds) genStmt(childId);
        return;

      case 'VarDecl': {
        const slot = declareSlot(node, node.name ?? '');
        if (node.childIds.length > 0) {
          const declared = node.type;
          const initNode = nodes[node.childIds[0]];
          if (declared !== undefined && (declared.kind === 'array' || declared.kind === 'record')) {
            // Aggregate initialisers become one `store` per literal cell.
            if (initNode.kind === 'InitListExpr') genInitList(slot, declared, 0, initNode);
            return;
          }
          const init = genExpr(node.childIds[0]);
          const operand = asValue(init, node.childIds[0]);
          emit({
            opcode: 'store',
            type: init.type === VOID ? I32 : init.type,
            operands: [operand, slot],
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

      case 'PrintStmt':
        genPrint(node);
        return;

      case 'DeleteStmt': {
        const target = genExpr(node.childIds[0]);
        emit({
          opcode: 'call',
          type: I32,
          result: tempName('call'),
          callee: 'delete',
          operands: [target.operand],
          astNodeId: node.id,
        });
        return;
      }

      case 'ReturnStmt': {
        if (node.childIds.length === 0) {
          emitRet(null, VOID, node.id);
          return;
        }
        const returned = genExpr(node.childIds[0]);
        const operand = asValue(returned, node.childIds[0]);
        emitRet(operand, returned.type === VOID ? I32 : returned.type, node.id);
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

  /**
   * Reserve storage for a local or a parameter and remember where it lives.
   *
   * `int x` is `alloca i32` and `int *p` is `alloca ptr`; arrays and records
   * additionally carry `cells` (what the simulator reserves) and a `shape`
   * such as `[5 x i32]` (what the printer shows).
   */
  const declareSlot = (node: AstNode, name: string): IROperand => {
    const isParam = node.kind === 'ParamDecl';
    const declared = node.type;
    const aggregate =
      declared !== undefined && (declared.kind === 'array' || declared.kind === 'record');
    const cells = declared === undefined ? 1 : cellsOf(declared);
    const irType: IRType = declared?.kind === 'pointer' ? PTR : I32;
    // Rule 2: param `x` -> `%x.addr`; local `x` -> `%x` (suffix when shadowed).
    const result = tempName(isParam ? `${name}.addr` : name);
    const alloca = emitAlloca({
      type: irType,
      result,
      operands: [],
      varName: name,
      astNodeId: node.id,
      ...(aggregate ? { cells, shape: `[${cells} x i32]` } : {}),
    });
    builder!.slots.set(node.id, value(alloca.result!));
    return value(alloca.result!);
  };

  // ---- Functions -----------------------------------------------------------

  const genFunction = (node: AstNode): void => {
    const bodyId = node.childIds.find((id) => nodes[id].kind === 'CompoundStmt');
    const paramNodes = node.childIds
      .filter((id) => nodes[id].kind === 'ParamDecl')
      .map((id) => nodes[id]);
    const declaredRet =
      node.type?.kind === 'function'
        ? node.type.ret
        : node.declRet === 'void'
          ? ({ kind: 'void' } as const)
          : INT_TYPE;
    const retType: IRType =
      declaredRet.kind === 'void'
        ? VOID
        : declaredRet.kind === 'pointer'
          ? PTR
          : I32;
    const irParamType = (param: AstNode): IRType => (param.type?.kind === 'pointer' ? PTR : I32);

    const fn: IRFunction = {
      name: node.name ?? '',
      ret: retType,
      params: paramNodes.map((param) => ({ name: `%${param.name}`, type: irParamType(param) })),
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
        type: irParamType(param),
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

  // Built-ins are declared, never defined: `declare i32 @print(i32 %arg0)`.
  for (const name of builtinUses) {
    const spec = BUILTINS[name];
    if (spec === undefined) continue;
    irModule.functions.push({
      name,
      ret: spec.ret,
      params: spec.params.map((type, index) => ({ name: `%arg${index}`, type })),
      blockIds: [],
      isDeclaration: true,
    });
  }

  return irModule;
}
