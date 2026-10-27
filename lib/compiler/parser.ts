import type { Ast, AstKind, AstNode, Diagnostic, Range, Token, TypeRef } from './types';

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
  'struct',
  'union',
  'sizeof',
  'new',
  'delete',
  'print',
  'printf',
]);

const ASSIGN_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

/** Largest array (and heap block) this dialect will reserve, in cells. */
const MAX_CELLS = 100000;

class ParseAbort extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

/**
 * Decode a `"..."` token's contents (without the quotes).
 *
 * The standard C escapes are resolved and an unknown escape keeps its
 * backslash, exactly like the reference implementation's `unicode_escape`.
 */
function decodeEscapes(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    i += 1;
    if (i >= body.length) {
      out += '\\';
      break;
    }
    const escaped = body[i];
    switch (escaped) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '0':
        out += '\0';
        break;
      case 'a':
        out += '\x07';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'v':
        out += '\v';
        break;
      case '\\':
      case '"':
      case "'":
        out += escaped;
        break;
      default:
        out += `\\${escaped}`;
    }
  }
  return out;
}

/** Type keywords Mini-C understands (as opposed to reserved words). */
const TYPE_KEYWORDS = new Set(['int', 'void', 'struct', 'union']);

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
              'Supported types are int, void, pointers, arrays, struct and union. Supported statements include blocks, if/else, while, for, delete, print/printf, return, break and continue.',
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

  // ---- Type specs and declarators -----------------------------------------

  interface TypeSpec {
    base: 'int' | 'void' | 'struct' | 'union';
    tag?: string;
    token: Token;
  }

  interface Declarator {
    nameToken: Token;
    typeRef: TypeRef;
  }

  /** Does this token start a declaration (`int`, `void`, `struct X`, `union X`)? */
  const isTypeStart = (token: Token | undefined): boolean =>
    token !== undefined && token.kind === 'keyword' && TYPE_KEYWORDS.has(token.text);

  /** Consumes `int` / `void` / `struct Name` / `union Name`. */
  const parseTypeSpec = (context: string): TypeSpec => {
    const token = current();
    if (token === undefined) return expectedError("'int'", context);
    assertSupported(token);
    if (token.kind !== 'keyword' || !TYPE_KEYWORDS.has(token.text)) {
      return expectedError("'int'", context);
    }
    advance();
    if (token.text === 'struct' || token.text === 'union') {
      const tag = current();
      if (tag === undefined || tag.kind !== 'identifier') {
        return expectedError('identifier', `after '${token.text}'`);
      }
      advance();
      return { base: token.text, tag: tag.text, token };
    }
    return { base: token.text as 'int' | 'void', token };
  };

  /** An array size must be an integer literal: this dialect sizes arrays statically. */
  const parseArraySize = (): number => {
    const token = current();
    if (token === undefined || token.kind !== 'integer-literal') {
      assertSupported(token);
      throw new ParseAbort(
        makeDiagnostic(
          'E1010',
          'unsupported',
          'Array sizes must be written as integer literals.',
          token?.range ?? eofRange(),
          [
            {
              message:
                'Variables and expressions are not allowed between [ and ]; Mini-C sizes every array at compile time.',
            },
          ],
        ),
      );
    }
    advance();
    const size = Number(token.text);
    if (!Number.isSafeInteger(size) || size > MAX_CELLS) {
      throw new ParseAbort(
        makeDiagnostic('E1010', 'unsupported', `Array size ${token.text} is too large.`, token.range, [
          { message: `An array reserves at most ${MAX_CELLS} cells (400 000 bytes).` },
        ]),
      );
    }
    return size;
  };

  /** Consumes `*`* name `[n]`... after a type spec. */
  const parseDeclarator = (spec: TypeSpec, context: string): Declarator => {
    let stars = 0;
    while (match('*')) stars += 1;
    const nameToken = expectIdentifier(context);
    const dims: number[] = [];
    while (check('[')) {
      advance();
      dims.push(parseArraySize());
      expect(']', 'to close the array size');
    }
    return { nameToken, typeRef: { base: spec.base, tag: spec.tag, stars, dims } };
  };

  /** `{ e1, e2, ... }`, nested for multi-dimensional initialisers. */
  const parseInitList = (): number => {
    const open = expect('{', 'to start an initialiser list');
    const listId = createNode('InitListExpr');
    if (!check('}')) {
      while (true) {
        attach(listId, check('{') ? parseInitList() : parseAssign());
        if (!match(',')) break;
        if (check('}')) break; // trailing comma
      }
    }
    const close = expect('}', 'to close the initialiser list');
    setRange(listId, rangeBetween(open.range.start, close.range.end));
    return listId;
  };

  /** The right-hand side of `=`, which may be an initialiser list. */
  const parseInitializer = (): number => (check('{') ? parseInitList() : parseAssign());

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
    if (token === undefined || !isTypeStart(token)) {
      return unexpected('at file scope');
    }

    // `struct Point { ... };` / `union Bits { ... };` — a type definition, not a
    // declaration, is recognised by the `{` straight after the tag.
    if (
      (token.text === 'struct' || token.text === 'union') &&
      program[position + 1]?.kind === 'identifier' &&
      program[position + 2]?.text === '{'
    ) {
      return recordDeclaration();
    }

    const spec = parseTypeSpec('at file scope');
    const declarator = parseDeclarator(spec, `after '${spec.token.text}'`);
    const { nameToken, typeRef } = declarator;

    if (check('(')) {
      // Function definition or prototype.
      const functionId = createNode('FunctionDecl', rangeBetween(spec.token.range.start, 0), {
        name: nameToken.text,
        declRet: typeRef.base === 'void' && typeRef.stars === 0 ? 'void' : 'int',
        typeRef,
      });
      advance(); // '('
      parseParameters(functionId);
      expect(')', 'after function parameters');
      if (check('{')) {
        const bodyId = parseCompound();
        attach(functionId, bodyId);
        setRange(functionId, rangeBetween(spec.token.range.start, nodes[bodyId].range.end));
      } else {
        const semi = expect(';', 'after function declaration');
        setRange(functionId, rangeBetween(spec.token.range.start, semi.range.end));
      }
      return functionId;
    }

    // Global variable declaration.
    const variableId = createNode('VarDecl', rangeBetween(spec.token.range.start, 0), {
      name: nameToken.text,
      typeRef,
    });
    let endOffset = nameToken.range.end;
    if (match('=')) {
      const initId = parseInitializer();
      attach(variableId, initId);
      endOffset = nodes[initId].range.end;
    }
    expect(';', 'after global declaration');
    setRange(variableId, rangeBetween(spec.token.range.start, endOffset));
    return variableId;
  };

  const recordDeclaration = (): number => {
    const keywordToken = advance(); // struct | union
    const tagToken = advance(); // the tag name (checked by the caller)
    expect('{', `to start the body of '${keywordToken.text} ${tagToken.text}'`);
    const recordId = createNode('RecordDecl', rangeBetween(keywordToken.range.start, 0), {
      name: tagToken.text,
      op: keywordToken.text,
    });
    while (!check('}')) {
      if (isAtEnd()) unexpected('in the record body');
      attach(recordId, fieldDeclaration());
    }
    expect('}', 'to close the record body');
    const semi = expect(';', `after '}' closing ${keywordToken.text} ${tagToken.text}`);
    setRange(recordId, rangeBetween(keywordToken.range.start, semi.range.end));
    return recordId;
  };

  const fieldDeclaration = (): number => {
    const spec = parseTypeSpec('in a record field');
    const { nameToken, typeRef } = parseDeclarator(spec, `after '${spec.token.text}' in a record field`);
    if (typeRef.stars > 0 && typeRef.dims.length > 0) {
      throw new ParseAbort(
        makeDiagnostic(
          'E1010',
          'unsupported',
          'Record fields may be pointers or arrays, but not arrays of pointers.',
          nameToken.range,
        ),
      );
    }
    const semi = expect(';', 'after the field declaration');
    return createNode(
      'FieldDecl',
      rangeBetween(spec.token.range.start, semi.range.end),
      { name: nameToken.text, typeRef },
    );
  };

  const parseParameters = (functionId: number): void => {
    if (check(')')) return; // f()
    if (check('void') && program[position + 1]?.text === ')') {
      advance(); // void
      return;
    }

    while (true) {
      const spec = parseTypeSpec('in parameter list');
      const { nameToken, typeRef } = parseDeclarator(spec, `after '${spec.token.text}' in parameter list`);
      const paramId = createNode(
        'ParamDecl',
        rangeBetween(spec.token.range.start, nameToken.range.end),
        { name: nameToken.text, typeRef },
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
      if (isTypeStart(current())) {
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
    const spec = parseTypeSpec('in declaration');
    const { nameToken, typeRef } = parseDeclarator(spec, `after '${spec.token.text}' in declaration`);
    const variableId = createNode('VarDecl', rangeBetween(spec.token.range.start, 0), {
      name: nameToken.text,
      typeRef,
    });
    let endOffset = nameToken.range.end;
    if (match('=')) {
      const initId = parseInitializer();
      attach(variableId, initId);
      endOffset = nodes[initId].range.end;
    }
    expect(';', 'after declaration');
    setRange(variableId, rangeBetween(spec.token.range.start, endOffset));
    return variableId;
  };

  const statement = (): number => {
    const token = current();
    assertSupported(token);
    if (token === undefined) return unexpected('where a statement was expected');

    if (token.text === '{') return parseCompound();

    // A declaration may appear wherever a statement may (as in the reference).
    if (isTypeStart(token)) return declaration();

    if (token.text === 'delete') {
      const keywordToken = advance();
      const deleteId = createNode('DeleteStmt');
      attach(deleteId, parseExpression());
      const semi = expect(';', "after the operand of 'delete'");
      setRange(deleteId, rangeBetween(keywordToken.range.start, semi.range.end));
      return deleteId;
    }

    if (token.text === 'print' || token.text === 'printf') {
      const keywordToken = advance();
      const printId = createNode('PrintStmt', rangeBetween(keywordToken.range.start, 0), {
        op: keywordToken.text,
      });
      expect('(', `after '${keywordToken.text}'`);
      if (!check(')')) {
        attach(printId, parseAssign());
        while (match(',')) attach(printId, parseAssign());
      }
      expect(')', `to close the '${keywordToken.text}' argument list`);
      const semi = expect(';', `after '${keywordToken.text}'`);
      setRange(printId, rangeBetween(keywordToken.range.start, semi.range.end));
      return printId;
    }

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

    if (isTypeStart(current())) {
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
      (token.text === '-' ||
        token.text === '+' ||
        token.text === '!' ||
        token.text === '++' ||
        token.text === '--' ||
        token.text === '&' ||
        token.text === '*')
    ) {
      advance();
      const unaryId = createNode('UnaryOperator', rangeBetween(token.range.start, 0), {
        op: `prefix${token.text}`,
      });
      attach(unaryId, parseUnary());
      const operandId = nodes[unaryId].childIds[0];
      setRange(unaryId, rangeBetween(token.range.start, nodes[operandId].range.end));
      return unaryId;
    }

    if (token !== undefined && token.text === 'sizeof') {
      advance();
      expect('(', "after 'sizeof'");
      const spec = parseTypeSpec("after '(' in sizeof");
      let stars = 0;
      while (match('*')) stars += 1;
      const close = expect(')', "to close 'sizeof'");
      return createNode('SizeOfExpr', rangeBetween(token.range.start, close.range.end), {
        typeRef: { base: spec.base, tag: spec.tag, stars, dims: [] },
      });
    }

    if (token !== undefined && token.text === 'new') {
      const newToken = advance();
      const spec = parseTypeSpec("after 'new'");
      const typeRef: TypeRef = { base: spec.base, tag: spec.tag, stars: 0, dims: [] };
      if (check('[')) {
        advance();
        const countId = parseExpression();
        const close = expect(']', 'to close the new[] count');
        const newId = createNode(
          'NewExpr',
          rangeBetween(newToken.range.start, close.range.end),
          { op: 'new[]', typeRef },
        );
        attach(newId, countId);
        return newId;
      }
      return createNode('NewExpr', rangeBetween(newToken.range.start, spec.token.range.end), {
        op: 'new',
        typeRef,
      });
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
      if (token !== undefined && token.text === '[') {
        advance();
        const indexId = parseExpression();
        const close = expect(']', 'to close the subscript');
        const subscriptId = createNode(
          'ArraySubscriptExpr',
          rangeBetween(nodes[currentId].range.start, close.range.end),
        );
        attach(subscriptId, currentId);
        attach(subscriptId, indexId);
        currentId = subscriptId;
        continue;
      }
      if (token !== undefined && (token.text === '.' || token.text === '->')) {
        advance();
        const memberToken = expectIdentifier(`after '${token.text}'`);
        const memberId = createNode(
          'MemberExpr',
          rangeBetween(nodes[currentId].range.start, memberToken.range.end),
          { op: token.text, name: memberToken.text },
        );
        attach(memberId, currentId);
        currentId = memberId;
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
    if (token.kind === 'string-literal') {
      advance();
      const raw = token.text;
      const body = raw.length >= 2 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
      return createNode('StringLiteral', token.range, { stringValue: decodeEscapes(body) });
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
