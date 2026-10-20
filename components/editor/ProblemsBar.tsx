'use client';

import { useMemo } from 'react';
import { CircleCheck, CircleX, TriangleAlert } from 'lucide-react';
import { DiagnosticList } from '@/components/common/DiagnosticList';
import {
  DIAGNOSTICS_EMPTY,
  DIAGNOSTICS_NONE_YET,
  diagnosticCountLabel,
} from '@/content/explanations';
import { useWorkspaceStore } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * Problems bar below the editor (§8): counts of errors and warnings plus the
 * shared diagnostics list. Empty states distinguish "not compiled yet" from
 * "compiled clean".
 */
export function ProblemsBar() {
  const result = useWorkspaceStore((state) => state.result);
  const compileStatus = useWorkspaceStore((state) => state.compileStatus);

  const { errors, warnings } = useMemo(() => {
    const diagnostics = result?.diagnostics ?? [];
    return {
      errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
      warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning'),
    };
  }, [result]);

  const total = errors.length + warnings.length;

  return (
    <section
      aria-label="Compiler problems"
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Problems</h2>
        {result === null ? null : (
          <>
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                errors.length > 0 ? 'text-red-700' : 'text-muted-foreground',
              )}
            >
              <CircleX aria-hidden="true" className="size-3.5" />
              {diagnosticCountLabel(errors.length, 'error')}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs font-medium',
                warnings.length > 0 ? 'text-amber-700' : 'text-muted-foreground',
              )}
            >
              <TriangleAlert aria-hidden="true" className="size-3.5" />
              {diagnosticCountLabel(warnings.length, 'warning')}
            </span>
          </>
        )}
        {result !== null && total === 0 && compileStatus === 'compiled' ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
            <CircleCheck aria-hidden="true" className="size-3.5" />
            {DIAGNOSTICS_EMPTY}
          </span>
        ) : null}
      </div>

      {result === null ? (
        <p className="text-xs leading-5 text-muted-foreground">{DIAGNOSTICS_NONE_YET}</p>
      ) : total > 0 ? (
        <DiagnosticList diagnostics={[...errors, ...warnings]} />
      ) : null}
    </section>
  );
}
