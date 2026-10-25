/**
 * Shared syntax colouring for printed IR lines (§8: regex colouring for
 * opcodes, %names, @globals, types, labels and numbers).
 *
 * Pure text work — the colouring never feeds a mapping or a comparison; every
 * ID in the UI comes from the structured IR.
 */
export const IR_TOKEN_PATTERN =
  /((?:^|\s)(?:define|declare|global|alloca|load|store|add|sub|mul|sdiv|srem|icmp|zext|br|ret|call|unreachable|nsw|align|phi)(?=\s))|(%[\w.]+)|(@[\w]+)|\b(i1|i32|ptr|void)\b|\b(label|to|global)\b|\b(\d+)\b/g;

const TOKEN_CLASSES: Record<number, string> = {
  1: 'font-semibold text-violet-700', // opcode words
  2: 'text-sky-700', // %value names
  3: 'text-emerald-700', // @globals
  4: 'text-orange-700', // types
  5: 'text-pink-700', // label/to keywords
  6: 'text-amber-700', // numbers
};

export function colourIRLine(text: string): { text: string; className: string }[] {
  const segments: { text: string; className: string }[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(IR_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ text: text.slice(lastIndex, index), className: '' });
    const groupIndex = match.slice(1).findIndex((capture) => capture !== undefined) + 1;
    segments.push({ text: match[0], className: TOKEN_CLASSES[groupIndex] ?? '' });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), className: '' });
  return segments;
}
