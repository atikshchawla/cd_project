import type { Ast, AstNode, Diagnostic, RecordField, Scope, Symbol, Type, TypeRef } from './types';
import {
  cellsOf,
  decay,
  isAddress,
  pointerCompatible,
  pointeeOf,
  typeToString,
} from './typeutil';

export interface SemaResult {
  symbols: Symbol[];
  scopes: Scope[];
  diagnostics: Diagnostic[];
}

const INT: Type = { kind: 'int' };
const VOID: Type = { kind: 'void' };
const STRING: Type = { kind: 'string' };

function pointerTo(pointee: Type): Type {
  return { kind: 'pointer', pointee };
}

/**
 * Is this node something you can store into?
 *
 * Declarations, subscripts, member access and dereferences are all lvalues;
 * parens pass lvalue-ness through to whatever they contain.
 */
function isLvalue(node: AstNode, nodes: Record<number, AstNode>): boolean {
  switch (node.kind) {
    case 'DeclRefExpr':
    case 'ArraySubscriptExpr':
    case 'MemberExpr':
      return true;
    case 'UnaryOperator':
      return node.op === 'prefix*';
    case 'ParenExpr': {
      const innerId = node.childIds[0];
      return innerId !== undefined && isLvalue(nodes[innerId], nodes);
    }
    default:
      return false;
  }
}

/** Does this statement definitely end with a return on every path? */
export function definitelyReturns(node: AstNode, nodes: Record<number, AstNode>): boolean {
  if (node.kind === 'ReturnStmt') return true;
  if (node.kind === 'CompoundStmt') {
    const lastId = node.childIds.at(-1);
    return lastId !== undefined && definitelyReturns(nodes[lastId], nodes);
  }
  if (node.kind === 'IfStmt' && node.childIds.length === 3) {
    return (
      definitelyReturns(nodes[node.childIds[1]], nodes) &&
      definitelyReturns(nodes[node.childIds[2]], nodes)
    );
  }
  return false;
}

/**
 * Semantic analysis (§6.3): a scope-stack walk that annotates the AST with
 * types and declaration links, builds the symbol/scope tables, lays out every
 * `struct` / `union`, and collects *all* semantic diagnostics (it does not stop
 * at the first error).
 */
