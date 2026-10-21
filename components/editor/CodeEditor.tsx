'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  createEmptyHighlights,
  type Highlights,
} from '@/lib/highlight';
import type { Origin } from '@/lib/store';
import type { Diagnostic, Range, Token } from '@/lib/compiler/types';
import { useThemeStore } from '@/components/shell/theme';

type EditorInstance = Parameters<OnMount>[0];
type MonacoApi = Parameters<OnMount>[1];
type DecorationsCollection = ReturnType<EditorInstance['createDecorationsCollection']>;

/** The next/font family name is hashed; read it from the CSS variable. */
function resolveMonoFamily(): string {
  if (typeof window === 'undefined') {
    return "'JetBrains Mono', ui-monospace, monospace";
  }
  const loaded = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-jetbrains-mono')
    .trim();
  return loaded.length > 0
    ? `${loaded}, ui-monospace, monospace`
    : "'JetBrains Mono', ui-monospace, monospace";
}

/** Define both app themes once per Monaco instance (before the editor mounts). */
function defineMiniCTopics(monaco: MonacoApi): void {
  monaco.editor.defineTheme('minic-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '5EEAD4' },
      { token: 'number', foreground: 'FBBF24' },
      { token: 'string', foreground: '34D399' },
      { token: 'comment', foreground: '93A0B8', fontStyle: 'italic' },
      { token: 'identifier', foreground: 'E6EAF2' },
      { token: 'delimiter', foreground: '93A0B8' },
    ],
    colors: {
      // --surface / --surface-2
      'editor.background': '#111827',
      'editor.lineHighlightBackground': '#172033',
      // --accent at 25%
      'editor.selectionBackground': '#5EEAD440',
      'editorCursor.foreground': '#5EEAD4',
      'editorLineNumber.foreground': '#93A0B8',
      'editorLineNumber.activeForeground': '#E6EAF2',
      'editorIndentGuide.background1': '#243049',
      'editorWhitespace.foreground': '#243049',
    },
  });
  monaco.editor.defineTheme('minic-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '0F766E' },
      { token: 'number', foreground: 'B45309' },
      { token: 'string', foreground: '047857' },
      { token: 'comment', foreground: '55627A', fontStyle: 'italic' },
      { token: 'identifier', foreground: '0F172A' },
      { token: 'delimiter', foreground: '55627A' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.lineHighlightBackground': '#EEF1F6',
      'editor.selectionBackground': '#0F766E40',
      'editorCursor.foreground': '#0F766E',
      'editorLineNumber.foreground': '#55627A',
      'editorLineNumber.activeForeground': '#0F172A',
      'editorIndentGuide.background1': '#DDE2EC',
      'editorWhitespace.foreground': '#DDE2EC',
    },
  });
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onCompile?: () => void;
  onSourceSelection?: (range: Range) => void;
  highlights?: Highlights;
  tokens?: Token[];
  diagnostics?: Diagnostic[];
  selectionOrigin?: Origin;
  stale?: boolean;
  /** Pastel tint class for the primary highlight, from the selected part. */
  tintClass?: string;
}

function rangeKey(range: Range): string {
  return `${range.start}:${range.end}`;
}

const EMPTY_TOKENS: Token[] = [];
const EMPTY_DIAGNOSTICS: Diagnostic[] = [];

