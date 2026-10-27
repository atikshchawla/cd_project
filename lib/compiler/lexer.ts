import type { Diagnostic, Range, Token, TokenKind } from './types';

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

const KEYWORDS = new Set([
  // Supported Mini-C keywords.
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
  // Reserved words that the parser reports as unsupported (E1010).
  'char',
  'float',
  'double',
  'long',
  'unsigned',
  'switch',
  'case',
  'default',
  'goto',
  'typedef',
  'enum',
  'static',
  'const',
  'do',
  'class',
  'namespace',
  'template',
]);

const TWO_CHAR_OPERATORS = new Set([
  '++',
  '--',
  '->',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
]);

const ONE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '!', '&']);
const PUNCTUATORS = new Set(['(', ')', '{', '}', '[', ']', ';', ',', '.']);

const UNSUPPORTED_CHARACTER_MESSAGES: Record<string, string> = {
  '|': 'The | operator is not supported. Mini-C supports || but not bitwise or operators.',
  '^': 'The ^ operator is not supported. Mini-C has no bitwise operators.',
  '~': 'The ~ operator is not supported. Mini-C has no bitwise operators.',
  '?': 'The ternary ?: operator is not supported. Use if/else instead.',
  ':': 'The : punctuator is not supported. Mini-C has no labels, ternary expressions or bitfields.',
  "'": 'Character literals are not supported. Mini-C has int, void and format strings only.',
  '\\': 'Escape sequences and line continuations are not supported in Mini-C source.',
  '@': 'This character is not part of Mini-C syntax.',
  '$': 'This character is not part of Mini-C syntax.',
  '`': 'This character is not part of Mini-C syntax.',
};

const MAX_INT_LITERAL = 2147483647;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isIdentifierStart(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_')
  );
}

function isIdentifierPart(char: string | undefined): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function isAtLineStart(text: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && (text[cursor] === ' ' || text[cursor] === '\t')) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === '\n';
}

/**
 * Lex a Mini-C program.
 *
 * The input is normalised to LF line endings first. The function is total: it
 * always returns the tokens and diagnostics produced so far and never throws.
 * Whitespace and comments are not tokens.
 */
