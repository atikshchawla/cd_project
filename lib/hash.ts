/**
 * Deterministic 32-bit FNV-1a hash of the normalised source text.
 *
 * The workspace compares this hash with `CompileResult.sourceHash` to decide
 * whether results still belong to the text currently in the editor.
 */
export function hashSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
