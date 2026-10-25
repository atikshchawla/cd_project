'use client';

import { Badge } from '@/components/ui/badge';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import { OPT_ORIGINAL_MISSING, OPT_PROVENANCE_NOTE, explainChange, passLabel } from '@/content/optExplanations';
import type { OptChange } from '@/lib/compiler';
import { renderInstr } from '@/lib/compiler/irprint';
import { useWorkspaceStore } from '@/lib/store';

/**
 * The four-part explanation of one recorded transformation:
 *
 *   original instruction → optimised result → why it happened → why it is safe.
 *
 * The before/after lines are **derived**: rendered straight from the two IR
 * modules by ID. The reason and safety notes are **illustrative** hand-written
 * prose (they are provenance-badged as such in the UI). This component is
 * shared by the Optimization stage and the explanation panel so both always
 * say exactly the same thing about a change.
 */
export function ChangeDetail({ change }: { change: OptChange }) {
  const result = useWorkspaceStore((state) => state.result);
  const optimization = useWorkspaceStore((state) => state.optimization);

  const originalModule = result?.ir?.module ?? null;
  if (originalModule === null || optimization === null) {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        There is no optimisation result to explain right now.
      </p>
    );
  }

  const optimisedModule = optimization.module;
  const before =
    change.beforeInstrId === null ? undefined : originalModule.instrs[change.beforeInstrId];
  const after =
    change.afterInstrId === null ? undefined : optimisedModule.instrs[change.afterInstrId];

  const rewrittenAll = change.relatedInstrIds
    .map((instrId) => optimisedModule.instrs[instrId])
    .filter((instr) => instr !== undefined);
  const rewritten = rewrittenAll.slice(0, 3);

  const afterText =
    after !== undefined
      ? renderInstr(optimisedModule, after)
      : before !== undefined && change.facts.variant === 'constant-folded'
        ? `${before.result ?? ''} = ${change.facts.value}`
        : 'removed';

  const sourceNode = change.astNodeId !== null ? result?.ast?.nodes[change.astNodeId] : undefined;
  const narrative = explainChange(change);
  const facts = change.facts;

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="derived" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {passLabel(change.pass)}
        </Badge>
        <span className="text-xs text-muted-foreground">{OPT_PROVENANCE_NOTE}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Original
          </h4>
          <code className="block overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-xs leading-5">
            {before !== undefined ? renderInstr(originalModule, before) : OPT_ORIGINAL_MISSING}
          </code>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Result
          </h4>
          <code className="block overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-xs leading-5">
            {afterText}
          </code>
        </div>
      </div>

      {rewritten.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Uses that now read the value directly ({rewrittenAll.length})
          </h4>
          <ul className="flex flex-col gap-1">
            {rewritten.map((instr) => (
              <li key={instr.id}>
                <code className="block overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-xs leading-5">
                  {renderInstr(optimisedModule, instr)}
                </code>
              </li>
            ))}
            {rewrittenAll.length > rewritten.length ? (
              <li className="text-xs text-muted-foreground">
                …and {rewrittenAll.length - rewritten.length} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      {sourceNode !== undefined && result !== null ? (
        <p className="text-xs leading-5 text-muted-foreground">
          <span className="font-medium">Source: </span>
          <code className="rounded bg-background px-1 py-0.5 font-mono text-foreground">
            {result.source.slice(sourceNode.range.start, sourceNode.range.end)}
          </code>
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          Control-flow bookkeeping — no single source expression.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Why it happened
          </h4>
          <ProvenanceBadge kind="illustrative" />
        </div>
        <p className="text-sm leading-6">{narrative.reason}</p>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Why it is safe
          </h4>
          <ProvenanceBadge kind="illustrative" />
        </div>
        <p className="text-sm leading-6">{narrative.safety}</p>
      </div>

      {facts.variant === 'branch-folded' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          The untaken block is left in the module: it is simply no longer reached from here.
        </p>
      ) : null}
    </div>
  );
}
