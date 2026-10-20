import type { CompileResult, Stage } from '@/lib/compiler/types';
import { SOURCE_LIMIT_CHARS, SOURCE_LIMIT_LINES } from '@/content/explanations';

export type StageStatus = 'ready' | 'ok' | 'warnings' | 'failed' | 'blocked' | 'stale';

/** Whether the source exceeds the visualizer's size cap (§8 robustness). */
export function sourceTooLarge(source: string): boolean {
  if (source.length > SOURCE_LIMIT_CHARS) return true;
  const lines = source.length === 0 ? 1 : source.split('\n').length;
  return lines > SOURCE_LIMIT_LINES;
}

/** Stage status rules from the spec (§8). */
export function deriveStageStatus(
  stage: Stage,
  result: CompileResult | null,
  stale: boolean,
): StageStatus {
  if (stage === 'asm') return 'blocked'; // "Coming soon": always unavailable
  if (result === null) return 'ready';
  if (stage === 'source') return 'ok';
  if (stale) return 'stale';
  return result.completed[stage];
}

/** The stage that reported a given diagnostic (for tab switching, §7.2). */
export function stageOfDiagnostic(result: CompileResult, diagnosticId: number): Stage | null {
  const diagnostic = result.diagnostics.find((candidate) => candidate.id === diagnosticId);
  if (diagnostic === undefined) return null;
  switch (diagnostic.stage) {
    case 'lex':
      return 'lex';
    case 'unsupported':
      // E1010 comes from the lexer (bad characters) or the parser (reserved
      // words); the first failing stage tells us which.
      return result.completed.lex === 'failed' ? 'lex' : 'parse';
    case 'parse':
      return 'parse';
    case 'sema':
      return 'sema';
    default:
      return null;
  }
}

/** The stage of the first error reported by a compile, if any (§9 step 3). */
export function firstErrorStage(result: CompileResult | null): Stage | null {
  if (result === null) return null;
  const firstError = result.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (firstError === undefined) return null;
  return stageOfDiagnostic(result, firstError.id);
}
