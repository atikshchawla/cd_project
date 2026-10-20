/** Convert a character offset into a 1-based line/column position. */
export function positionAt(source: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let col = 1;
  for (let index = 0; index < clamped; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}
