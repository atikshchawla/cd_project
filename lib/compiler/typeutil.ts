import type { Type } from './types';

/**
 * Type helpers shared by semantic analysis, IR generation and the optimizer.
 *
 * Everything here is pure and structural: it looks at `Type` objects only, so
 * it can be reused by any stage that needs to know how a type behaves (its
 * size in cells, its decayed form, whether a pointer conversion is legal).
 *
 * Mini-C has no `char`, no `float` and no casts: every scalar is one abstract
 * 4-byte cell, so `cellsOf` is what the IR, the simulator and `sizeof` all use
 * to agree on layout.
 */

/** How many cells one value of `type` occupies in this dialect. */
export function cellsOf(type: Type): number {
  switch (type.kind) {
    case 'array':
      return type.size * cellsOf(type.element);
    case 'record':
      return type.size;
    case 'void':
    case 'function':
      return 1;
    default:
      return 1;
  }
}

/** Diagnostic-friendly spelling: `int`, `int *`, `int[3]`, `struct Point`. */
export function typeToString(type: Type): string {
  switch (type.kind) {
    case 'int':
      return 'int';
    case 'void':
      return 'void';
    case 'string':
      return 'string literal';
    case 'pointer':
      return `${typeToString(type.pointee)} *`;
    case 'array':
      return `${typeToString(type.element)}[${type.size}]`;
    case 'record':
      return `${type.recordKind} ${type.name}`;
    case 'function':
      return 'function';
  }
}

/** The element type of an array or pointer, else `null`. */
export function pointeeOf(type: Type): Type | null {
  if (type.kind === 'pointer') return type.pointee;
  if (type.kind === 'array') return type.element;
  return null;
}

/** Array-to-pointer decay: `int[3]` becomes `int *`; everything else is kept. */
export function decay(type: Type): Type {
  if (type.kind === 'array') return { kind: 'pointer', pointee: type.element };
  return type;
}

/** Is this type usable as an address (pointer or array)? */
export function isAddress(type: Type): boolean {
  return type.kind === 'pointer' || type.kind === 'array';
}

/**
 * Can a value of `from` be used where `to` is expected, without a cast?
 *
 * The rules mirror C's implicit pointer conversions, minus everything that
 * needs `void *` subtyping: `void *` converts to and from any pointer (that is
 * how `malloc`'s result is used), identical pointees convert, arrays decay,
 * and integer literals may be used as the null pointer.
 */
export function pointerCompatible(from: Type, to: Type): boolean {
  const fromPointee = pointeeOf(from);
  const toPointee = pointeeOf(to);
  if (fromPointee === null || toPointee === null) return false;
  if (fromPointee.kind === 'void' || toPointee.kind === 'void') return true;
  if (fromPointee.kind === 'int' && toPointee.kind === 'int') return true;
  if (fromPointee.kind === 'pointer' && toPointee.kind === 'pointer') {
    return pointerCompatible(fromPointee, toPointee);
  }
  if (fromPointee.kind === 'record' && toPointee.kind === 'record') {
    return fromPointee.name === toPointee.name && fromPointee.recordKind === toPointee.recordKind;
  }
  return false;
}
