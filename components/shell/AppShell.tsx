'use client';

import { CircleHelp, Play, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { STALE_BANNER } from '@/content/explanations';
import { ExplanationPanel } from '@/components/common/ExplanationPanel';
import { EditorPanel } from '@/components/editor/EditorPanel';
import { ExamplePicker } from '@/components/editor/ExamplePicker';
import { AboutDialog } from './AboutDialog';
import { ProvenanceBanner } from './ProvenanceBanner';
import { SettingsStrip } from './SettingsStrip';
import { StageNavigator } from './StageNavigator';
import { StageWorkspace } from './StageWorkspace';
import { useWorkspaceStore } from '@/lib/store';
import { sourceTooLarge } from '@/lib/status';

export function AppShell() {
  const compileSource = useWorkspaceStore((state) => state.compileSource);
  const compileStatus = useWorkspaceStore((state) => state.compileStatus);
  const stale = useWorkspaceStore((state) => state.stale);
  const source = useWorkspaceStore((state) => state.source);
  const setAboutOpen = useWorkspaceStore((state) => state.setAboutOpen);
  const isCompiling = compileStatus === 'compiling';
  const tooLarge = sourceTooLarge(source);

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-muted/20">
        <header className="border-b border-border bg-background">
          <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3">
            <div className="mr-auto min-w-0">
              <h1 className="text-base font-semibold leading-6">Mini-C Compiler Visualizer</h1>
              <p className="text-xs text-muted-foreground">
                Source → Tokens → AST → Semantic analysis → LLVM-style IR
              </p>
            </div>

            <ExamplePicker />

            <Button
              type="button"
              size="sm"
              onClick={compileSource}
              disabled={isCompiling || tooLarge}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              title={
                tooLarge
                  ? 'The program is too large to compile in this visualizer'
                  : 'Compile (Ctrl/Cmd + Enter)'
              }
            >
              <Play aria-hidden="true" />
              {isCompiling ? 'Compiling…' : 'Compile'}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAboutOpen(true)}
            >
              <CircleHelp aria-hidden="true" />
              About
            </Button>
          </div>
        </header>

        <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-3 px-4 py-4">
          <StageNavigator />
          <SettingsStrip />
          <ProvenanceBanner />

          {stale ? (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
              <p className="min-w-0 flex-1">{STALE_BANNER}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={compileSource}
                className="border-amber-700/30 bg-white/60 text-amber-950 hover:bg-white"
              >
                Recompile
              </Button>
            </div>
          ) : null}

          <main className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <EditorPanel />
            <div className="flex min-w-0 flex-col gap-4">
              <StageWorkspace />
              <ExplanationPanel />
            </div>
          </main>
        </div>

        <AboutDialog />
      </div>
    </TooltipProvider>
  );
}
