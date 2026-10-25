import { hashSource } from '@/lib/hash';
import { tokenize } from './lexer';
import { parse } from './parser';
import { analyse } from './sema';
import { generateIR } from './irgen';
import { printIR } from './irprint';
import { generateAsm } from './asmgen';
import type { CompileResult, Diagnostic, Stage } from './types';

export * from './types';
export {
  OPT_PASS_ORDER,
  findChangeForInstruction,
  optimizeModule,
  verifyModule,
} from './optimize';
export type {
  OptChange,
  OptChangeFacts,
  OptChangeKind,
  OptPassId,
  OptPassState,
  OptPassStatus,
  OptRowStatus,
  OptimizationResult,
} from './optimize/types';

export const COMPILER_VERSION = '0.1';
export const COMPILER_TARGET = 'Mini-C (educational)';

/** The compiler stages that consume source, in pipeline order. */
export const PIPELINE_STAGES: Stage[] = ['lex', 'parse', 'sema', 'ir', 'asm'];

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
 * Compile a Mini-C program up to (and including) the given stage. Used by
 * the full `compile()` and by the step-through mode, which runs one stage at
 * a time. The execution stage (`sim`) interprets the IR lazily in the UI, so
 * the furthest stage this function can produce is `asm`.
 *
 * The function is pure, synchronous and total: it never throws.
 */
export function compileUpTo(source: string, upTo: Stage): CompileResult {
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
      opt: 'blocked',
      asm: 'blocked',
      sim: 'blocked',
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

    const afterLex: CompileResult = {
      ...base,
      tokens: lexed.tokens,
      diagnostics: lexed.diagnostics,
      completed: { ...base.completed, lex: 'ok' },
    };
    if (upTo === 'lex') return afterLex;

    const parsed = parse(lexed.tokens, normalised);
    const parseFailed = parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    const afterParse: CompileResult = {
      ...afterLex,
      ast: parsed.ast,
      diagnostics: [
        ...lexed.diagnostics,
        ...renumber(parsed.diagnostics, lexed.diagnostics.length + 1),
      ],
      completed: { ...afterLex.completed, parse: parseFailed ? 'failed' : 'ok' },
    };

    if (parseFailed || parsed.ast === null) return afterParse;
    if (upTo === 'parse') return afterParse;

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
      },
    };

    if (semaFailed) return afterSema;
    if (upTo === 'sema') return afterSema;

    // IR generation: only when there are no errors (warnings are fine).
    const irModule = generateIR(parsed.ast);
    const lines = printIR(irModule);
    const afterIr: CompileResult = {
      ...afterSema,
      ir: { module: irModule, lines },
      // The execution stage interprets this IR lazily in the UI; it is
      // available exactly when the IR is. The Optimization stage derives its
      // output from this IR, so it opens up at the same moment.
      completed: { ...afterSema.completed, ir: 'ok', opt: 'ok', sim: 'ok' },
    };
    if (upTo === 'ir') return afterIr;

    // Assembly lowering: naive x86-64 text with exact IR mapping.
    const asm = generateAsm(irModule);
    return { ...afterIr, asm, completed: { ...afterIr.completed, asm: 'ok' } };
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
        opt: 'blocked',
        asm: 'blocked',
        sim: 'blocked',
      },
    };
  }
}

/**
 * Compile a Mini-C program through every implemented compile stage:
 * lexical analysis, parsing, semantic analysis, IR generation and
 * assembly lowering. The execution stage interprets the IR in the UI.
 */
export function compile(source: string): CompileResult {
  return compileUpTo(source, 'asm');
}
