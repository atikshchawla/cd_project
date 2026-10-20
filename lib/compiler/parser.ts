import type { Ast, AstKind, AstNode, Diagnostic, Range, Token } from './types';

export interface ParseResult {
  ast: Ast | null;
  diagnostics: Diagnostic[];
}

const SUPPORTED_KEYWORDS = new Set([
  'int',
  'void',
  'if',
  'else',
  'while',
  'for',
  'return',
  'break',
  'continue',
]);

const ASSIGN_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

class ParseAbort extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

function isSupportedTypeKeyword(text: string): boolean {
  return text === 'int' || text === 'void';
}

/** Hand-written recursive-descent parser for Mini-C (§6.2). Never throws. */
export function parse(tokens: Token[], source: string): ParseResult {
  const program = tokens.filter((token) => token.kind !== 'directive');
  let nextId = 0;
  const diagnosticId = 1;
  let position = 0;

  const nodes: Record<number, AstNode> = {};

  const createNode = (
    kind: AstKind,
    range: Range = { start: 0, end: 0 },
    extra?: Omit<Partial<AstNode>, 'id' | 'kind' | 'range' | 'parentId' | 'childIds'>,
  ): number => {
    const id = nextId;
    nextId += 1;
    nodes[id] = {
      id,
      kind,
      range,
      parentId: null,
      childIds: [],
      ...extra,
    };
    return id;
  };

  const attach = (parentId: number, childId: number): void => {
    nodes[childId].parentId = parentId;
    nodes[parentId].childIds.push(childId);
  };

  const setRange = (nodeId: number, range: Range): void => {
    nodes[nodeId].range = range;
  };

  const makeDiagnostic = (
    code: string,
    stage: Diagnostic['stage'],
    message: string,
    range: Range,
    notes?: Diagnostic['notes'],
  ): Diagnostic => ({
    id: diagnosticId,
    severity: 'error',
    code,
    stage,
    message,
    range,
    ...(notes ? { notes } : {}),
  });

  const current = (): Token | undefined => program[position];
  const previous = (): Token | undefined => (position > 0 ? program[position - 1] : undefined);
  const isAtEnd = (): boolean => position >= program.length;

  const advance = (): Token => {
    const token = program[position];
    position += 1;
    return token;
  };

  const check = (text: string): boolean => {
    const token = current();
    return token !== undefined && token.text === text;
  };

  const match = (text: string): boolean => {
    if (!check(text)) return false;
    advance();
    return true;
  };

  const eofRange = (): Range => {
    const last = previous();
    const end = last?.range.end ?? source.length;
    return { start: end, end };
  };

  const unsupported = (token: Token): never => {
    throw new ParseAbort(
      makeDiagnostic(
        'E1010',
        'unsupported',
        `'${token.text}' is a reserved word that Mini-C does not support.`,
        token.range,
        [
          {
            message:
              'Supported types are int and void. Supported statements are blocks, if/else, while, for, return, break and continue.',
          },
        ],
      ),
    );
  };

  const assertSupported = (token: Token | undefined): void => {
    if (token === undefined) return;
    if (token.kind === 'keyword' && !SUPPORTED_KEYWORDS.has(token.text)) {
      unsupported(token);
    }
  };

  const expectedError = (expected: string, context: string): never => {
    const token = current();
    assertSupported(token);
    // For a missing ';' the marker points at the end of the previous token.
    const range: Range =
      expected === ';' && previous() !== undefined
        ? { start: previous()!.range.end, end: previous()!.range.end }
        : (token?.range ?? eofRange());
    throw new ParseAbort(
      makeDiagnostic('E2001', 'parse', `expected '${expected}' ${context}`, range),
    );
  };

  const unexpected = (context: string): never => {
    const token = current();
    assertSupported(token);
    if (token === undefined) {
      throw new ParseAbort(
        makeDiagnostic(
          'E2002',
          'parse',
          `unexpected end of input ${context}`,
          eofRange(),
        ),
      );
    }
    throw new ParseAbort(
      makeDiagnostic('E2002', 'parse', `unexpected token '${token.text}' ${context}`, token.range),
    );
  };

  const expect = (text: string, context: string): Token => {
    if (check(text)) return advance();
    return expectedError(text, context);
  };

  const expectIdentifier = (context: string): Token => {
    const token = current();
    if (token !== undefined && token.kind === 'identifier') return advance();
    return expectedError('identifier', context);
  };

  const rangeBetween = (startOffset: number, endOffset: number): Range => ({
    start: startOffset,
    end: endOffset,
  });

  const translationUnit = (): Ast => {
    const rootId = createNode('TranslationUnit', { start: 0, end: source.length });
    while (!isAtEnd()) {
      attach(rootId, externalDeclaration());
    }
    return { rootId, nodes };
  };

  const externalDeclaration = (): number => {
    const token = current();
    assertSupported(token);
    if (token === undefined || !isSupportedTypeKeyword(token.text)) {
      return unexpected('at file scope');
    }
    const typeToken = advance();
    const nameToken = expectIdentifier(`after '${typeToken.text}'`);

    if (check('(')) {
      // Function definition or prototype.
      const functionId = createNode('FunctionDecl', rangeBetween(typeToken.range.start, 0), {
        name: nameToken.text,
        declRet: typeToken.text === 'void' ? 'void' : 'int',
      });
      advance(); // '('
      parseParameters(functionId);
      expect(')', 'after function parameters');
      if (check('{')) {
        const bodyId = parseCompound();
        attach(functionId, bodyId);
        setRange(functionId, rangeBetween(typeToken.range.start, nodes[bodyId].range.end));
      } else {
        const semi = expect(';', 'after function declaration');
        setRange(functionId, rangeBetween(typeToken.range.start, semi.range.end));
      }
      return functionId;
    }

    // Global variable declaration.
    const variableId = createNode('VarDecl', rangeBetween(typeToken.range.start, 0), {
      name: nameToken.text,
    });
    let endOffset = nameToken.range.end;
    if (match('=')) {
      const initId = parseAssign();
      attach(variableId, initId);
      endOffset = nodes[initId].range.end;
    }
    expect(';', 'after global declaration');
    setRange(variableId, rangeBetween(typeToken.range.start, endOffset));
    return variableId;
  };

  const parseParameters = (functionId: number): void => {
    if (check(')')) return; // f()
    if (check('void') && program[position + 1]?.text === ')') {
      advance(); // void
      return;
    }

    while (true) {
      const token = current();
      if (token === undefined || token.text !== 'int') {
        expectedError("'int'", 'in parameter list');
      }
      const typeToken = advance();
      const nameToken = expectIdentifier("after 'int' in parameter list");
      const paramId = createNode(
        'ParamDecl',
        rangeBetween(typeToken.range.start, nameToken.range.end),
        { name: nameToken.text },
      );
      attach(functionId, paramId);
      if (!match(',')) break;
    }
  };

  const parseCompound = (): number => {
    const open = expect('{', 'to start a block');
    const blockId = createNode('CompoundStmt');

    while (!check('}')) {
      if (isAtEnd()) unexpected('in block');
      if (check('int')) {
        attach(blockId, declaration());
      } else {
        attach(blockId, statement());
      }
    }
    const close = expect('}', 'to close the block');
    setRange(blockId, rangeBetween(open.range.start, close.range.end));
    return blockId;
  };

  const declaration = (): number => {
    const typeToken = expect('int', 'in declaration');
    const nameToken = expectIdentifier("after 'int' in declaration");
    const variableId = createNode('VarDecl', rangeBetween(typeToken.range.start, 0), {
      name: nameToken.text,
    });
    let endOffset = nameToken.range.end;
    if (match('=')) {
      const initId = parseAssign();
      attach(variableId, initId);
      endOffset = nodes[initId].range.end;
    }
    expect(';', 'after declaration');
    setRange(variableId, rangeBetween(typeToken.range.start, endOffset));
    return variableId;
  };

  const statement = (): number => {
    const token = current();
    assertSupported(token);
    if (token === undefined) return unexpected('where a statement was expected');

    if (token.text === '{') return parseCompound();

    if (token.text === 'if') {
      const ifToken = advance();
      const ifId = createNode('IfStmt');
      expect('(', "after 'if'");
      attach(ifId, parseExpression());
      expect(')', 'after the if condition');
      attach(ifId, statement());
      if (check('else')) {
        advance();
        attach(ifId, statement());
      }
      const lastChildId = nodes[ifId].childIds.at(-1)!;
      setRange(
        ifId,
        rangeBetween(ifToken.range.start, nodes[lastChildId].range.end),
      );
      return ifId;
    }

    if (token.text === 'while') {
      const whileToken = advance();
      const whileId = createNode('WhileStmt');
      expect('(', "after 'while'");
      attach(whileId, parseExpression());
      expect(')', 'after the while condition');
      attach(whileId, statement());
      const lastChildId = nodes[whileId].childIds.at(-1)!;
      setRange(
        whileId,
        rangeBetween(whileToken.range.start, nodes[lastChildId].range.end),
      );
      return whileId;
    }

    if (token.text === 'for') {
      return parseFor();
    }

    if (token.text === 'return') {
      const returnToken = advance();
      const returnId = createNode('ReturnStmt');
      if (!check(';')) attach(returnId, parseExpression());
      const semi = expect(';', 'after the return value');
      setRange(returnId, rangeBetween(returnToken.range.start, semi.range.end));
      return returnId;
    }

    if (token.text === 'break' || token.text === 'continue') {
      const keywordToken = advance();
      const keywordId = createNode(
        token.text === 'break' ? 'BreakStmt' : 'ContinueStmt',
      );
      const semi = expect(';', `after '${keywordToken.text}'`);
      setRange(keywordId, rangeBetween(keywordToken.range.start, semi.range.end));
      return keywordId;
    }

    if (token.text === ';') {
      const semiToken = advance();
      return createNode('NullStmt', semiToken.range);
    }

    // Expression statement.
    const expressionId = parseExpression();
    const semi = expect(';', 'after expression');
    const expressionStatementId = createNode(
      'ExprStmt',
      rangeBetween(nodes[expressionId].range.start, semi.range.end),
    );
    attach(expressionStatementId, expressionId);
    return expressionStatementId;
  };

  const parseFor = (): number => {
    const forToken = advance();
    const forId = createNode('ForStmt');
    expect('(', "after 'for'");

    if (check('int')) {
      const initId = declaration();
      nodes[initId].forRole = 'init';
      attach(forId, initId);
    } else {
      if (!check(';')) {
        const initId = parseExpression();
        nodes[initId].forRole = 'init';
        attach(forId, initId);
      }
      expect(';', 'after the for initialiser');
    }

    if (!check(';')) {
      const condId = parseExpression();
      nodes[condId].forRole = 'cond';
      attach(forId, condId);
    }
    expect(';', 'after the for condition');

    if (!check(')')) {
      const incId = parseExpression();
      nodes[incId].forRole = 'inc';
      attach(forId, incId);
    }
    expect(')', 'to close the for header');

    const bodyId = statement();
    nodes[bodyId].forRole = 'body';
    attach(forId, bodyId);
    const lastChildId = nodes[forId].childIds.at(-1)!;
    setRange(forId, rangeBetween(forToken.range.start, nodes[lastChildId].range.end));
    return forId;
  };

  const parseExpression = (): number => parseAssign();

  const parseAssign = (): number => {
    const leftId = parseLogicalOr();
    const token = current();
    if (token === undefined || !ASSIGN_OPERATORS.has(token.text)) return leftId;

    advance();
    const operatorId = createNode(
      token.text === '=' ? 'BinaryOperator' : 'CompoundAssignOperator',
      rangeBetween(nodes[leftId].range.start, 0),
      { op: token.text },
    );
    attach(operatorId, leftId);
    attach(operatorId, parseAssign());
    const rightId = nodes[operatorId].childIds[1];
    setRange(
      operatorId,
      rangeBetween(nodes[operatorId].range.start, nodes[rightId].range.end),
    );
    return operatorId;
  };

  const binaryLevel = (
    next: () => number,
    operatorTexts: Set<string>,
    kind: AstKind = 'BinaryOperator',
  ): number => {
    let leftId = next();
    while (true) {
      const token = current();
      if (token === undefined || !operatorTexts.has(token.text)) break;
      advance();
      const operatorId = createNode(kind, rangeBetween(nodes[leftId].range.start, 0), {
        op: token.text,
      });
      attach(operatorId, leftId);
      attach(operatorId, next());
      const rightId = nodes[operatorId].childIds[1];
      setRange(
        operatorId,
        rangeBetween(nodes[operatorId].range.start, nodes[rightId].range.end),
      );
      leftId = operatorId;
    }
    return leftId;
  };

  const parseLogicalOr = (): number =>
    binaryLevel(parseLogicalAnd, new Set(['||']));
  const parseLogicalAnd = (): number =>
    binaryLevel(parseEquality, new Set(['&&']));
  const parseEquality = (): number =>
    binaryLevel(parseRelational, new Set(['==', '!=']));
  const parseRelational = (): number =>
    binaryLevel(parseAdditive, new Set(['<', '>', '<=', '>=']));
  const parseAdditive = (): number =>
    binaryLevel(parseMultiplicative, new Set(['+', '-']));
  const parseMultiplicative = (): number =>
    binaryLevel(parseUnary, new Set(['*', '/', '%']));

  const parseUnary = (): number => {
    const token = current();
    if (
      token !== undefined &&
      (token.text === '-' || token.text === '!' || token.text === '++' || token.text === '--')
    ) {
      advance();
      const unaryId = createNode('UnaryOperator', rangeBetween(token.range.start, 0), {
        op: `prefix${token.text}`,
      });
      attach(unaryId, parseUnary());
      const operandId = nodes[unaryId].childIds[0];
      setRange(
        unaryId,
        rangeBetween(token.range.start, nodes[operandId].range.end),
      );
      return unaryId;
    }
    return parsePostfix();
  };

  const parsePostfix = (): number => {
    let currentId = parsePrimary();
    while (true) {
      const token = current();
      if (token !== undefined && token.text === '(') {
        advance();
        const callId = createNode('CallExpr', rangeBetween(nodes[currentId].range.start, 0));
        attach(callId, currentId);
        if (!check(')')) {
          attach(callId, parseAssign());
          while (match(',')) attach(callId, parseAssign());
        }
        const close = expect(')', 'to close the argument list');
        setRange(
          callId,
          rangeBetween(nodes[callId].range.start, close.range.end),
        );
        currentId = callId;
        continue;
      }
      if (token !== undefined && (token.text === '++' || token.text === '--')) {
        advance();
        const unaryId = createNode(
          'UnaryOperator',
          rangeBetween(nodes[currentId].range.start, token.range.end),
          { op: `postfix${token.text}` },
        );
        attach(unaryId, currentId);
        currentId = unaryId;
        continue;
      }
      break;
    }
    return currentId;
  };

  const parsePrimary = (): number => {
    const token = current();
    if (token === undefined) return unexpected('where an expression was expected');
    assertSupported(token);

    if (token.kind === 'identifier') {
      advance();
      return createNode('DeclRefExpr', token.range, { name: token.text });
    }
    if (token.kind === 'integer-literal') {
      advance();
      return createNode('IntegerLiteral', token.range, { value: Number(token.text) });
    }
    if (token.text === '(') {
      advance();
      const expressionId = parseExpression();
      const close = expect(')', 'to close the parenthesised expression');
      const parenId = createNode(
        'ParenExpr',
        rangeBetween(token.range.start, close.range.end),
      );
      attach(parenId, expressionId);
      return parenId;
    }
    return unexpected('where an expression was expected');
  };

  try {
    return { ast: translationUnit(), diagnostics: [] };
  } catch (error) {
    if (error instanceof ParseAbort) {
      return { ast: null, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}
