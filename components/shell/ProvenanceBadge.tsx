'use client';

import { badgeVariants } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PROVENANCE, type ProvenanceKind } from '@/content/explanations';
import { cn } from '@/lib/utils';

const KIND_CLASSES: Record<ProvenanceKind, string> = {
  generated: 'border-emerald-700/30 bg-emerald-50 text-emerald-900',
  derived: 'border-sky-700/30 bg-sky-50 text-sky-900',
  illustrative: 'border-amber-700/30 bg-amber-50 text-amber-900',
};

export function ProvenanceBadge({
  kind,
  className,
}: {
  kind: ProvenanceKind;
  className?: string;
}) {
  const meta = PROVENANCE[kind];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeVariants({ variant: 'outline' }),
            'cursor-help font-mono text-[0.7rem] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            KIND_CLASSES[kind],
            className,
          )}
        >
          {meta.label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{meta.description}</TooltipContent>
    </Tooltip>
  );
}
