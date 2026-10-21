import { describe, expect, it } from 'vitest';
import { compile, compileUpTo } from '@/lib/compiler';
import type { CompileResult, Stage } from '@/lib/compiler/types';
import { SOURCE_LIMIT_CHARS, SOURCE_LIMIT_LINES } from '@/content/explanations';
import {
  deriveStageStatus,
  firstErrorStage,
  sourceTooLarge,
  stageOfDiagnostic,
} from '@/lib/status';

function compiledStatuses(source: string): CompileResult {
  return compile(source);
}

const ALL_PIPELINE_STAGES: Stage[] = ['lex', 'parse', 'sema', 'ir', 'asm', 'sim'];

describe('deriveStageStatus (spec §8 table)', () => {
  it('reports ready for every stage before the first compile', () => {
    for (const stage of ALL_PIPELINE_STAGES) {
      expect(deriveStageStatus(stage, null, false)).toBe('ready');
    }
  });

  it('reports ok for the source stage whenever a result exists', () => {
    expect(deriveStageStatus('source', compiledStatuses('int main() { return 0; }'), false)).toBe('ok');
  });

  it('reports stale when results are out of date', () => {
    const result = compiledStatuses('int main() { return 0; }');
    for (const stage of ALL_PIPELINE_STAGES) {
      expect(deriveStageStatus(stage, result, true)).toBe('stale');
    }
  });

  it('follows the lexical-error row: lex failed, later stages blocked', () => {
    const result = compiledStatuses('int main() { return @; }');
    expect(deriveStageStatus('lex', result, false)).toBe('failed');
    expect(deriveStageStatus('parse', result, false)).toBe('blocked');
    expect(deriveStageStatus('sema', result, false)).toBe('blocked');
    expect(deriveStageStatus('ir', result, false)).toBe('blocked');
  });

  it('follows the syntax-error row: lex ok, parse failed, later blocked', () => {
    const result = compiledStatuses('int main() { return 1 }');
    expect(deriveStageStatus('lex', result, false)).toBe('ok');
    expect(deriveStageStatus('parse', result, false)).toBe('failed');
    expect(deriveStageStatus('sema', result, false)).toBe('blocked');
    expect(deriveStageStatus('ir', result, false)).toBe('blocked');
  });

  it('follows the semantic-error row: sema failed, ir blocked', () => {
    const result = compiledStatuses('int main() { return unknownName; }');
    expect(deriveStageStatus('lex', result, false)).toBe('ok');
    expect(deriveStageStatus('parse', result, false)).toBe('ok');
    expect(deriveStageStatus('sema', result, false)).toBe('failed');
    expect(deriveStageStatus('ir', result, false)).toBe('blocked');
  });

  it('follows the warnings row: sema warnings, ir ok', () => {
    const result = compiledStatuses('int main() { int unused = 1; return 0; }');
    expect(deriveStageStatus('sema', result, false)).toBe('warnings');
    expect(deriveStageStatus('ir', result, false)).toBe('ok');
  });

  it('follows the clean row: everything ok', () => {
    const result = compiledStatuses('int main() { return 0; }');
    for (const stage of ALL_PIPELINE_STAGES) {
      expect(deriveStageStatus(stage, result, false)).toBe('ok');
    }
  });

  it('reports ready for assembly and execution before the first compile', () => {
    expect(deriveStageStatus('asm', null, false)).toBe('ready');
    expect(deriveStageStatus('sim', null, false)).toBe('ready');
  });

  it('follows the failure rows through assembly and execution', () => {
    const parseError = compiledStatuses('int main() { return 1 }');
    expect(deriveStageStatus('asm', parseError, false)).toBe('blocked');
    expect(deriveStageStatus('sim', parseError, false)).toBe('blocked');

    const semaError = compiledStatuses('int main() { return unknownName; }');
    expect(deriveStageStatus('asm', semaError, false)).toBe('blocked');
    expect(deriveStageStatus('sim', semaError, false)).toBe('blocked');
  });

  it('reports pending for stages the stepper has not reached', () => {
    const result = compiledStatuses('int main() { return 0; }');

    // Before the first step nothing has run.
    expect(deriveStageStatus('lex', result, false, 'lex')).toBe('ok');
    expect(deriveStageStatus('parse', result, false, 'lex')).toBe('pending');
    expect(deriveStageStatus('asm', result, false, 'lex')).toBe('pending');
    expect(deriveStageStatus('asm', result, false, 'ir')).toBe('pending');
    // Execution runs the IR lazily in the UI, so it is available the moment
    // the IR exists — stepping past 'ir' does not mark it pending.
    expect(deriveStageStatus('sim', result, false, 'ir')).toBe('ok');
  });

  it('never reports pending for a stage that itself failed', () => {
    const result = compiledStatuses('int main() { return 1 }');

    // The stepper stopped at lex, but parse already failed: failed, not pending.
    expect(deriveStageStatus('parse', result, false, 'lex')).toBe('failed');
  });

  it('reports blocked for later stages when an earlier stage failed while stepping', () => {
    const parseRan = compileUpTo('int main() { return 1 }', 'parse');

    expect(deriveStageStatus('parse', parseRan, false, 'parse')).toBe('failed');
    expect(deriveStageStatus('sema', parseRan, false, 'parse')).toBe('blocked');
    expect(deriveStageStatus('asm', parseRan, false, 'parse')).toBe('blocked');
  });

  it('treats a null step-reached as "not stepping" and reports compiled status', () => {
    const result = compiledStatuses('int main() { return 0; }');
    expect(deriveStageStatus('parse', result, false, null)).toBe('ok');
  });
});

