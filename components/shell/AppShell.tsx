'use client';

import { CircleHelp, ListStart, Play, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { STALE_BANNER } from '@/content/explanations';
import { ExplanationPanel } from '@/components/common/ExplanationPanel';
import { EditorPanel } from '@/components/editor/EditorPanel';
import { ExamplePicker } from '@/components/editor/ExamplePicker';
import { AboutDialog } from './AboutDialog';
import { ResizablePanes } from './ResizablePanes';
import { StageNavigator } from './StageNavigator';
import { StageWorkspace } from './StageWorkspace';
import { StatusBar } from './StatusBar';
import { ThemeToggle } from './ThemeToggle';
import { useThemeSync } from './theme';
import { useWorkspaceStore } from '@/lib/store';
import { sourceTooLarge } from '@/lib/status';

/**
 * IDE-style shell (SPEC target layout): compact top bar (48px) + stage
 * stepper (56px) + two resizable panes + footer status bar (24px).
 * At ≥1024px the page itself never scrolls — each pane scrolls internally.
 * Below 1024px the panes stack and the page scrolls normally.
 */
export function AppShell() {
  const compileSource = useWorkspaceStore((state) => state.compileSource);
  const compileStatus = useWorkspaceStore((state) => state.compileStatus);
  const stale = useWorkspaceStore((state) => state.stale);
  const source = useWorkspaceStore((state) => state.source);
  const setAboutOpen = useWorkspaceStore((state) => state.setAboutOpen);
  const stepMode = useWorkspaceStore((state) => state.stepMode);
  const startStepThrough = useWorkspaceStore((state) => state.startStepThrough);
  const isCompiling = compileStatus === 'compiling';
  const tooLarge = sourceTooLarge(source);
  useThemeSync();

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-background lg:h-dvh lg:min-h-0 lg:overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <h1 className="mr-1 shrink-0 text-sm font-semibold leading-none">
            Mini-C Compiler Visualizer
          </h1>

          <div className="min-w-0 flex-1">
            <ExamplePicker />
          </div>

          <Button
            type="button"
            size="sm"
            className="h-8"
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
            size="sm"
            variant={stepMode ? 'default' : 'secondary'}
            className="h-8"
            onClick={() => startStepThrough()}
            disabled={isCompiling || tooLarge}
            title="Compile one stage at a time and watch each artifact appear"
          >
            <ListStart aria-hidden="true" />
            Step through
          </Button>

          <ThemeToggle />

          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => setAboutOpen(true)}
          >
            <CircleHelp aria-hidden="true" />
            About
          </Button>
        </header>

        <StageNavigator />

        {stale ? (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-xs leading-5"
          >
            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warn" />
            <p className="min-w-0 flex-1">{STALE_BANNER}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={compileSource}
              className="h-7 shrink-0"
            >
              Recompile
            </Button>
          </div>
        ) : null}

        <main className="min-h-0 flex-1">
          <ResizablePanes
            left={
              <div className="h-full min-h-0 overflow-y-auto p-3">
                <EditorPanel />
              </div>
            }
            right={
              <div className="flex h-full min-h-0 flex-col gap-3 p-3">
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <StageWorkspace />
                </div>
                <div className="max-h-[45%] shrink-0 overflow-y-auto">
                  <ExplanationPanel />
                </div>
              </div>
            }
          />
        </main>

        <AboutDialog />
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