export function CodeEditor({
  value,
  onChange,
  onCompile,
  onSourceSelection,
  highlights,
  tokens = EMPTY_TOKENS,
  diagnostics = EMPTY_DIAGNOSTICS,
  selectionOrigin = 'stage',
  stale = false,
  tintClass = '',
}: CodeEditorProps) {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const decorationsRef = useRef<DecorationsCollection | null>(null);
  const cursorDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const onCompileRef = useRef(onCompile);
  const onSourceSelectionRef = useRef(onSourceSelection);
  const onChangeRef = useRef(onChange);
  const [isReady, setIsReady] = useState(false);
  const resolvedTheme = useThemeStore((state) => state.resolved);

  useEffect(() => {
    onCompileRef.current = onCompile;
  }, [onCompile]);

  useEffect(() => {
    onSourceSelectionRef.current = onSourceSelection;
  }, [onSourceSelection]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      cursorDisposableRef.current?.dispose();
      decorationsRef.current?.clear();
    };
  }, []);

  const toMonacoRange = useCallback((range: Range) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (editor === null || monaco === null || !model) return null;

    const max = model.getValueLength();
    const start = Math.max(0, Math.min(range.start, max));
    const end = Math.max(0, Math.min(range.end, max));
    const startPosition = model.getPositionAt(Math.min(start, end));
    const endPosition = model.getPositionAt(Math.max(start, end));

    return new monaco.Range(
      startPosition.lineNumber,
      startPosition.column,
      endPosition.lineNumber,
      endPosition.column,
    );
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const model = editor.getModel();
    // The compiler and every stored range assume LF line endings.
    model?.setEOL(monaco.editor.EndOfLineSequence.LF);
    decorationsRef.current = editor.createDecorationsCollection([]);

    // Monaco renders on a canvas and cannot see Tailwind classes: give it the
    // real (hashed) JetBrains Mono family that next/font loaded.
    editor.updateOptions({ fontFamily: resolveMonoFamily() });

    // Monaco owns Ctrl/Cmd+Enter while the editor is focused, so its default
    // binding cannot swallow the compile shortcut.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onCompileRef.current?.();
    });

    // Caret and selection changes become source selections after a short pause.
    cursorDisposableRef.current = editor.onDidChangeCursorSelection(() => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        const currentModel = editor.getModel();
        const selection = editor.getSelection();
        if (!currentModel || !selection) return;
        const start = currentModel.getOffsetAt(selection.getStartPosition());
        const end = currentModel.getOffsetAt(selection.getEndPosition());
        onSourceSelectionRef.current?.({
          start: Math.min(start, end),
          end: Math.max(start, end),
        });
      }, 100);
    });

    setIsReady(true);

    // 7.4: sync the editor's text and compile it on mount.
    const mountedValue = model?.getValue() ?? '';
    onChangeRef.current(mountedValue);
    onCompileRef.current?.();
  };

  // Draw primary and related ranges. This never moves the caret.
  useEffect(() => {
    if (!isReady) return;
    const collection = decorationsRef.current;
    if (!collection) return;

    if (stale || selectionOrigin === 'editor') {
      collection.clear();
      return;
    }

    const activeHighlights = highlights ?? createEmptyHighlights();
    const decorations: Array<Parameters<DecorationsCollection['set']>[0][number]> = [];
    const primaryKeys = new Set<string>();
    const primaryClass = tintClass.length > 0 ? `hl-primary ${tintClass}` : 'hl-primary';

    for (const range of activeHighlights.sourceRanges) {
      const monacoRange = toMonacoRange(range);
      if (monacoRange === null) continue;
      primaryKeys.add(rangeKey(range));
      decorations.push({
        range: monacoRange,
        options: { inlineClassName: primaryClass },
      });
    }

    for (const token of tokens) {
      if (!activeHighlights.tokenIds.has(token.id)) continue;
      if (primaryKeys.has(rangeKey(token.range))) continue;
      const monacoRange = toMonacoRange(token.range);
      if (monacoRange === null) continue;
      decorations.push({
        range: monacoRange,
        options: { inlineClassName: 'hl-related' },
      });
    }

    collection.set(decorations);
  }, [isReady, highlights, tokens, stale, selectionOrigin, toMonacoRange, tintClass]);

  // Reveal external selections, but never react to the editor's own caret.
  useEffect(() => {
    if (!isReady || stale || selectionOrigin === 'editor') return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const activeHighlights = highlights ?? createEmptyHighlights();
    const primaryRange = activeHighlights.sourceRanges[0];
    if (!editor || !monaco || primaryRange === undefined) return;

    const monacoRange = toMonacoRange(primaryRange);
    if (monacoRange === null) return;
    editor.revealRangeInCenterIfOutsideViewport(
      monacoRange,
      monaco.editor.ScrollType.Immediate,
    );
  }, [isReady, highlights, selectionOrigin, stale, toMonacoRange]);

  // Lexical and later-stage diagnostics become Monaco markers.
  useEffect(() => {
    if (!isReady) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;

    if (stale) {
      monaco.editor.setModelMarkers(model, 'minic', []);
      return;
    }

    const markers = diagnostics.flatMap((diagnostic) => {
      const monacoRange = toMonacoRange(diagnostic.range);
      if (monacoRange === null) return [];
      const severity =
        diagnostic.severity === 'error'
          ? monaco.MarkerSeverity.Error
          : diagnostic.severity === 'warning'
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info;
      return [
        {
          ...monacoRange,
          severity,
          message: diagnostic.message,
          source: 'Mini-C compiler',
          code: diagnostic.code,
        },
      ];
    });

    monaco.editor.setModelMarkers(model, 'minic', markers);
  }, [diagnostics, isReady, stale, toMonacoRange]);

  return (
    <div className="h-[420px] w-full overflow-hidden rounded-md border border-border bg-surface">
      <Editor
        height="100%"
        language="c"
        theme={resolvedTheme === 'dark' ? 'minic-dark' : 'minic-light'}
        beforeMount={defineMiniCTopics}
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        onMount={handleMount}
        loading={
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            Loading the code editor…
          </div>
        }
        options={{
          ariaLabel: 'Mini-C source editor',
          automaticLayout: true,
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          fontLigatures: false,
          fontSize: 13,
          lineHeight: 20,
          lineNumbers: 'on',
          minimap: { enabled: false },
          padding: { top: 8, bottom: 8 },
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'off',
        }}
      />
    </div>
  );
}

export default CodeEditor;
