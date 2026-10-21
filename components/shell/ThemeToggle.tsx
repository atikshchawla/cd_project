'use client';

import { Moon, Sun, SunMoon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useThemeStore, type ThemeChoice } from './theme';

const ORDER: ThemeChoice[] = ['light', 'dark', 'system'];

const META: Record<ThemeChoice, { label: string; icon: typeof Sun }> = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: SunMoon },
};

/**
 * Cycles light → dark → system. The initial class on <html> comes from the
 * inline script in layout.tsx, so this only records the user's choice.
 */
export function ThemeToggle() {
  const choice = useThemeStore((state) => state.choice);
  const setChoice = useThemeStore((state) => state.setChoice);
  const meta = META[choice];
  const Icon = meta.icon;

  const cycle = (): void => {
    const index = ORDER.indexOf(choice);
    setChoice(ORDER[(index + 1) % ORDER.length]!);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8"
      onClick={cycle}
      aria-label={`Theme: ${meta.label}. Click to switch.`}
      title={`Theme: ${meta.label} — click to change`}
    >
      <Icon aria-hidden="true" />
      {meta.label}
    </Button>
  );
}
