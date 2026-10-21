'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { STAGE_CRASH_BODY, STAGE_CRASH_RELOAD, STAGE_CRASH_TITLE } from '@/content/explanations';

interface StageErrorBoundaryProps {
  children: ReactNode;
}

interface StageErrorBoundaryState {
  error: Error | null;
}

/**
 * Error boundary around the stage workspace (§8 robustness): a crash in one
 * stage view must not take down the app. The source and compile result are
 * untouched; switching stages remounts the boundary via its `key` in the
 * parent, and Reload is offered as a last resort.
 */
export class StageErrorBoundary extends Component<
  StageErrorBoundaryProps,
  StageErrorBoundaryState
> {
  state: StageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StageErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a console record for debugging; nothing is sent anywhere.
    console.error('Stage workspace error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        className="flex min-h-48 flex-col items-start justify-center gap-3 rounded-md border border-red-700/30 bg-red-50 p-6"
      >
        <div className="flex items-center gap-2">
          <TriangleAlert aria-hidden="true" className="size-5 text-red-800" />
          <h3 className="text-sm font-semibold text-red-950">{STAGE_CRASH_TITLE}</h3>
        </div>
        <p className="max-w-prose text-sm leading-6 text-red-950">{STAGE_CRASH_BODY}</p>
        <code className="font-mono text-xs text-red-900/80">{error.message}</code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="border-red-700/30 bg-surface/60 text-red-950 hover:bg-surface"
          onClick={() => window.location.reload()}
        >
          {STAGE_CRASH_RELOAD}
        </Button>
      </div>
    );
  }
}
