'use client';

import dynamic from 'next/dynamic';
import { useCallback, useMemo } from 'react';
import { ArrowRight, BookOpen, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProblemsBar } from '@/components/editor/ProblemsBar';
import {
  COMPILE_HINT,
  SOURCE_LIMIT_CHARS,
  SOURCE_LIMIT_MESSAGE,
  STAGE_EXPLANATIONS,
} from '@/content/explanations';
import { getExampleById } from '@/content/examples';
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { useWorkspaceStore } from '@/lib/store';
import { sourceTooLarge } from '@/lib/status';
import type { Range } from '@/lib/compiler/types';

const CodeEditor = dynamic(() => import('./CodeEditor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] w-full items-center justify-center rounded-md border border-border bg-muted/20 p-6 text-sm text-muted-foreground">
      Loading the code editor…
    </div>
  ),
});

function ExampleGuidance() {
  const exampleId = useWorkspaceStore((state) => state.exampleId);
  const setActiveStage = useWorkspaceStore((state) => state.setActiveStage);
  const example = getExampleById(exampleId);

  if (example === null) return null;
  const suggestedStage = STAGE_EXPLANATIONS[example.suggestedStage];

  return (
    <section
      aria-label="Example guidance"
      className="flex flex-col gap-2 rounded-md border border-sky-700/25 bg-sky-50 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen aria-hidden="true" className="size-4 text-sky-900" />
        <h2 className="text-sm font-semibold text-sky-950">{example.title}</h2>
        <Badge variant="outline" className="border-sky-700/30 bg-surface/60 text-sky-900">
          {example.category === 'learn' ? 'Learn' : 'Error'}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-sky-950">{example.objective}</p>
      <div className="flex flex-wrap items-center gap-1 text-xs text-sky-900">
        <span className="font-medium">Try this: open</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs font-semibold text-sky-950 underline decoration-sky-700/40 underline-offset-2"
          onClick={() => setActiveStage(example.suggestedStage)}
        >
          {suggestedStage.label}
          <ArrowRight aria-hidden="true" className="size-3" />
        </Button>
      </div>
      <p className="text-xs leading-5 text-sky-900/90">{example.explanation}</p>
    </section>
  );
}

export function EditorPanel() {
  const source = useWorkspaceStore((state) => state.source);
  const setSource = useWorkspaceStore((state) => state.setSource);
  const compileSource = useWorkspaceStore((state) => state.compileSource);
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const select = useWorkspaceStore((state) => state.select);
  const exampleId = useWorkspaceStore((state) => state.exampleId);
  const example = getExampleById(exampleId);

  const tooLarge = useMemo(() => sourceTooLarge(source), [source]);

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );

  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  const handleSourceSelection = useCallback(
    (range: Range) => {
      select({ kind: 'source', range, origin: 'editor' });
    },
    [select],
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Mini-C source</h2>
          <p className="text-xs text-muted-foreground">
            {example === null ? 'Example or your own program' : example.title}
          </p>
        </div>
        <p
          className={
            tooLarge
              ? 'font-mono text-[0.7rem] font-semibold text-red-700'
              : 'font-mono text-[0.7rem] text-muted-foreground'
          }
        >
          {source.length} / {SOURCE_LIMIT_CHARS.toLocaleString('en-US')} chars
        </p>
      </div>

      <ExampleGuidance />

      {tooLarge ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-700/30 bg-red-50 px-3 py-2 text-xs leading-5 text-red-950"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {SOURCE_LIMIT_MESSAGE}
        </p>
      ) : null}

      <CodeEditor
        value={source}
        onChange={setSource}
        onCompile={compileSource}
        onSourceSelection={handleSourceSelection}
        highlights={highlights}
        tokens={result?.tokens}
        diagnostics={result?.diagnostics}
        selectionOrigin={selection.kind === 'none' ? 'stage' : selection.origin}
        stale={stale}
        tintClass={tintClass}
      />

      <ProblemsBar />

      <p className="text-xs text-muted-foreground">{COMPILE_HINT}</p>
    </div>
  );
}
