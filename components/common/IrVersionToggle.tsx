'use client';

import { OPT_VERSION_HEADING } from '@/content/optExplanations';
import { useWorkspaceStore, type IrVersion } from '@/lib/store';
import { cn } from '@/lib/utils';

const VERSIONS: { id: IrVersion; label: string }[] = [
  { id: 'original', label: 'Original' },
  { id: 'optimized', label: 'Optimised' },
];

/**
 * Original / Optimised switch used by the Assembly and Execution stages.
 *
 * Both stages keep working from the IR: switching just decides which of the
 * two modules they lower or interpret. `aria-pressed` and the background carry
 * the state, so it never depends on colour alone.
 */
export function IrVersionToggle() {
  const irVersion = useWorkspaceStore((state) => state.irVersion);
  const setIrVersion = useWorkspaceStore((state) => state.setIrVersion);
  const optimization = useWorkspaceStore((state) => state.optimization);

  if (optimization === null) return null;

  return (
    <div
      role="group"
      aria-label={OPT_VERSION_HEADING}
      className="ml-auto flex items-center gap-1 rounded border border-border bg-background p-0.5"
    >
      <span className="px-1 text-xs text-muted-foreground">{OPT_VERSION_HEADING}</span>
      {VERSIONS.map((version) => {
        const active = irVersion === version.id;
        return (
          <button
            key={version.id}
            type="button"
            aria-pressed={active}
            onClick={() => setIrVersion(version.id)}
            className={cn(
              'rounded px-2 py-0.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active
                ? 'bg-stage-opt/15 font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            {version.label}
          </button>
        );
      })}
    </div>
  );
}
