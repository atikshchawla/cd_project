'use client';

import { useEffect } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import { useWorkspaceStore } from '@/lib/store';

export function Workspace() {
  const compileSource = useWorkspaceStore((state) => state.compileSource);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key !== 'Enter') return;
      // The Monaco editor installs its own Ctrl/Cmd+Enter command.
      if (event.target instanceof Element && event.target.closest('.monaco-editor')) return;
      event.preventDefault();
      compileSource();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compileSource]);

  return <AppShell />;
}