export function analyse(ast: Ast): SemaResult {
  const nodes = ast.nodes;
  const symbols: Symbol[] = [];
  const scopes: Scope[] = [];
  const diagnostics: Diagnostic[] = [];
  const scopeStack: number[] = [];
  let loopDepth = 0;
  let currentFunction: { name: string; ret: Type; unsupportedReturn: boolean } | null = null;

  // ---- Record types --------------------------------------------------------
  /** tag → the type object shared by every use of that tag. */
  const recordTypes = new Map<string, Type>();
  /** tags whose fields and size have been computed. */
  const completeRecords = new Set<string>();
  /** tag → duplicate-declaration note target. */
  const recordDeclNodes = new Map<string, AstNode>();

  const pushScope = (kind: Scope['kind'], ownerNodeId: number): void => {
    const id = scopes.length;
    scopes.push({
      id,
      parentId: scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null,
      kind,
      ownerNodeId,
      symbolIds: [],
    });
    scopeStack.push(id);
  };

  const popScope = (): void => {
    scopeStack.pop();
  };

  const currentScope = (): Scope => scopes[scopeStack[scopeStack.length - 1]];

  const lookup = (name: string): Symbol | null => {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      const scope = scopes[scopeStack[index]];
      for (const symbolId of scope.symbolIds) {
        if (symbols[symbolId].name === name) return symbols[symbolId];
      }
    }
    return null;
  };

  const diagnostic = (
    code: string,
    severity: 'error' | 'warning',
    message: string,
    range: AstNode['range'],
    notes?: Diagnostic['notes'],
  ): void => {
    diagnostics.push({
      id: diagnostics.length + 1,
      severity,
      code,
      stage: 'sema',
      message,
      range,
      ...(notes ? { notes } : {}),
    });
  };

  const declare = (
    name: string,
    type: Type,
    kind: Symbol['kind'],
    declNodeId: number,
  ): Symbol => {
    const scope = currentScope();
    for (const symbolId of scope.symbolIds) {
      const existing = symbols[symbolId];
      if (existing.name === name) {
        const previousNode = nodes[existing.declNodeId];
        diagnostic('E3002', 'error', `redeclaration of '${name}'`, nodes[declNodeId].range, [
          { message: 'previous declaration is here', range: previousNode.range },
        ]);
        return existing; // keep resolving to the first declaration
      }
    }
    const symbol: Symbol = {
      id: symbols.length,
      name,
      type,
      kind,
      scopeId: scope.id,
      declNodeId,
      useNodeIds: [],
    };
    symbols.push(symbol);
    scope.symbolIds.push(symbol.id);
    return symbol;
  };

  // ---- Type references -----------------------------------------------------

  /**
   * Resolve a written type (`int **`, `struct Point [3]`) into a `Type`.
   *
   * Records are looked up in `recordTypes`, which is pre-populated with every
   * tag in the file, so a pointer may refer forward to a record that is
   * defined later.
   */
  const typeFromRef = (ref: TypeRef | undefined, range: AstNode['range'], context: string): Type => {
    if (ref === undefined) return INT; // defensive: parser always records one
    let base: Type;
    if (ref.base === 'struct' || ref.base === 'union') {
      const tag = ref.tag ?? '';
      const record = recordTypes.get(tag);
      if (record === undefined) {
        diagnostic('E3001', 'error', `use of undeclared type '${ref.base} ${tag}' (${context})`, range);
        base = INT;
      } else {
        base = record;
      }
    } else {
      base = ref.base === 'void' ? VOID : INT;
    }
    let type = base;
    for (let index = 0; index < ref.stars; index += 1) type = pointerTo(type);
    // Dims are written outermost first; `int a[2][3]` is an array of 2 int[3].
    for (let index = ref.dims.length - 1; index >= 0; index -= 1) {
      type = { kind: 'array', element: type, size: ref.dims[index] };
    }
    return type;
  };

  /** `void` values and records used by value must be fully laid out first. */
  const requireComplete = (
    type: Type,
    range: AstNode['range'],
    context: string,
  ): void => {
    if (type.kind === 'void') {
      diagnostic('E3003', 'error', `'void' is not a complete object type (${context})`, range);
      return;
    }
    if (type.kind === 'array') {
      requireComplete(type.element, range, context);
      return;
    }
    if (type.kind === 'record' && !completeRecords.has(type.name)) {
      diagnostic(
        'E1010',
        'error',
        `record type '${typeToString(type)}' is not defined before it is used by value (${context})`,
        range,
        [
          {
            message:
              'A record is stored cell by cell, so its layout must be known here. Move its definition above this use, or use a pointer.',
          },
        ],
      );
    }
  };

  const requireInt = (type: Type, range: AstNode['range'], context: string): void => {
    if (type.kind !== 'int') {
      diagnostic(
        'E3003',
        'error',
        `invalid '${typeToString(type)}' value used as an int (${context})`,
        range,
      );
    }
  };

  /** A condition may be an int or a pointer (`if (p)` tests for null). */
  const requireCondition = (type: Type, range: AstNode['range'], context: string): void => {
    if (type.kind !== 'int' && type.kind !== 'pointer') {
      diagnostic(
        'E3003',
        'error',
        `invalid '${typeToString(type)}' value used as a condition (${context})`,
        range,
      );
    }
  };

  /**
   * May a `valueType` expression be stored where `targetType` is expected?
   * `valueNode` is consulted only for the null-pointer literal.
   */
  const assignable = (valueType: Type, valueNode: AstNode, targetType: Type): boolean => {
    if (targetType.kind === 'pointer') {
      if (valueType.kind === 'int') {
        return valueNode.kind === 'IntegerLiteral' && valueNode.value === 0;
      }
      if (valueType.kind === 'pointer' || valueType.kind === 'array') {
        return pointerCompatible(valueType, targetType);
      }
      return false;
    }
    if (targetType.kind === 'int') return valueType.kind === 'int';
    if (targetType.kind === 'string') return valueType.kind === 'string';
    return false; // arrays and records are never assigned as whole values
  };

  const requireAssignable = (
    valueType: Type,
    valueNode: AstNode,
    targetType: Type,
    range: AstNode['range'],
    context: string,
  ): void => {
    if (assignable(valueType, valueNode, targetType)) return;
    if (targetType.kind === 'int') {
      requireInt(valueType, range, context);
      return;
    }
    // Arrays and records span several cells and are never copied as one value.
    // Say that plainly instead of reporting a type as mismatched with itself.
    if (targetType.kind === 'record' || targetType.kind === 'array') {
      diagnostic(
        'E3003',
        'error',
        `cannot assign a whole '${typeToString(targetType)}' — write its fields or elements one at a time (${context})`,
        range,
        [
          {
            message:
              'Only single cells are copied, so an aggregate is assigned field by field (or element by element), never as one value.',
          },
        ],
      );
      return;
    }
    if (valueType.kind === 'record' || valueType.kind === 'array') {
      diagnostic(
        'E3003',
        'error',
        `cannot assign a '${typeToString(valueType)}' value where '${typeToString(targetType)}' is expected (${context})`,
        range,
      );
      return;
    }
    diagnostic(
      'E3003',
      'error',
      `invalid '${typeToString(valueType)}' value where '${typeToString(targetType)}' is required (${context})`,
      range,
    );
  };

  // ---- Expressions ---------------------------------------------------------

  /**
   * Type of a binary/compound operator, reporting misuse.
   *
   * `+` and `-` extend to pointer arithmetic and pointer difference (the two
   * pointer operations this dialect models); everything else needs ints.
   */
  const binaryType = (
    op: string,
    lhsType: Type,
    rhsType: Type,
    lhs: AstNode,
    rhs: AstNode,
  ): Type => {
    const lhsAddress = isAddress(lhsType);
    const rhsAddress = isAddress(rhsType);

    if (op === '+') {
      if (lhsType.kind === 'int' && rhsType.kind === 'int') return INT;
      if (lhsAddress && rhsType.kind === 'int') return pointerTo(pointeeOf(lhsType)!);
      if (lhsType.kind === 'int' && rhsAddress) return pointerTo(pointeeOf(rhsType)!);
      requireInt(lhsType, lhs.range, `left operand of '${op}'`);
      requireInt(rhsType, rhs.range, `right operand of '${op}'`);
      return INT;
    }

    if (op === '-') {
      if (lhsType.kind === 'int' && rhsType.kind === 'int') return INT;
      if (lhsAddress && rhsType.kind === 'int') return pointerTo(pointeeOf(lhsType)!);
      if (lhsAddress && rhsAddress) return INT; // pointer difference
      requireInt(lhsType, lhs.range, `left operand of '${op}'`);
      requireInt(rhsType, rhs.range, `right operand of '${op}'`);
      return INT;
    }

    if (op === '==' || op === '!=') {
      if (lhsType.kind === 'int' && rhsType.kind === 'int') return INT;
      if (lhsAddress && rhsAddress) return INT;
      if (
        lhsAddress &&
        rhsType.kind === 'int' &&
        rhs.kind === 'IntegerLiteral' &&
        rhs.value === 0
      ) {
        return INT;
      }
      if (
        rhsAddress &&
        lhsType.kind === 'int' &&
        lhs.kind === 'IntegerLiteral' &&
        lhs.value === 0
      ) {
        return INT;
      }
      requireInt(lhsType, lhs.range, `left operand of '${op}'`);
      requireInt(rhsType, rhs.range, `right operand of '${op}'`);
      return INT;
    }

    requireInt(lhsType, lhs.range, `left operand of '${op}'`);
    requireInt(rhsType, rhs.range, `right operand of '${op}'`);
    return INT;
  };

  /**
   * Walk an initialiser against the declared type: nested `{ ... }` lists are
   * matched against array elements and record fields, shorter lists zero-fill,
   * and anything else is a type error.
   */
  const checkInitializer = (
    targetType: Type,
    initNode: AstNode,
    context: string,
  ): void => {
    if (initNode.kind === 'InitListExpr') {
      const children = initNode.childIds.map((id) => nodes[id]);
      if (targetType.kind === 'array') {
        if (children.length > targetType.size) {
          diagnostic(
            'E3003',
            'error',
            `too many values in initialiser for '${typeToString(targetType)}', expected at most ${targetType.size}, have ${children.length}`,
            initNode.range,
          );
        }
        children.forEach((child) => checkInitializer(targetType.element, child, context));
        return;
      }
      if (targetType.kind === 'record') {
        if (children.length > targetType.fields.length) {
          diagnostic(
            'E3003',
            'error',
            `too many values in initialiser for '${typeToString(targetType)}', expected at most ${targetType.fields.length}, have ${children.length}`,
            initNode.range,
          );
        }
        children.forEach((child, index) => {
          const field: RecordField | undefined = targetType.fields[index];
          if (field !== undefined) checkInitializer(field.type, child, context);
          else exprType(child);
        });
        return;
      }
      diagnostic(
        'E3003',
        'error',
        `initialiser list used for '${typeToString(targetType)}', which is not an array or record (${context})`,
        initNode.range,
      );
      children.forEach((child) => exprType(child));
      return;
    }

    if (targetType.kind === 'array' || targetType.kind === 'record') {
      const valueType = exprType(initNode);
      diagnostic(
        'E3003',
        'error',
        `'${typeToString(targetType)}' must be initialised with a { ... } list, not a '${typeToString(valueType)}' value (${context})`,
        initNode.range,
      );
      return;
    }

    const valueType = exprType(initNode);
    requireAssignable(valueType, initNode, targetType, initNode.range, context);
  };

  const exprType = (node: AstNode): Type => {
    switch (node.kind) {
      case 'IntegerLiteral': {
        node.type = INT;
        return INT;
      }

      case 'StringLiteral': {
        node.type = STRING;
        return STRING;
      }

      case 'DeclRefExpr': {
        const symbol = lookup(node.name ?? '');
        if (symbol === null) {
          diagnostic('E3001', 'error', `use of undeclared identifier '${node.name}'`, node.range);
          node.type = INT; // recovery: assume int so later checks stay quiet
          return INT;
        }
        symbol.useNodeIds.push(node.id);
        node.refDeclId = symbol.declNodeId;
        if (symbol.type.kind === 'function') {
          diagnostic(
            'E3003',
            'error',
            `'${node.name}' is a function; Mini-C only allows calling it, not using it as a value`,
            node.range,
          );
          node.type = INT;
          return INT;
        }
        node.type = symbol.type;
        return symbol.type;
      }

      case 'ParenExpr': {
        const inner = nodes[node.childIds[0]];
        const type = exprType(inner);
        node.type = type;
        return type;
      }

      case 'ArraySubscriptExpr': {
        const base = nodes[node.childIds[0]];
        const index = nodes[node.childIds[1]];
        const baseType = exprType(base);
        const indexType = exprType(index);
        requireInt(indexType, index.range, 'array subscript');
        const element = pointeeOf(baseType);
        if (element === null) {
          diagnostic(
            'E3003',
            'error',
            `cannot index a value of type '${typeToString(baseType)}'`,
            base.range,
          );
          node.type = INT;
          return INT;
        }
        if (element.kind === 'void') {
          diagnostic('E3003', 'error', `cannot index 'void *'`, base.range);
          node.type = INT;
          return INT;
        }
        node.type = element;
        return element;
      }

      case 'MemberExpr': {
        const base = nodes[node.childIds[0]];
        const arrow = node.op === '->';
        let baseType = exprType(base);
        if (arrow) {
          if (baseType.kind !== 'pointer') {
            diagnostic(
              'E3003',
              'error',
              `'->' needs a pointer to a record, but this is a '${typeToString(baseType)}'`,
              base.range,
            );
            node.type = INT;
            return INT;
          }
          baseType = baseType.pointee;
        }
        if (baseType.kind !== 'record') {
          diagnostic(
            'E3003',
            'error',
            `'${arrow ? '->' : '.'} needs a record, but this is a '${typeToString(baseType)}'`,
            base.range,
          );
          node.type = INT;
          return INT;
        }
        const field = baseType.fields.find((candidate) => candidate.name === node.name);
        if (field === undefined) {
          diagnostic(
            'E3005',
            'error',
            `no member named '${node.name}' in '${typeToString(baseType)}'`,
            node.range,
            [
              {
                message: `members are ${baseType.fields.map((entry) => entry.name).join(', ') || '(none)'}`,
              },
            ],
          );
          node.type = INT;
          return INT;
        }
        node.type = field.type;
        return field.type;
      }

      case 'SizeOfExpr': {
        const type = typeFromRef(node.typeRef, node.range, 'sizeof');
        requireComplete(type, node.range, 'sizeof');
        node.type = INT;
        // `sizeof` is a compile-time constant: the type's cell count.
        node.value = cellsOf(type);
        return INT;
      }

      case 'NewExpr': {
        const allocated = typeFromRef(node.typeRef, node.range, 'new');
        requireComplete(allocated, node.range, 'new');
        if (node.op === 'new[]' && node.childIds.length > 0) {
          const count = nodes[node.childIds[0]];
          requireInt(exprType(count), count.range, 'the element count in new[]');
        }
        node.type = pointerTo(allocated);
        return node.type;
      }

      case 'CallExpr': {
        const callee = nodes[node.childIds[0]];
        let fnType: Type | null = null;
        if (callee.kind === 'DeclRefExpr') {
          const name = callee.name ?? '';
          const symbol = lookup(name);
          if (symbol === null) {
            if (name === 'malloc') {
              // malloc returns the untyped `void *` that converts to any pointer.
              fnType = { kind: 'function', ret: pointerTo(VOID), params: [INT] };
              callee.type = fnType;
            } else if (name === 'free') {
              // free takes `void *`, so any pointer may be freed.
              fnType = { kind: 'function', ret: INT, params: [pointerTo(VOID)] };
              callee.type = fnType;
            } else {
              diagnostic(
                'E3001',
                'error',
                `call to undeclared function '${callee.name}'`,
                callee.range,
              );
            }
          } else {
            symbol.useNodeIds.push(callee.id);
            callee.refDeclId = symbol.declNodeId;
            if (symbol.type.kind === 'function') {
              fnType = symbol.type;
            } else {
              diagnostic(
                'E3003',
                'error',
                `'${callee.name}' is not a function (it is a ${typeToString(symbol.type)})`,
                callee.range,
              );
            }
          }
        } else {
          exprType(callee);
          diagnostic('E3003', 'error', 'called object is not a function', callee.range);
        }

        const argIds = node.childIds.slice(1);
        const argTypes = argIds.map((id) => exprType(nodes[id]));
        if (fnType !== null && fnType.kind === 'function') {
          const expected = fnType.params.length;
          if (argIds.length !== expected) {
            const problem = argIds.length > expected ? 'too many' : 'too few';
            diagnostic(
              'E3004',
              'error',
              `${problem} arguments to function call, expected ${expected}, have ${argIds.length}`,
              node.range,
            );
          }
          argIds.forEach((argId, index) => {
            const paramType = fnType.kind === 'function' ? fnType.params[index] : undefined;
            if (paramType === undefined) return; // the count was already reported
            requireAssignable(
              argTypes[index],
              nodes[argId],
              paramType,
              nodes[argId].range,
              'function argument',
            );
          });
          node.type = fnType.ret;
          return fnType.ret;
        }
        node.type = INT; // recovery
        return INT;
      }

      case 'UnaryOperator': {
        const operand = nodes[node.childIds[0]];
        const operandType = exprType(operand);
        const op = node.op ?? '';

        if (op === 'prefix&') {
          if (!isLvalue(operand, nodes)) {
            diagnostic('E3003', 'error', 'cannot take the address of a non-lvalue', operand.range);
          }
          const addressType = pointerTo(operandType);
          node.type = addressType;
          return addressType;
        }

        if (op === 'prefix*') {
          const pointee = pointeeOf(operandType);
          if (pointee === null) {
            diagnostic(
              'E3003',
              'error',
              `cannot dereference a value of type '${typeToString(operandType)}'`,
              operand.range,
            );
            node.type = INT;
            return INT;
          }
          if (pointee.kind === 'void') {
            diagnostic(
              'E3003',
              'error',
              "cannot dereference 'void *'; assign it to a typed pointer first",
              operand.range,
            );
            node.type = INT;
            return INT;
          }
          node.type = pointee;
          return pointee;
        }

        if (
          op === 'prefix++' ||
          op === 'prefix--' ||
          op === 'postfix++' ||
          op === 'postfix--'
        ) {
          if (!isLvalue(operand, nodes)) {
            diagnostic(
              'E3003',
              'error',
              `'${op.replace('prefix', '').replace('postfix', '')}' cannot be applied to a non-lvalue`,
              operand.range,
            );
          }
          requireInt(operandType, operand.range, `operand of '${op}'`);
        } else {
          requireInt(operandType, operand.range, `operand of '${op}'`);
        }
        node.type = INT;
        return INT;
      }

      case 'BinaryOperator':
      case 'CompoundAssignOperator': {
        const lhs = nodes[node.childIds[0]];
        const rhs = nodes[node.childIds[1]];
        const lhsType = exprType(lhs);
        const rhsType = exprType(rhs);
        const op = node.op ?? '';
        const isAssign = op === '=' || node.kind === 'CompoundAssignOperator';

        if (isAssign) {
          if (!isLvalue(lhs, nodes)) {
            diagnostic('E3003', 'error', 'assignment to a non-lvalue', lhs.range);
          }
          if (op === '=') {
            requireAssignable(rhsType, rhs, lhsType, rhs.range, `right operand of '='`);
          } else {
            const operatorType = binaryType(op.slice(0, -1), lhsType, rhsType, lhs, rhs);
            requireAssignable(operatorType, lhs, lhsType, rhs.range, `compound assignment '${op}'`);
          }
          node.type = lhsType;
          return lhsType;
        }

        const result = binaryType(op, lhsType, rhsType, lhs, rhs);
        node.type = result;
        return result;
      }

      case 'InitListExpr': {
        diagnostic(
          'E3003',
          'error',
          'initialiser list used where a value is expected',
          node.range,
        );
        node.type = INT;
        return INT;
      }

      default: {
        node.type = INT;
        return INT;
      }
    }
  };

  // ---- Statements ----------------------------------------------------------

  const declareVariable = (node: AstNode, kind: Symbol['kind']): void => {
    const declaredType = typeFromRef(node.typeRef, node.range, `declaration of '${node.name}'`);
    requireComplete(declaredType, node.range, `declaration of '${node.name}'`);
    declare(node.name ?? '', declaredType, kind, node.id);
    node.type = declaredType;
    if (node.childIds.length > 0) {
      checkInitializer(declaredType, nodes[node.childIds[0]], 'variable initialiser');
      // Globals live in the data segment, which IR generation fills in once at
      // compile time — there is no start-up code that could evaluate an
      // expression for them.
      if (kind === 'global') requireStaticInit(nodes[node.childIds[0]]);
    }
  };

  /** Every element of a global `{ ... }` list must itself be a literal or list. */
  const requireStaticInit = (init: AstNode): void => {
    if (init.kind === 'IntegerLiteral') return;
    if (init.kind === 'InitListExpr') {
      for (const childId of init.childIds) requireStaticInit(nodes[childId]);
      return;
    }
    diagnostic(
      'E1010',
      'error',
      `a global initialiser must be an integer literal or a { ... } list of them, but this one is an expression; assign to it inside a function instead`,
      init.range,
    );
  };

  const walkStmt = (node: AstNode): void => {
    switch (node.kind) {
      case 'CompoundStmt': {
        pushScope('block', node.id);
        for (const childId of node.childIds) walkStmt(nodes[childId]);
        popScope();
        return;
      }

      case 'VarDecl': {
        const scope = currentScope();
        const kind: Symbol['kind'] = scope.kind === 'global' ? 'global' : 'local';
        declareVariable(node, kind);
        return;
      }

      case 'IfStmt': {
        const condType = exprType(nodes[node.childIds[0]]);
        requireCondition(condType, nodes[node.childIds[0]].range, "an 'if' condition");
        walkStmt(nodes[node.childIds[1]]);
        if (node.childIds.length === 3) walkStmt(nodes[node.childIds[2]]);
        return;
      }

      case 'WhileStmt': {
        const condType = exprType(nodes[node.childIds[0]]);
        requireCondition(condType, nodes[node.childIds[0]].range, "a 'while' condition");
        loopDepth += 1;
        walkStmt(nodes[node.childIds[1]]);
        loopDepth -= 1;
        return;
      }

      case 'ForStmt': {
        pushScope('block', node.id);
        // Everything before the body is init/cond/inc; the body is the last child.
        for (const childId of node.childIds.slice(0, -1)) {
          const child = nodes[childId];
          if (child.kind === 'VarDecl') {
            walkStmt(child);
          } else {
            const type = exprType(child);
            requireCondition(type, child.range, 'a for-loop expression');
          }
        }
        // The body may contain loops, so track depth around it.
        loopDepth += 1;
        walkStmt(nodes[node.childIds[node.childIds.length - 1]]);
        loopDepth -= 1;
        popScope();
        return;
      }

      case 'ReturnStmt': {
        if (currentFunction === null) return;
        // The signature itself was already rejected (E1010); reporting a
        // mismatch against an unsupported return type would say nothing new.
        if (currentFunction.unsupportedReturn) return;
        const ret = currentFunction.ret;
        if (node.childIds.length === 0) {
          if (ret.kind !== 'void') {
            diagnostic('E3009', 'error', 'non-void function should return a value', node.range);
          }
          return;
        }
        const valueNode = nodes[node.childIds[0]];
        const valueType = exprType(valueNode);
        if (ret.kind === 'void') {
          diagnostic('E3009', 'error', 'void function must not return a value', node.range);
        } else if (!assignable(valueType, valueNode, ret)) {
          diagnostic(
            'E3009',
            'error',
            `returning '${typeToString(valueType)}' from a function with return type '${typeToString(ret)}'`,
            valueNode.range,
          );
        }
        return;
      }

      case 'BreakStmt': {
        if (loopDepth === 0) {
          diagnostic('E3006', 'error', "'break' statement not in a loop", node.range);
        }
        return;
      }

      case 'ContinueStmt': {
        if (loopDepth === 0) {
          diagnostic('E3006', 'error', "'continue' statement not in a loop", node.range);
        }
        return;
      }

      case 'DeleteStmt': {
        const operand = nodes[node.childIds[0]];
        const operandType = exprType(operand);
        if (!isAddress(operandType)) {
          diagnostic(
            'E3003',
            'error',
            `'delete' needs a pointer, but this is a '${typeToString(operandType)}'`,
            operand.range,
          );
        }
        return;
      }

      case 'PrintStmt': {
        const argIds = node.childIds;
        if (node.op === 'print') {
          if (argIds.length > 1) {
            diagnostic(
              'E3004',
              'error',
              `too many arguments to 'print', expected at most 1, have ${argIds.length}`,
              node.range,
            );
          }
          for (const argId of argIds) {
            const type = exprType(nodes[argId]);
            requireInt(type, nodes[argId].range, "argument of 'print'");
          }
          return;
        }
        // printf(format[, value...])
        if (argIds.length > 0) {
          const formatNode = nodes[argIds[0]];
          const formatType = exprType(formatNode);
          if (formatNode.kind !== 'StringLiteral') {
            diagnostic(
              'E3003',
              'error',
              `the first argument of 'printf' must be a format string literal, not a '${typeToString(formatType)}'`,
              formatNode.range,
            );
          }
          for (const argId of argIds.slice(1)) {
            const type = exprType(nodes[argId]);
            requireInt(type, nodes[argId].range, "argument of 'printf'");
          }
        }
        return;
      }

      case 'ExprStmt': {
        exprType(nodes[node.childIds[0]]);
        return;
      }

      default:
        return;
    }
  };

  // ---- Records -------------------------------------------------------------
  // Every tag is registered first so a pointer can name a record defined later;
  // layouts are then computed in source order, which is also what makes a
  // record that contains itself by value a clear error instead of a loop.

  for (const childId of nodes[ast.rootId].childIds) {
    const node = nodes[childId];
    if (node.kind !== 'RecordDecl') continue;
    const tag = node.name ?? '';
    const recordKind: 'struct' | 'union' = node.op === 'union' ? 'union' : 'struct';
    const previous = recordDeclNodes.get(tag);
    if (previous !== undefined || recordTypes.has(tag)) {
      diagnostic('E3002', 'error', `redefinition of '${recordKind} ${tag}'`, node.range, [
        { message: 'previous definition is here', range: nodes[(previous ?? node).id].range },
      ]);
      continue;
    }
    recordTypes.set(tag, { kind: 'record', recordKind, name: tag, fields: [], size: 0 });
    recordDeclNodes.set(tag, node);
  }

  for (const [tag, node] of recordDeclNodes) {
    const record = recordTypes.get(tag);
    if (record === undefined || record.kind !== 'record') continue;
    const union = record.recordKind === 'union';
    const fields: RecordField[] = [];
    let offset = 0;
    let unionSize = 0;
    for (const fieldId of node.childIds) {
      const fieldNode = nodes[fieldId];
      if (fieldNode.kind !== 'FieldDecl') continue;
      const fieldType = typeFromRef(
        fieldNode.typeRef,
        fieldNode.range,
        `field '${fieldNode.name}'`,
      );
      requireComplete(fieldType, fieldNode.range, `field '${fieldNode.name}'`);
      const duplicate = fields.find((field) => field.name === fieldNode.name);
      if (duplicate !== undefined) {
        diagnostic('E3002', 'error', `duplicate member '${fieldNode.name}'`, fieldNode.range, [
          { message: 'previous member is here', range: duplicate.range },
        ]);
      }
      const size = cellsOf(fieldType);
      fields.push({
        name: fieldNode.name ?? '',
        type: fieldType,
        offset: union ? 0 : offset,
        size,
        range: fieldNode.range,
      });
      offset += size;
      unionSize = Math.max(unionSize, size);
    }
    record.fields = fields;
    record.size = union ? unionSize : offset;
    completeRecords.add(tag);
  }

  // ---- Top level -----------------------------------------------------------

  pushScope('global', ast.rootId);
  for (const childId of nodes[ast.rootId].childIds) {
    const node = nodes[childId];
    if (node.kind === 'FunctionDecl') {
      let ret: Type = node.declRet === 'void' ? VOID : INT;
      // Set when this signature was already reported with E1010: the body must
      // not pile a second, contradictory error on top of the first one.
      let retRejected = false;
      if (node.typeRef !== undefined) {
        ret = typeFromRef(node.typeRef, node.range, `return type of '${node.name}'`);
        // The declared return type is kept even when it is rejected, so the
        // body still analyses against what the programmer wrote instead of
        // cascading into a mismatch against a substituted type.
        if (ret.kind === 'array') {
          diagnostic('E1010', 'error', 'functions cannot return arrays', node.range);
          retRejected = true;
        } else if (ret.kind === 'record') {
          diagnostic(
            'E1010',
            'error',
            `functions cannot return '${typeToString(ret)}' by value; return a pointer instead`,
            node.range,
          );
          retRejected = true;
        }
      }

      const paramTypes: Type[] = [];
      const paramNodes: AstNode[] = [];
      for (const id of node.childIds) {
        const child = nodes[id];
        if (child.kind !== 'ParamDecl') continue;
        let paramType = typeFromRef(child.typeRef, child.range, `parameter '${child.name}'`);
        if (paramType.kind === 'array') {
          // An array parameter is passed by address, exactly like in C.
          paramType = decay(paramType);
        }
        if (paramType.kind === 'void') {
          diagnostic('E3003', 'error', `parameter '${child.name}' has type 'void'`, child.range);
          paramType = INT;
        }
        if (paramType.kind === 'record') {
          // The parameter keeps its record type: reporting E1010 is enough, and
          // leaving it alone lets the body (p.x, p->y through a pointer taken
          // of it) analyse normally instead of cascading into field errors.
          diagnostic(
            'E1010',
            'error',
            `'${typeToString(paramType)}' cannot be passed by value; pass a pointer instead`,
            child.range,
          );
        }
        child.type = paramType;
        paramTypes.push(paramType);
        paramNodes.push(child);
      }

      const hasBody = node.childIds.some((id) => nodes[id].kind === 'CompoundStmt');
      const fnType: Type = { kind: 'function', ret, params: paramTypes };
      declare(node.name ?? '', fnType, 'function', node.id);
      node.type = fnType;
      if (hasBody) {
        pushScope('function', node.id);
        currentFunction = { name: node.name ?? '', ret, unsupportedReturn: retRejected };
        paramNodes.forEach((paramNode) => {
          declare(paramNode.name ?? '', paramNode.type ?? INT, 'param', paramNode.id);
        });
        // Walk the body's statements directly in the function scope so that a
        // local redeclaring a parameter is a redeclaration (like C).
        const bodyId = node.childIds.find((id) => nodes[id].kind === 'CompoundStmt')!;
        for (const stmtId of nodes[bodyId].childIds) walkStmt(nodes[stmtId]);

        if (
          ret.kind !== 'void' &&
          node.name !== 'main' &&
          !definitelyReturns(nodes[bodyId], nodes)
        ) {
          diagnostic(
            'W4002',
            'warning',
            'control may reach the end of a non-void function',
            node.range,
          );
        }
        currentFunction = null;
        popScope();
      }
    } else if (node.kind === 'VarDecl') {
      declareVariable(node, 'global');
    }
    // RecordDecl nodes were laid out before the walk; anything else at file
    // scope was already rejected by the parser.
  }
  popScope();

  // W4001: unused local variables (parameters are not reported).
  for (const symbol of symbols) {
    if (symbol.kind === 'local' && symbol.useNodeIds.length === 0) {
      diagnostic(
        'W4001',
        'warning',
        `unused variable '${symbol.name}'`,
        nodes[symbol.declNodeId].range,
      );
    }
  }

  return { symbols, scopes, diagnostics };
}
