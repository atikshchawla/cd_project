'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ABOUT_STATEMENT,
  PROVENANCE,
  STAGE_EXPLANATIONS,
  STAGE_ORDER,
} from '@/content/explanations';
import { useWorkspaceStore } from '@/lib/store';
import { ProvenanceBadge } from './ProvenanceBadge';

export function AboutDialog() {
  const aboutOpen = useWorkspaceStore((state) => state.aboutOpen);
  const setAboutOpen = useWorkspaceStore((state) => state.setAboutOpen);

  return (
    <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>About this visualizer</DialogTitle>
          <DialogDescription>{ABOUT_STATEMENT}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-sm leading-6">
          <section className="flex flex-col gap-1.5">
            <h3 className="font-semibold">The pipeline</h3>
            <ol className="flex flex-wrap gap-1.5">
              {STAGE_ORDER.map((stage) => (
                <li key={stage}>
                  <span className="rounded border border-border bg-muted/50 px-2 py-0.5 text-xs">
                    {STAGE_EXPLANATIONS[stage].label}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-muted-foreground">
              Every item is linked to the other stages with IDs and source ranges, never by
              comparing text. Missing links are shown as unavailable rather than guessed.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-semibold">Provenance</h3>
            <ul className="flex flex-col gap-1.5">
              {(['generated', 'derived', 'illustrative'] as const).map((kind) => (
                <li key={kind} className="flex items-start gap-2">
                  <ProvenanceBadge kind={kind} className="mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{PROVENANCE[kind].description}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
