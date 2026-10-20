import { hashSource } from '@/lib/hash';
import { tokenize } from './lexer';
import { parse } from './parser';
import { analyse } from './sema';
import { generateIR } from './irgen';
import { printIR } from './irprint';
import type { CompileResult, Diagnostic } from './types';

export * from './types';

export const COMPILER_VERSION = '0.1';
export const COMPILER_TARGET = 'Mini-C (educational)';

/** The compiler normalises line endings before every stage. */
export function normaliseSource(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

function internalFailure(): Diagnostic {
  return {
    id: 1,
    severity: 'error',
    code: 'E9999',
    stage: 'internal',
    message: 'The compiler hit an internal error and could not analyse this program.',
    range: { start: 0, end: 0 },
  };
}

/** Re-number stage-local diagnostics so IDs stay globally unique. */
function renumber(diagnostics: Diagnostic[], startId: number): Diagnostic[] {
  return diagnostics.map((diagnostic, index) => ({ ...diagnostic, id: startId + index }));
}

/**
 * Compile a Mini-C program through every implemented stage: lexical analysis,
 * parsing, semantic analysis and IR generation. The assembly stage is not
 * implemented, so `asm` is always null.
 *
 * The function is pure, synchronous and total: it never throws.
 */
export function compile(source: string): CompileResult {
  const normalised = typeof source === 'string' ? normaliseSource(source) : '';
  const base: CompileResult = {
    sourceHash: hashSource(normalised),
    source: normalised,
    tokens: [],
    ast: null,
    symbols: null,
    diagnostics: [],
    ir: null,
    asm: null,
    completed: {
      source: 'ok',
      lex: 'blocked',
      parse: 'blocked',
      sema: 'blocked',
      ir: 'blocked',
      asm: 'blocked',
    },
    meta: {
      compilerVersion: COMPILER_VERSION,
      target: COMPILER_TARGET,
      flags: ['-O0'],
      elapsedMs: 0, // reserved: wall-clock timing would break determinism
    },
  };

  try {
    const lexed = tokenize(normalised);
    const lexFailed = lexed.diagnostics.some((diagnostic) => diagnostic.severity === 'error');

    if (lexFailed) {
      return {
        ...base,
        tokens: lexed.tokens,
        diagnostics: lexed.diagnostics,
        completed: { ...base.completed, lex: 'failed' },
      };
    }

    const parsed = parse(lexed.tokens, normalised);
    const parseFailed = parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    const afterParse: CompileResult = {
      ...base,
      tokens: lexed.tokens,
      ast: parsed.ast,
      diagnostics: [
        ...lexed.diagnostics,
        ...renumber(parsed.diagnostics, lexed.diagnostics.length + 1),
      ],
      completed: {
        ...base.completed,
        lex: 'ok',
        parse: parseFailed ? 'failed' : 'ok',
      },
    };

    if (parseFailed || parsed.ast === null) return afterParse;

    // Semantic analysis: annotates the AST, builds the symbol table and
    // collects every semantic diagnostic.
    const analysed = analyse(parsed.ast);
    const semaFailed = analysed.diagnostics.some(
      (diagnostic) => diagnostic.severity === 'error',
    );
    const semaWarned = analysed.diagnostics.some(
      (diagnostic) => diagnostic.severity === 'warning',
    );
    const afterSema: CompileResult = {
      ...afterParse,
      symbols: { symbols: analysed.symbols, scopes: analysed.scopes },
      diagnostics: [
        ...afterParse.diagnostics,
        ...renumber(
          analysed.diagnostics,
          afterParse.diagnostics.length + 1,
        ),
      ],
      completed: {
        ...afterParse.completed,
        sema: semaFailed ? 'failed' : semaWarned ? 'warnings' : 'ok',
        ir: semaFailed ? 'blocked' : 'ok',
      },
    };

    if (semaFailed) return afterSema;

    // IR generation: only when there are no errors (warnings are fine).
    const irModule = generateIR(parsed.ast);
    const lines = printIR(irModule);
    return { ...afterSema, ir: { module: irModule, lines } };
  } catch {
    return {
      ...base,
      diagnostics: [internalFailure()],
      completed: {
        source: 'failed',
        lex: 'failed',
        parse: 'failed',
        sema: 'blocked',
        ir: 'blocked',
        asm: 'blocked',
      },
    };
  }
}
