/**
 * TEMPORARY parity harness (delete after the audit).
 *
 * Runs every probe program in `cases.json` through the TypeScript compiler and
 * writes the outcome next to the Python harness output so the two can be diffed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPT_PASS_ORDER, compile, optimizeModule, verifyModule } from '@/lib/compiler';
import { printIR } from '@/lib/compiler/irprint';
import { simulate } from '@/lib/compiler/simulate';

interface Case {
  id: string;
  src: string;
}

interface Record_ {
  id: string;
  stage: 'lex' | 'parse' | 'sema' | 'ok' | 'internal';
  errors: string[];
  warnings: string[];
  ir: boolean;
  asm: boolean;
  verify: string[];
  opt_changes: number;
  ir_text: string | null;
  opt_text: string | null;
  asm_text: string | null;
  sim: {
    outcome: string;
    message: string | null;
    result: number | null;
    output: string;
  } | null;
}

describe('parity harness', () => {
  it('dumps one record per probe program', () => {
    const casesPath = process.env.PARITY_CASES;
    const outPath = process.env.PARITY_OUT;
    expect(casesPath, 'PARITY_CASES must be set').toBeTruthy();
    expect(outPath, 'PARITY_OUT must be set').toBeTruthy();
    const cases = JSON.parse(readFileSync(casesPath!, 'utf8')) as Case[];
    const records: Record_[] = cases.map((testCase) => {
      const result = compile(testCase.src);
      const errors = result.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.stage}/${diagnostic.code}: ${diagnostic.message}`);
      const warnings = result.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`);
      const internal = errors.some((entry) => entry.startsWith('internal/'));
      const stage: Record_['stage'] = internal
        ? 'internal'
        : errors.length === 0
          ? 'ok'
          : ((errors[0].split('/')[0] as Record_['stage']));
      const record: Record_ = {
        id: testCase.id,
        stage,
        errors,
        warnings,
        ir: result.ir !== null,
        asm: result.asm !== null,
        verify: [],
        opt_changes: 0,
        ir_text: null,
        opt_text: null,
        asm_text: null,
        sim: null,
      };
      if (result.ir !== null) {
        const module = result.ir.module;
        record.ir_text = result.ir.lines.map((line) => line.text).join('\n');
        record.verify = verifyModule(module);
        const optimization = optimizeModule(module, OPT_PASS_ORDER);
        record.opt_changes = optimization.changes.length;
        record.opt_text = printIR(optimization.module);
        record.asm_text = result.asm?.lines.map((line) => line.text).join('\n') ?? null;
        const sim = simulate(module);
        const last = sim.steps[sim.steps.length - 1];
        record.sim = {
          outcome: sim.outcome,
          message: sim.message ?? null,
          result: sim.result ?? null,
          output: last === undefined ? '' : last.state.output,
        };
      }
      return record;
    });
    writeFileSync(outPath!, JSON.stringify(records, null, 1), 'utf8');
  });
});
