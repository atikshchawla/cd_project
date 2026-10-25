import { describe, it } from 'vitest';
import { OPT_PASS_ORDER, compile, optimizeModule, verifyModule } from '@/lib/compiler';
import { simulate } from '@/lib/compiler/simulate';
import type { OptPassId } from '@/lib/compiler';

const TOUR = `int square(int n) {
  int first = n * n;
  int second = n * n;
  return first + second;
}

int main() {
  int x = 5;
  int a = x;
  int b = 6 * 7;
  int c = 6 * 7;
  a + b + c;
  return square(3) + a + b + c + x;
}
`;

describe('tour candidate', () => {
  it('reports', () => {
    const result = compile(TOUR);
    console.log('diagnostics', result.diagnostics.map((d) => d.code));
    if (result.ir === null) return;
    const perPass = OPT_PASS_ORDER.map(
      (p) => `${p}=${optimizeModule(result.ir!.module, [p as OptPassId]).changes.length}`,
    );
    console.log('isolated', perPass.join(' '));
    const full = optimizeModule(result.ir!.module, OPT_PASS_ORDER);
    console.log(
      'full passes applied',
      full.passStates.map((s) => `${s.id}:${s.status}/${s.changeCount}`).join(' '),
      'fallback', String(full.fallback), 'verify', verifyModule(full.module).length,
      'counts', full.originalCount, '->', full.optimizedCount,
    );
    const a = simulate(result.ir.module);
    const b = simulate(full.module);
    console.log('sim', a.outcome, a.result, '->', b.outcome, b.result, 'steps', a.steps.length, b.steps.length);
  });
});