export function tokenize(source: string): LexResult {
  const text = typeof source === 'string' ? source.replace(/\r\n?/g, '\n') : '';
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];

  let index = 0;
  let line = 1;
  let col = 1;

  const advance = (count = 1) => {
    for (let step = 0; step < count && index < text.length; step += 1) {
      if (text[index] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      index += 1;
    }
  };

  const makeRange = (start: number, end: number): Range => ({ start, end });

  const pushToken = (
    kind: TokenKind,
    start: number,
    startLine: number,
    startCol: number,
  ): Token => {
    const tokenText = text.slice(start, index);
    const token: Token = {
      id: tokens.length,
      kind,
      text: tokenText,
      range: makeRange(start, index),
      line: startLine,
      col: startCol,
      endLine: line,
      endCol: col,
    };
    tokens.push(token);
    return token;
  };

  const pushDiagnostic = (
    code: string,
    stage: Diagnostic['stage'],
    message: string,
    start: number,
    end: number,
    notes?: Diagnostic['notes'],
  ) => {
    diagnostics.push({
      id: diagnostics.length + 1,
      severity: 'error',
      code,
      stage,
      message,
      range: makeRange(start, end),
      ...(notes ? { notes } : {}),
    });
  };

  while (index < text.length) {
    const char = text[index];

    // Whitespace.
    if (char === ' ' || char === '\t' || char === '\n') {
      advance();
      continue;
    }

    // Line comment.
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') {
        advance();
      }
      continue;
    }

    // Block comment.
    if (char === '/' && text[index + 1] === '*') {
      const start = index;
      advance(2);
      let terminated = false;
      while (index < text.length) {
        if (text[index] === '*' && text[index + 1] === '/') {
          advance(2);
          terminated = true;
          break;
        }
        advance();
      }
      if (!terminated) {
        pushDiagnostic(
          'E1002',
          'lex',
          'Unterminated block comment. Close it with */.',
          start,
          text.length,
        );
      }
      continue;
    }

    // Preprocessor directive line.
    if (char === '#') {
      if (!isAtLineStart(text, index)) {
        pushDiagnostic('E1001', 'lex', "Invalid character '#'.", index, index + 1);
        advance();
        continue;
      }

      const start = index;
      const startLine = line;
      const startCol = col;
      const lineEnd = text.indexOf('\n', index);
      const end = lineEnd === -1 ? text.length : lineEnd;
      const lineText = text.slice(start, end);
      const tokenText = lineText.replace(/[ \t]+$/, '');

      advance(tokenText.length);
      pushToken('directive', start, startLine, startCol);

      if (!/^#[ \t]*include[ \t]*<[^>\n]*>[ \t]*(?:\/\/.*)?$/.test(tokenText)) {
        pushDiagnostic(
          'E1010',
          'unsupported',
          'This preprocessor directive is not supported. Mini-C only accepts #include <...> lines, which are ignored.',
          start,
          start + tokenText.length,
        );
      }
      continue;
    }

    // Integer literal.
    if (isDigit(char)) {
      const start = index;
      const startLine = line;
      const startCol = col;
      while (isDigit(text[index])) {
        advance();
      }
      const token = pushToken('integer-literal', start, startLine, startCol);
      const value = Number(token.text);
      if (!Number.isFinite(value) || value > MAX_INT_LITERAL) {
        pushDiagnostic(
          'E1004',
          'lex',
          `Integer literal ${token.text} is too large for a 32-bit int. The maximum is 2147483647.`,
          token.range.start,
          token.range.end,
        );
      }
      continue;
    }

    // String literal: a printf format such as "%d\n". The parser decodes the
    // escapes; the token keeps the exact source text so ranges stay honest.
    if (char === '"') {
      const start = index;
      const startLine = line;
      const startCol = col;
      advance();
      let terminated = false;
      while (index < text.length && text[index] !== '\n') {
        if (text[index] === '\\' && index + 1 < text.length) {
          advance(2);
          continue;
        }
        if (text[index] === '"') {
          advance();
          terminated = true;
          break;
        }
        advance();
      }
      pushToken('string-literal', start, startLine, startCol);
      if (!terminated) {
        pushDiagnostic(
          'E1003',
          'lex',
          'Unterminated string literal: this " was never closed before the end of the line.',
          start,
          index,
        );
      }
      continue;
    }

    // Identifier or keyword.
    if (isIdentifierStart(char)) {
      const start = index;
      const startLine = line;
      const startCol = col;
      while (isIdentifierPart(text[index])) {
        advance();
      }
      const word = text.slice(start, index);
      pushToken(KEYWORDS.has(word) ? 'keyword' : 'identifier', start, startLine, startCol);
      continue;
    }

    // Operators, longest match first.
    const pair = text.slice(index, index + 2);
    if (TWO_CHAR_OPERATORS.has(pair)) {
      const start = index;
      const startLine = line;
      const startCol = col;
      advance(2);
      pushToken('operator', start, startLine, startCol);
      continue;
    }

    if (ONE_CHAR_OPERATORS.has(char)) {
      const start = index;
      const startLine = line;
      const startCol = col;
      advance();
      pushToken('operator', start, startLine, startCol);
      continue;
    }

    if (PUNCTUATORS.has(char)) {
      const start = index;
      const startLine = line;
      const startCol = col;
      advance();
      pushToken('punctuator', start, startLine, startCol);
      continue;
    }

    // Explicitly unsupported printable characters.
    const message = UNSUPPORTED_CHARACTER_MESSAGES[char];
    if (message !== undefined) {
      pushDiagnostic('E1010', 'unsupported', message, index, index + 1);
      advance();
      continue;
    }

    // Control characters, non-ASCII characters and anything else unrecognised.
    const codePoint = text.codePointAt(index) ?? 0;
    pushDiagnostic(
      'E1001',
      'lex',
      `Invalid character U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} in source.`,
      index,
      index + 1,
    );
    advance();
  }

  return { tokens, diagnostics };
}
