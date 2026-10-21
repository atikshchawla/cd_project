import { create } from 'zustand';
import { compile, compileUpTo, normaliseSource, PIPELINE_STAGES } from '@/lib/compiler';
import type { CompileResult, Range, Stage } from '@/lib/compiler/types';
import { hashSource } from '@/lib/hash';
import { getExampleById } from '@/content/examples';
import { firstErrorStage, sourceTooLarge, stageOfDiagnostic } from '@/lib/status';

export type Origin = 'editor' | 'stage';

export type Selection =
  | { kind: 'none' }
  | { kind: 'source'; range: Range; origin: Origin }
  | { kind: 'token'; tokenId: number; origin: Origin }
  | { kind: 'ast'; nodeId: number; origin: Origin }
  | { kind: 'symbol'; symbolId: number; origin: Origin }
  | { kind: 'ir'; instrId: number; origin: Origin }
  | { kind: 'asm'; lineId: number; origin: Origin }
  | { kind: 'diagnostic'; diagnosticId: number; origin: Origin };

// Later: 'irblock' | 'sim'.

export type CompileStatus = 'idle' | 'compiling' | 'compiled';

export interface WorkspaceData {
  source: string;
  exampleId: string | null;
  result: CompileResult | null;
  selection: Selection;
  activeStage: Stage;
  compileStatus: CompileStatus;
  stale: boolean;
  aboutOpen: boolean;
  /** Step-through mode: compile one pipeline stage per user action. */
  stepMode: boolean;
  /** The furthest pipeline stage the stepper has run (null = none yet). */
  stepReached: Stage | null;
}

interface WorkspaceActions {
  setSource: (source: string) => void;
  loadExample: (id: string) => void;
  resetExample: () => void;
  select: (selection: Selection) => void;
  setActiveStage: (stage: Stage) => void;
  compileSource: () => void;
  setAboutOpen: (open: boolean) => void;
  /** Enter step-through mode and run nothing yet. */
  startStepThrough: () => void;
  /** Leave step-through mode; the next Compile runs the whole pipeline. */
  stopStepThrough: () => void;
  /** Run the next un-run pipeline stage (lex → parse → sema → ir → asm). */
  advanceStep: () => void;
  /** Run pipeline stages until `stage` has been reached (or the pipeline stops). */
  runUntil: (stage: Stage) => void;
}

export type WorkspaceState = WorkspaceData & WorkspaceActions;

export const INITIAL_WORKSPACE_DATA: WorkspaceData = {
  source: '',
  exampleId: null,
  result: null,
  selection: { kind: 'none' },
  activeStage: 'source',
  compileStatus: 'idle',
  stale: false,
  aboutOpen: false,
  stepMode: false,
  stepReached: null,
};

/** Invalidates an in-flight compile when the workspace loads different text. */
let compileRequest = 0;

/** The next pipeline stage after `reached`, or null when the pipeline ended. */
function nextPipelineStage(reached: Stage | null): Stage | null {
  if (reached === null) return PIPELINE_STAGES[0] ?? null;
  const index = PIPELINE_STAGES.indexOf(reached);
  if (index === -1 || index === PIPELINE_STAGES.length - 1) return null;
  return PIPELINE_STAGES[index + 1] ?? null;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  ...INITIAL_WORKSPACE_DATA,

  setSource: (source) => {
    const { result } = get();
    const stale =
      result !== null &&
      hashSource(normaliseSource(source)) !== result.sourceHash;
    set({
      source,
      stale,
      selection: { kind: 'none' },
    });
  },

  loadExample: (id) => {
    const example = getExampleById(id);
    if (example === null) return;
    compileRequest += 1;
    set({
      source: example.code,
      exampleId: example.id,
      result: null,
      selection: { kind: 'none' },
      compileStatus: 'idle',
      stale: false,
      stepMode: false,
      stepReached: null,
    });
  },

  resetExample: () => {
    const example = getExampleById(get().exampleId);
    if (example === null) return;
    compileRequest += 1;
    set({
      source: example.code,
      result: null,
      selection: { kind: 'none' },
      compileStatus: 'idle',
      stale: false,
      stepMode: false,
      stepReached: null,
    });
  },

  select: (selection) => {
    // §7.2: selecting a diagnostic switches to the stage that reported it.
    if (selection.kind === 'diagnostic') {
      const { result } = get();
      const stage = result === null ? null : stageOfDiagnostic(result, selection.diagnosticId);
      set(stage === null ? { selection } : { selection, activeStage: stage });
      return;
    }
    set({ selection });
  },

  setActiveStage: (stage) => {
    set({ activeStage: stage });
  },

  compileSource: () => {
    // §8 limits: refuse to compile an oversized program; the editor shows why.
    if (sourceTooLarge(get().source)) return;

    const request = ++compileRequest;
    const source = get().source;
    set({
      compileStatus: 'compiling',
      result: null,
      selection: { kind: 'none' },
      stale: false,
      stepMode: false,
      stepReached: null,
    });

    // Let the "Compiling…" state paint before the synchronous compiler runs.
    setTimeout(() => {
      if (request !== compileRequest) return;
      const result = compile(source);
      // §9 step 3: switch to the first error's stage, else keep the current tab.
      const errorStage = firstErrorStage(result);
      set({
        result,
        compileStatus: 'compiled',
        stale: hashSource(normaliseSource(get().source)) !== result.sourceHash,
        ...(errorStage === null ? {} : { activeStage: errorStage }),
      });
    }, 0);
  },

  setAboutOpen: (open) => set({ aboutOpen: open }),

  startStepThrough: () => {
    if (sourceTooLarge(get().source)) return;
    compileRequest += 1;
    set({
      stepMode: true,
      stepReached: null,
      result: null,
      compileStatus: 'idle',
      selection: { kind: 'none' },
      stale: false,
      activeStage: 'source',
    });
  },

  stopStepThrough: () => {
    set({ stepMode: false, stepReached: null });
  },

  advanceStep: () => {
    const { stepMode, stepReached, source } = get();
    if (!stepMode || sourceTooLarge(source)) return;
    const next = nextPipelineStage(stepReached);
    if (next === null) return;

    const result = compileUpTo(source, next);
    set({
      result,
      compileStatus: 'compiled',
      selection: { kind: 'none' },
      stale: hashSource(normaliseSource(source)) !== result.sourceHash,
      stepReached: next,
      activeStage: next,
    });
  },

  runUntil: (stage) => {
    const { stepMode, stepReached, source } = get();
    if (!stepMode) return;
    const targetIndex = PIPELINE_STAGES.indexOf(stage);
    if (targetIndex === -1) return;
    const reachedIndex = stepReached === null ? -1 : PIPELINE_STAGES.indexOf(stepReached);
    if (targetIndex <= reachedIndex) {
      set({ activeStage: stage });
      return;
    }
    const result = compileUpTo(source, stage);
    set({
      result,
      compileStatus: 'compiled',
      selection: { kind: 'none' },
      stale: hashSource(normaliseSource(source)) !== result.sourceHash,
      stepReached: stage,
      activeStage: stage,
    });
  },
}));
