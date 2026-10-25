/**
 * Shared 32-bit integer arithmetic (§6.5).
 *
 * Every part of the app that needs to evaluate Mini-C integers (IR tooling,
 * and later the simulator and constant folding) must import these helpers so
 * they can never disagree about wrap-around behaviour.
 */

/** Wrap a number to a signed 32-bit integer, like C's `int`. */
export function wrap32(x: number): number {
  return x | 0;
}

/** 32-bit multiplication, like C's `int` multiplication. */
export function mul32(a: number, b: number): number {
  return Math.imul(a, b);
}

/** 32-bit truncating division (towards zero), like C's `int` division. */
export function div32(a: number, b: number): number {
  if (b === 0) return 0; // Mini-C has no UB model; keep it total.
  return wrap32(a / b);
}

/** 32-bit remainder with the sign of the dividend, like C's `%`. */
export function rem32(a: number, b: number): number {
  if (b === 0) return 0;
  return wrap32(a - mul32(div32(a, b), b));
}

/**
 * Evaluate an `icmp` predicate over two IR values.
 *
 * The simulator and the constant folder both import this so they can never
 * disagree about what a comparison means: comparisons see the stored numbers
 * exactly as they are (only the arithmetic helpers wrap). Unknown predicates
 * compare unequal, matching the interpreter's fallback.
 */
export function compare32(predicate: string, a: number, b: number): boolean {
  switch (predicate) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'slt':
      return a < b;
    case 'sle':
      return a <= b;
    case 'sgt':
      return a > b;
    case 'sge':
      return a >= b;
    default:
      return a !== b;
  }
}
