'use client';

import { useMemo } from 'react';
import { CircleX, Info, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DIAGNOSTIC_CODE_EXPLANATIONS,
  DIAGNOSTIC_CODE_LABEL,
  DIAGNOSTIC_LOCATION_LABEL,
  DIAGNOSTIC_RAW_LABEL,
  DIAGNOSTIC_STAGE_LABEL,
  DIAGNOSTIC_WHY_LABEL,
} from '@/content/explanations';
import { useWorkspaceStore } from '@/lib/store';
import { positionAt } from '@/lib/positions';
import type { Diagnostic, Diagnostic as DiagnosticType } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

const SEVERITY_ICONS = {
  error: CircleX,
  warning: TriangleAlert,
  note: Info,
} as const;

const SEVERITY_TEXT = {
  error: 'text-red-700',
  warning: 'text-amber-700',
  note: 'text-sky-700',
} as const;

const SEVERITY_BADGE = {
  error: 'border-red-700/40 bg-red-50 text-red-800',
  warning: 'border-amber-700/40 bg-amber-50 text-amber-900',
  note: 'border-sky-700/40 bg-sky-50 text-sky-900',
} as const;

export function diagnosticLocation(
  source: string,
  diagnostic: DiagnosticType,
): { line: number; col: number } {
  return positionAt(source, diagnostic.range.start);
}

/**
 * Shared diagnostics list (§8): severity icon + text, code, stage, line:col,
 * the message with raw details, and a short "Why this error?" explanation.
 * Rows are buttons; clicking selects the diagnostic (which also switches the
 * active tab to the reporting stage).
 */
export function DiagnosticList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);

  const source = result?.source ?? '';
  const selectedId = selection.kind === 'diagnostic' ? selection.diagnosticId : null;

  const rows = useMemo(
    () =>
      diagnostics.map((diagnostic) => ({
        diagnostic,
        location: diagnosticLocation(source, diagnostic),
        explanation: DIAGNOSTIC_CODE_EXPLANATIONS[diagnostic.code],
      })),
    [diagnostics, source],
  );

  return (
    <ul className="flex flex-col gap-2">
      {rows.map(({ diagnostic, location, explanation }) => {
        const SeverityIcon = SEVERITY_ICONS[diagnostic.severity];
        const isPrimary = selectedId === diagnostic.id;

        return (
          <li key={diagnostic.id}>
            <button
              type="button"
              aria-pressed={isPrimary}
              onClick={() => select({ kind: 'diagnostic', diagnosticId: diagnostic.id, origin: 'stage' })}
              className={cn(
                'flex w-full flex-col gap-1.5 rounded-md border border-border bg-background p-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring',
                isPrimary &&
                  'bg-amber-100 outline outline-2 -outline-offset-2 outline-amber-700',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', SEVERITY_TEXT[diagnostic.severity])}>
                  <SeverityIcon aria-hidden="true" className="size-3.5" />
                  {diagnostic.severity}
                </span>
                <Badge
                  variant="outline"
                  className={cn('font-mono text-[0.7rem]', SEVERITY_BADGE[diagnostic.severity])}
                >
                  {diagnostic.code}
                </Badge>
                <Badge variant="outline" className="font-mono text-[0.7rem]">
                  {diagnostic.stage}
                </Badge>
                <span className="font-mono text-[0.75rem] text-foreground/70">
                  {location.line}:{location.col}
                </span>
                {explanation !== undefined ? (
                  <span className="text-[0.75rem] text-muted-foreground">
                    {explanation.title}
                  </span>
                ) : null}
              </span>
              <span className="text-sm leading-5">{diagnostic.message}</span>
              {explanation !== undefined ? (
                <span className="text-xs leading-5 text-muted-foreground">
                  <span className="font-medium">{DIAGNOSTIC_WHY_LABEL}</span>{' '}
                  {explanation.why}
                </span>
              ) : null}
              {diagnostic.notes !== undefined && diagnostic.notes.length > 0 ? (
                <span className="flex flex-col gap-1 rounded border border-border bg-muted/40 p-2 text-xs leading-5">
                  <span className="font-medium">{DIAGNOSTIC_RAW_LABEL}</span>
                  <code className="font-mono">{diagnostic.code}: {diagnostic.message}</code>
                  {diagnostic.notes.map((note, index) => (
                    <span key={index} className="text-muted-foreground">
                      note: {note.message}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className="sr-only">
                {DIAGNOSTIC_CODE_LABEL} {diagnostic.code}, {DIAGNOSTIC_STAGE_LABEL}{' '}
                {diagnostic.stage}, {DIAGNOSTIC_LOCATION_LABEL} {location.line}:{location.col}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
