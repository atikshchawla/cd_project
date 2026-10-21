'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Brackets,
  Calculator,
  FileCode,
  Hash,
  KeyRound,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ProvenanceBadge } from '@/components/shell/ProvenanceBadge';
import {
  STALE_SELECTION_NOTE,
  TOKEN_COUNT_LABEL,
  TOKEN_EMPTY,
  TOKEN_FILTER_LABEL,
  TOKEN_KIND_EXPLANATIONS,
  TOKEN_KIND_ORDER,
  TOKEN_LEGEND_TITLE,
  TOKEN_LIMIT_NOTICE,
} from '@/content/explanations';
import { computeHighlights, createEmptyHighlights, selectionTint } from '@/lib/highlight';
import { useWorkspaceStore } from '@/lib/store';
import type { Token, TokenKind } from '@/lib/compiler/types';
import { cn } from '@/lib/utils';

const TOKEN_LIMIT = 2000;

const KIND_ICONS: Record<TokenKind, LucideIcon> = {
  keyword: KeyRound,
  identifier: Tag,
  'integer-literal': Hash,
  operator: Calculator,
  punctuator: Brackets,
  directive: FileCode,
};

type KindFilter = TokenKind | 'all';

const EMPTY_TOKENS: Token[] = [];

export function TokenExplorer() {
  const result = useWorkspaceStore((state) => state.result);
  const selection = useWorkspaceStore((state) => state.selection);
  const stale = useWorkspaceStore((state) => state.stale);
  const select = useWorkspaceStore((state) => state.select);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const tokens = result?.tokens ?? EMPTY_TOKENS;
  const filteredTokens = useMemo(
    () => (kindFilter === 'all' ? tokens : tokens.filter((token) => token.kind === kindFilter)),
    [tokens, kindFilter],
  );
  const visibleTokens = useMemo(() => filteredTokens.slice(0, TOKEN_LIMIT), [filteredTokens]);

  const highlights = useMemo(
    () => (stale ? createEmptyHighlights() : computeHighlights(selection, result)),
    [selection, result, stale],
  );
  const tintClass = useMemo(() => `tint-${selectionTint(selection, result)}`, [selection, result]);

  const selectedTokenId = selection.kind === 'token' ? selection.tokenId : null;
  const hasSelection = selection.kind !== 'none' && !stale;

  useEffect(() => {
    if (stale || selection.kind !== 'source' || selection.origin !== 'editor') return;
    const index = visibleTokens.findIndex((token) => highlights.tokenIds.has(token.id));
    if (index >= 0) {
      rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
    }
  }, [stale, selection, visibleTokens, highlights]);

  const focusRow = (index: number) => {
    const bounded = Math.max(0, Math.min(index, visibleTokens.length - 1));
    rowRefs.current[bounded]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusRow(visibleTokens.length - 1);
    }
  };

  const lexFailed = result?.completed.lex === 'failed';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceBadge kind="generated" />
        <Badge variant="outline" className="font-mono text-[0.7rem]">
          {filteredTokens.length} {TOKEN_COUNT_LABEL}
        </Badge>
        {lexFailed ? (
          <Badge variant="destructive" className="text-[0.7rem]">
            Lexical errors
          </Badge>
        ) : null}
        <div className="ml-auto">
          <Select
            value={kindFilter}
            onValueChange={(value) => setKindFilter(value as KindFilter)}
          >
            <SelectTrigger
              className="w-[13rem]"
              aria-label={TOKEN_FILTER_LABEL}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {TOKEN_KIND_ORDER.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {TOKEN_KIND_EXPLANATIONS[kind].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {stale ? (
        <p role="status" className="rounded-md border border-amber-700/30 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-950">
          {STALE_SELECTION_NOTE}
        </p>
      ) : null}

      {lexFailed ? (
        <p className="text-xs leading-5 text-muted-foreground">
          The lexer reported errors. Tokens produced before the error are still shown here.
        </p>
      ) : null}

      {visibleTokens.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-6 text-sm text-muted-foreground">
          {tokens.length === 0
            ? TOKEN_EMPTY
            : 'No tokens match this kind filter.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div
            aria-hidden="true"
            className="grid grid-cols-[minmax(5.5rem,7rem)_minmax(0,1fr)_4.5rem_3.5rem] gap-2 border-b border-border bg-muted/50 px-2 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            <span>Kind</span>
            <span>Text</span>
            <span>Line:col</span>
            <span className="text-right">Length</span>
          </div>
          <div className="max-h-[28rem] overflow-y-auto">
            {visibleTokens.map((token, index) => {
              const kindMeta = TOKEN_KIND_EXPLANATIONS[token.kind];
              const KindIcon = KIND_ICONS[token.kind];
              const isPrimary = selectedTokenId === token.id;
              const isRelated = !isPrimary && highlights.tokenIds.has(token.id);
              const isUnrelated = hasSelection && !isPrimary && !isRelated;

              return (
                <button
                  key={token.id}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  type="button"
                  aria-pressed={isPrimary}
                  onClick={() =>
                    select({ kind: 'token', tokenId: token.id, origin: 'stage' })
                  }
                  onKeyDown={(event) => onRowKeyDown(event, index)}
                  className={cn(
                    'grid w-full grid-cols-[minmax(5.5rem,7rem)_minmax(0,1fr)_4.5rem_3.5rem] items-center gap-2 border-b border-border/60 px-2 py-1.5 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    isPrimary && cn('sel-primary', tintClass),
                    isRelated && 'sel-related',
                    isUnrelated && 'opacity-80',
                  )}
                >
                  <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[0.7rem] font-medium">
                    <KindIcon aria-hidden="true" className="size-3" />
                    {kindMeta.label}
                  </span>
                  <code
                    className="truncate font-mono text-[0.8rem]"
                    title={token.text}
                  >
                    {token.text}
                  </code>
                  <span className="font-mono text-[0.75rem] text-foreground/70">
                    {token.line}:{token.col}
                  </span>
                  <span className="text-right font-mono text-[0.75rem] text-foreground/70">
                    {token.text.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {filteredTokens.length > TOKEN_LIMIT ? (
        <p className="text-xs leading-5 text-muted-foreground">{TOKEN_LIMIT_NOTICE}</p>
      ) : null}

      <details className="rounded-md border border-border bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {TOKEN_LEGEND_TITLE}
        </summary>
        <dl className="grid gap-2 pt-2 sm:grid-cols-2">
          {TOKEN_KIND_ORDER.map((kind) => {
            const meta = TOKEN_KIND_EXPLANATIONS[kind];
            const Icon = KIND_ICONS[kind];
            return (
              <div key={kind} className="flex items-start gap-2">
                <dt className="inline-flex shrink-0 items-center gap-1 text-xs font-medium">
                  <Icon aria-hidden="true" className="size-3.5" />
                  {meta.label}
                </dt>
                <dd className="text-xs leading-5 text-muted-foreground">{meta.simple}</dd>
              </div>
            );
          })}
        </dl>
      </details>
    </div>
  );
}
