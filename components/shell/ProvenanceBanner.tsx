'use client';

import { Info } from 'lucide-react';
import { ABOUT_STATEMENT } from '@/content/explanations';
import { ProvenanceBadge } from './ProvenanceBadge';

export function ProvenanceBanner() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <Info aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">
        {ABOUT_STATEMENT}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <ProvenanceBadge kind="generated" />
        <ProvenanceBadge kind="derived" />
        <ProvenanceBadge kind="illustrative" />
        <ProvenanceBadge kind="simulated" />
      </div>
    </div>
  );
}
