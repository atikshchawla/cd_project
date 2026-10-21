import {
  Binary,
  CircleCheck,
  Cpu,
  FileCode2,
  Gauge,
  GitBranch,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Stage } from '@/lib/compiler/types';

/**
 * Single presentation config for the pipeline stepper. Text lives in
 * `content/explanations.ts` (STAGE_EXPLANATIONS); this file only adds the
 * icon, the CSS hue variable and the active-chip classes. Consumers must map
 * over this array — never hard-code the stage count.
 */
export interface StageConfig {
  id: Stage;
  icon: LucideIcon;
  /** CSS custom property holding this stage's hue (defined in globals.css). */
  hueVar: string;
  /** Literal Tailwind classes for the active chip so the scanner picks them up. */
  activeClass: string;
}

export const STAGE_CONFIG: StageConfig[] = [
  {
    id: 'source',
    icon: FileCode2,
    hueVar: '--stage-source',
    activeClass: 'border-stage-source/60 bg-stage-source/15',
  },
  {
    id: 'lex',
    icon: Binary,
    hueVar: '--stage-tokens',
    activeClass: 'border-stage-tokens/60 bg-stage-tokens/15',
  },
  {
    id: 'parse',
    icon: GitBranch,
    hueVar: '--stage-ast',
    activeClass: 'border-stage-ast/60 bg-stage-ast/15',
  },
  {
    id: 'sema',
    icon: CircleCheck,
    hueVar: '--stage-semantic',
    activeClass: 'border-stage-semantic/60 bg-stage-semantic/15',
  },
  {
    id: 'ir',
    icon: Workflow,
    hueVar: '--stage-ir',
    activeClass: 'border-stage-ir/60 bg-stage-ir/15',
  },
  {
    id: 'asm',
    icon: Cpu,
    hueVar: '--stage-assembly',
    activeClass: 'border-stage-assembly/60 bg-stage-assembly/15',
  },
  {
    id: 'sim',
    icon: Gauge,
    hueVar: '--stage-run',
    activeClass: 'border-stage-run/60 bg-stage-run/15',
  },
];