describe('stageOfDiagnostic (tab switching, §7.2)', () => {
  it('maps lexical errors to the lex stage', () => {
    const result = compiledStatuses('int main() { return @; }');
    const diagnostic = result.diagnostics[0];
    expect(stageOfDiagnostic(result, diagnostic.id)).toBe('lex');
  });

  it('maps parse errors to the parse stage', () => {
    const result = compiledStatuses('int main() { return 1 }');
    const diagnostic = result.diagnostics[0];
    expect(stageOfDiagnostic(result, diagnostic.id)).toBe('parse');
  });

  it('maps semantic errors to the sema stage', () => {
    const result = compiledStatuses('int main() { return unknownName; }');
    const diagnostic = result.diagnostics[0];
    expect(stageOfDiagnostic(result, diagnostic.id)).toBe('sema');
  });

  it('returns null for unknown diagnostic ids', () => {
    const result = compiledStatuses('int main() { return 0; }');
    expect(stageOfDiagnostic(result, 999)).toBeNull();
  });
});

describe('firstErrorStage (compile flow, §9)', () => {
  it('returns the stage of the first error', () => {
    expect(firstErrorStage(compiledStatuses('int main() { return 1 }'))).toBe('parse');
    expect(firstErrorStage(compiledStatuses('int main() { return unknownName; }'))).toBe('sema');
  });

  it('returns null when there are no errors (clean or warnings only)', () => {
    expect(firstErrorStage(compiledStatuses('int main() { return 0; }'))).toBeNull();
    expect(
      firstErrorStage(compiledStatuses('int main() { int unused = 1; return 0; }')),
    ).toBeNull();
  });

  it('returns null for a null result', () => {
    expect(firstErrorStage(null)).toBeNull();
  });
});

describe('sourceTooLarge (§8 limits)', () => {
  it('accepts sources within the limits', () => {
    expect(sourceTooLarge('')).toBe(false);
    expect(sourceTooLarge('int main() { return 0; }')).toBe(false);
    expect(sourceTooLarge('x'.repeat(SOURCE_LIMIT_CHARS))).toBe(false);
    expect(sourceTooLarge(Array(SOURCE_LIMIT_LINES).fill('int x;').join('\n'))).toBe(false);
  });

  it('rejects sources over the character or line limit', () => {
    expect(sourceTooLarge('x'.repeat(SOURCE_LIMIT_CHARS + 1))).toBe(true);
    expect(sourceTooLarge(Array(SOURCE_LIMIT_LINES + 1).fill('int x;').join('\n'))).toBe(true);
  });
});
