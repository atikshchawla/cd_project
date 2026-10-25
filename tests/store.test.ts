import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExampleById } from '@/content/examples';
import { normaliseSource, OPT_PASS_ORDER } from '@/lib/compiler';
import { hashSource } from '@/lib/hash';
import { INITIAL_WORKSPACE_DATA, useWorkspaceStore } from '@/lib/store';

function resetStore() {
  useWorkspaceStore.setState({ ...INITIAL_WORKSPACE_DATA }, false);
}

describe('workspace store', () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty with no selection and the source stage active', () => {
    const state = useWorkspaceStore.getState();
    expect(state.source).toBe('');
    expect(state.result).toBeNull();
    expect(state.selection).toEqual({ kind: 'none' });
    expect(state.activeStage).toBe('source');
    expect(state.compileStatus).toBe('idle');
    expect(state.stale).toBe(false);
  });

  it('loads an example and enables reset', () => {
    const example = getExampleById('variables-arithmetic');
    expect(example).not.toBeNull();

    useWorkspaceStore.getState().loadExample('variables-arithmetic');
    const state = useWorkspaceStore.getState();

    expect(state.exampleId).toBe('variables-arithmetic');
    expect(state.source).toBe(example?.code);
    expect(state.compileStatus).toBe('idle');
    expect(state.result).toBeNull();
  });

  it('ignores an unknown example id', () => {
    useWorkspaceStore.getState().loadExample('does-not-exist');
    expect(useWorkspaceStore.getState().source).toBe('');
    expect(useWorkspaceStore.getState().exampleId).toBeNull();
  });

  it('restores the selected example after edits', () => {
    const example = getExampleById('if-else');
    useWorkspaceStore.getState().loadExample('if-else');
    useWorkspaceStore.getState().setSource('int main() { return 1; }');

    useWorkspaceStore.getState().resetExample();

    expect(useWorkspaceStore.getState().source).toBe(example?.code);
    expect(useWorkspaceStore.getState().result).toBeNull();
    expect(useWorkspaceStore.getState().compileStatus).toBe('idle');
  });

  it('keeps the selection when switching stages', () => {
    useWorkspaceStore
      .getState()
      .select({ kind: 'token', tokenId: 7, origin: 'stage' });
    useWorkspaceStore.getState().setActiveStage('parse');

    expect(useWorkspaceStore.getState().activeStage).toBe('parse');
    expect(useWorkspaceStore.getState().selection).toEqual({
      kind: 'token',
      tokenId: 7,
      origin: 'stage',
    });
  });

  it('activates the assembly and execution stages', () => {
    useWorkspaceStore.getState().setActiveStage('asm');
    expect(useWorkspaceStore.getState().activeStage).toBe('asm');

    useWorkspaceStore.getState().setActiveStage('sim');
    expect(useWorkspaceStore.getState().activeStage).toBe('sim');
  });

  it('runs the pipeline one stage at a time in step-through mode', () => {
    useWorkspaceStore.getState().setSource('int main() { return 42; }');
    useWorkspaceStore.getState().startStepThrough();

    expect(useWorkspaceStore.getState().stepMode).toBe(true);
    expect(useWorkspaceStore.getState().stepReached).toBeNull();
    expect(useWorkspaceStore.getState().result).toBeNull();

    useWorkspaceStore.getState().advanceStep();
    expect(useWorkspaceStore.getState().stepReached).toBe('lex');
    expect(useWorkspaceStore.getState().activeStage).toBe('lex');
    expect(useWorkspaceStore.getState().result?.tokens.length).toBeGreaterThan(0);
    expect(useWorkspaceStore.getState().result?.ast).toBeNull();

    useWorkspaceStore.getState().advanceStep();
    expect(useWorkspaceStore.getState().stepReached).toBe('parse');
    expect(useWorkspaceStore.getState().result?.ast).not.toBeNull();
    expect(useWorkspaceStore.getState().result?.ir).toBeNull();

    useWorkspaceStore.getState().runUntil('asm');
    expect(useWorkspaceStore.getState().stepReached).toBe('asm');
    expect(useWorkspaceStore.getState().activeStage).toBe('asm');
    expect(useWorkspaceStore.getState().result?.asm).not.toBeNull();
    expect(useWorkspaceStore.getState().result?.completed.sim).toBe('ok');

    useWorkspaceStore.getState().stopStepThrough();
    expect(useWorkspaceStore.getState().stepMode).toBe(false);
    expect(useWorkspaceStore.getState().stepReached).toBeNull();
  });

  it('advancing past the last stage is a no-op', () => {
    useWorkspaceStore.getState().setSource('int main() { return 1; }');
    useWorkspaceStore.getState().startStepThrough();
    useWorkspaceStore.getState().runUntil('asm');

    const before = useWorkspaceStore.getState().result;
    useWorkspaceStore.getState().advanceStep();

    expect(useWorkspaceStore.getState().stepReached).toBe('asm');
    expect(useWorkspaceStore.getState().result).toBe(before);
  });

  it('exits step-through mode on a full compile', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { return 0; }');
    useWorkspaceStore.getState().startStepThrough();
    useWorkspaceStore.getState().advanceStep();

    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    const state = useWorkspaceStore.getState();
    expect(state.stepMode).toBe(false);
    expect(state.stepReached).toBeNull();
    expect(state.result?.completed).toMatchObject({ asm: 'ok', sim: 'ok' });
  });

  it('shows a compiling state, then stores the stub result', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().loadExample('variables-arithmetic');
    const source = useWorkspaceStore.getState().source;

    useWorkspaceStore.getState().compileSource();

    expect(useWorkspaceStore.getState().compileStatus).toBe('compiling');
    expect(useWorkspaceStore.getState().result).toBeNull();

    vi.runAllTimers();

    const state = useWorkspaceStore.getState();
    expect(state.compileStatus).toBe('compiled');
    expect(state.result).not.toBeNull();
    expect(state.result?.source).toBe(normaliseSource(source));
    expect(state.result?.sourceHash).toBe(hashSource(normaliseSource(source)));
    expect(state.stale).toBe(false);
  });

  it('marks results stale when the source changes after compiling', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().loadExample('if-else');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    useWorkspaceStore.getState().setSource('int main() { return 2; }');

    expect(useWorkspaceStore.getState().stale).toBe(true);
    expect(useWorkspaceStore.getState().selection).toEqual({ kind: 'none' });
  });

  it('clears the stale flag when the source matches the compiled snapshot again', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().loadExample('if-else');
    const compiledSource = useWorkspaceStore.getState().source;
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    useWorkspaceStore.getState().setSource('int main() { return 2; }');
    expect(useWorkspaceStore.getState().stale).toBe(true);

    useWorkspaceStore.getState().setSource(compiledSource);
    expect(useWorkspaceStore.getState().stale).toBe(false);
  });

  it('ignores an in-flight compile when a different example is loaded', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().loadExample('if-else');
    useWorkspaceStore.getState().compileSource();
    useWorkspaceStore.getState().loadExample('while-loop');

    vi.runAllTimers();

    expect(useWorkspaceStore.getState().result).toBeNull();
    expect(useWorkspaceStore.getState().compileStatus).toBe('idle');
  });

  it('switches to the reporting stage when a diagnostic is selected (§7.2)', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { return unknownName; }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    const result = useWorkspaceStore.getState().result!;
    const semaDiagnostic = result.diagnostics.find(
      (diagnostic) => diagnostic.stage === 'sema',
    )!;
    useWorkspaceStore.getState().setActiveStage('source');

    useWorkspaceStore
      .getState()
      .select({ kind: 'diagnostic', diagnosticId: semaDiagnostic.id, origin: 'stage' });

    expect(useWorkspaceStore.getState().activeStage).toBe('sema');
    expect(useWorkspaceStore.getState().selection).toEqual({
      kind: 'diagnostic',
      diagnosticId: semaDiagnostic.id,
      origin: 'stage',
    });
  });

  it('switches to the first error stage after compiling (§9)', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setActiveStage('ir');
    useWorkspaceStore.getState().setSource('int main() { return 1 }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    expect(useWorkspaceStore.getState().activeStage).toBe('parse');

    // A clean compile keeps the current tab.
    useWorkspaceStore.getState().setActiveStage('sema');
    useWorkspaceStore.getState().setSource('int main() { return 0; }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    expect(useWorkspaceStore.getState().activeStage).toBe('sema');
  });

  it('refuses to compile a source over the size limit', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { return 0; }'.padEnd(20001, 'x'));

    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    expect(useWorkspaceStore.getState().compileStatus).toBe('idle');
    expect(useWorkspaceStore.getState().result).toBeNull();
  });

  it('optimises the compiled IR and keeps the original module untouched', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { int a = 2 * 3 + 1; return a; }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    const state = useWorkspaceStore.getState();
    expect(state.result?.ir).not.toBeNull();
    expect(state.optimization).not.toBeNull();
    expect(state.optimization?.enabledPasses).toEqual([...OPT_PASS_ORDER]);
    expect(state.optimization?.changes.length).toBeGreaterThan(0);
    expect(state.irVersion).toBe('original');

    // The optimiser works on a clone: the compiler's own module is never touched.
    const originalJson = JSON.stringify(state.result?.ir?.module);
    expect(JSON.stringify(useWorkspaceStore.getState().result?.ir?.module)).toBe(originalJson);
    expect(state.optimization?.module).not.toBe(state.result?.ir?.module);

    useWorkspaceStore.getState().setIrVersion('optimized');
    expect(useWorkspaceStore.getState().irVersion).toBe('optimized');
    expect(JSON.stringify(useWorkspaceStore.getState().result?.ir?.module)).toBe(originalJson);
  });

  it('re-runs the passes and clears a stale change selection when a pass is toggled', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { int a = 2 * 3 + 1; return a; }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();

    const changeId = useWorkspaceStore.getState().optimization!.changes[0]!.id;
    useWorkspaceStore.getState().select({ kind: 'opt', changeId, origin: 'stage' });
    expect(useWorkspaceStore.getState().selection).toEqual({
      kind: 'opt',
      changeId,
      origin: 'stage',
    });

    useWorkspaceStore.getState().toggleOptPass('folding');

    const after = useWorkspaceStore.getState();
    expect(after.enabledPasses).not.toContain('folding');
    expect(after.optimization?.enabledPasses).not.toContain('folding');
    expect(after.optimization?.changes.some((change) => change.pass === 'folding')).toBe(false);
    expect(after.selection).toEqual({ kind: 'none' });
    expect(after.result).not.toBeNull();
  });

  it('resets the optimisation and IR version when a new compile starts', () => {
    vi.useFakeTimers();
    useWorkspaceStore.getState().setSource('int main() { return 1; }');
    useWorkspaceStore.getState().compileSource();
    vi.runAllTimers();
    useWorkspaceStore.getState().setIrVersion('optimized');

    useWorkspaceStore.getState().compileSource();

    expect(useWorkspaceStore.getState().optimization).toBeNull();
    expect(useWorkspaceStore.getState().irVersion).toBe('original');

    vi.runAllTimers();
    expect(useWorkspaceStore.getState().optimization).not.toBeNull();
    expect(useWorkspaceStore.getState().irVersion).toBe('original');
  });
});
