import { create } from 'zustand';
import { compile, normaliseSource } from '@/lib/compiler';
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
  | { kind: 'diagnostic'; diagnosticId: number; origin: Origin };

// Later: 'irblock' | 'asm' | 'sim'.

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
}

interface WorkspaceActions {
  setSource: (source: string) => void;
  loadExample: (id: string) => void;
  resetExample: () => void;
  select: (selection: Selection) => void;
  setActiveStage: (stage: Stage) => void;
  compileSource: () => void;
  setAboutOpen: (open: boolean) => void;
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
};

/** Invalidates an in-flight compile when the workspace loads different text. */
let compileRequest = 0;

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
    if (stage === 'asm') return;
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
}));
