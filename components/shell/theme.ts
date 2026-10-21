'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'minic-theme';

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
}

interface ThemeState {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

/**
 * The inline script in layout.tsx has already set the correct class before
 * first paint; this store only tracks the user's choice afterwards. The
 * initial values are server-safe (no window/localStorage at module load).
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  choice: 'system',
  resolved: 'light',
  setChoice: (choice) => {
    const resolved = resolve(choice);
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Private mode: theme still applies for this session.
    }
    applyTheme(resolved);
    set({ choice, resolved });
  },
}));

/**
 * Hydrates the store from localStorage after mount and follows the OS
 * preference while the choice is "system". Call once near the app root.
 */
export function useThemeSync(): void {
  useEffect(() => {
    let stored: ThemeChoice = 'system';
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark' || raw === 'system') stored = raw;
    } catch {
      // Private mode: keep "system".
    }
    const resolved = resolve(stored);
    applyTheme(resolved);
    useThemeStore.setState({ choice: stored, resolved });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      if (useThemeStore.getState().choice !== 'system') return;
      const next = resolve('system');
      applyTheme(next);
      useThemeStore.setState({ resolved: next });
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
}
