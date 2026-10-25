import type { CompileResult, Stage } from '@/lib/compiler/types';
import { SOURCE_LIMIT_CHARS, SOURCE_LIMIT_LINES } from '@/content/explanations';
import { PIPELINE_STAGES } from '@/lib/compiler';

export type StageStatus = 'ready' | 'ok' | 'warnings' | 'failed' | 'blocked' | 'stale' | 'pending';

/** Whether the source exceeds the visualizer's size cap (§8 robustness). */
export function sourceTooLarge(source: string): boolean {
  if (source.length > SOURCE_LIMIT_CHARS) return true;
  const lines = source.length === 0 ? 1 : source.split('\n').length;
  return lines > SOURCE_LIMIT_LINES;
}

/**
 * Stage status rules from the spec (§8), extended for the execution stage and
 * step-through mode: a stage the stepper has not reached yet is `pending`
 * unless an earlier stage failed (then it is `blocked`).
 */
export function deriveStageStatus(
  stage: Stage,
  result: CompileResult | null,
  stale: boolean,
  stepReached?: Stage | null,
): StageStatus {
  if (result === null) return 'ready';
  if (stage === 'source') return 'ok';
  if (stale) return 'stale';

  if (stepReached !== undefined && stepReached !== null) {
    const reachedIndex = PIPELINE_STAGES.indexOf(stepReached);
    // The Optimization stage is not a pipeline step of its own: it is derived
    // from the IR, so it lights up exactly when the IR does.
    const stageIndex = PIPELINE_STAGES.indexOf(stage === 'opt' ? 'ir' : stage);
    if (stageIndex > reachedIndex && stageIndex !== -1) {
      const earlierFailed = PIPELINE_STAGES.slice(0, stageIndex).some(
        (candidate) => result.completed[candidate] === 'failed',
      );
      // Pending only for stages that simply have not run yet; a stage that
      // reported a failure keeps its `failed` status.
      if (!earlierFailed && result.completed[stage] !== 'failed') return 'pending';
    }
  }

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
