import type { Ast, AstNode, Diagnostic, Scope, Symbol, Type } from './types';

export interface SemaResult {
  symbols: Symbol[];
  scopes: Scope[];
  diagnostics: Diagnostic[];
}

const INT: Type = { kind: 'int' };
const VOID: Type = { kind: 'void' };

function isLvalue(node: AstNode): boolean {
  if (node.kind === 'DeclRefExpr') return true;
  if (node.kind === 'ParenExpr' && node.childIds.length === 1) {
    // The parser stores the inner expression as a child; lvalue-ness passes through.
    return true;
  }
  return false;
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
 * types and declaration links, builds the symbol/scope tables, and collects
 * *all* semantic diagnostics (it does not stop at the first error).
 */
export function analyse(ast: Ast): SemaResult {
  const nodes = ast.nodes;
  const symbols: Symbol[] = [];
  const scopes: Scope[] = [];
  const diagnostics: Diagnostic[] = [];
  const scopeStack: number[] = [];
  let loopDepth = 0;
  let currentFunction: { name: string; ret: Type } | null = null;

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

  const typeToString = (type: Type): string => {
    if (type.kind === 'function') return 'function';
    return type.kind;
  };

  const requireInt = (
    type: Type,
    range: AstNode['range'],
    context: string,
  ): void => {
    if (type.kind !== 'int') {
      diagnostic(
        'E3003',
        'error',
        `invalid 'void' value used as an int (${context})`,
        range,
      );
    }
  };

  // ---- Expressions ---------------------------------------------------------

  const exprType = (node: AstNode): Type => {
    switch (node.kind) {
      case 'IntegerLiteral': {
        node.type = INT;
        return INT;
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

      case 'CallExpr': {
        const callee = nodes[node.childIds[0]];
        let fnType: Type | null = null;
        if (callee.kind === 'DeclRefExpr') {
          const symbol = lookup(callee.name ?? '');
          if (symbol === null) {
            diagnostic(
              'E3001',
              'error',
              `call to undeclared function '${callee.name}'`,
              callee.range,
            );
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
          for (const argType of argTypes) {
            requireInt(argType, node.range, 'function argument');
          }
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
        if (op === 'prefix++' || op === 'prefix--' || op === 'postfix++' || op === 'postfix--') {
          if (!isLvalue(operand)) {
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
        if (op === '=' || node.kind === 'CompoundAssignOperator') {
          if (!isLvalue(lhs)) {
            diagnostic('E3003', 'error', 'assignment to a non-lvalue', lhs.range);
          }
          requireInt(rhsType, rhs.range, `right operand of '${op}'`);
          if (op === '=') requireInt(lhsType, lhs.range, `left operand of '${op}'`);
        } else {
          requireInt(lhsType, lhs.range, `left operand of '${op}'`);
          requireInt(rhsType, rhs.range, `right operand of '${op}'`);
        }
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
        declare(node.name ?? '', INT, kind, node.id);
        node.type = INT;
        if (node.childIds.length > 0) {
          const initType = exprType(nodes[node.childIds[0]]);
          requireInt(initType, nodes[node.childIds[0]].range, 'variable initialiser');
        }
        return;
      }

      case 'IfStmt': {
        const condType = exprType(nodes[node.childIds[0]]);
        requireInt(condType, nodes[node.childIds[0]].range, "an 'if' condition");
        walkStmt(nodes[node.childIds[1]]);
        if (node.childIds.length === 3) walkStmt(nodes[node.childIds[2]]);
        return;
      }

      case 'WhileStmt': {
        const condType = exprType(nodes[node.childIds[0]]);
        requireInt(condType, nodes[node.childIds[0]].range, "a 'while' condition");
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
            requireInt(type, child.range, 'a for-loop expression');
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
        } else if (valueType.kind !== 'int') {
          diagnostic(
            'E3009',
            'error',
            `returning 'void' from a function with return type '${typeToString(ret)}'`,
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

      case 'ExprStmt': {
        exprType(nodes[node.childIds[0]]);
        return;
      }

      default:
        return;
    }
  };

  // ---- Top level -----------------------------------------------------------

  pushScope('global', ast.rootId);
  for (const childId of nodes[ast.rootId].childIds) {
    const node = nodes[childId];
    if (node.kind === 'FunctionDecl') {
      const ret: Type = node.declRet === 'void' ? VOID : INT;
      const hasBody = node.childIds.some((id) => nodes[id].kind === 'CompoundStmt');
      const paramCount = node.childIds.filter((id) => nodes[id].kind === 'ParamDecl').length;
      declare(
        node.name ?? '',
        { kind: 'function', ret, params: Array.from({ length: paramCount }, () => INT) },
        'function',
        node.id,
      );
      node.type = { kind: 'function', ret, params: Array.from({ length: paramCount }, () => INT) };
      if (hasBody) {
        pushScope('function', node.id);
        currentFunction = { name: node.name ?? '', ret };
        for (const id of node.childIds) {
          const child = nodes[id];
          if (child.kind === 'ParamDecl') {
            declare(child.name ?? '', INT, 'param', child.id);
            child.type = INT;
          }
        }
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
      declare(node.name ?? '', INT, 'global', node.id);
      node.type = INT;
      if (node.childIds.length > 0) {
        const initType = exprType(nodes[node.childIds[0]]);
        requireInt(initType, nodes[node.childIds[0]].range, 'global initialiser');
      }
    }
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
