import { describe, expect, it } from 'vitest';
import { compile } from '@/lib/compiler';
import type { AsmLine, IRModule } from '@/lib/compiler/types';

const VALID_KINDS: ReadonlySet<AsmLine['kind']> = new Set([
  'comment',
  'directive',
  'label',
  'instruction',
]);

function asmOf(source: string) {
  const result = compile(source);
  expect(result.asm).not.toBeNull();
  return { result, asm: result.asm! };
}

function textOf(asm: { lines: AsmLine[] }): string {
  return asm.lines.map((line) => line.text).join('\n');
}

/** Every IR instruction that reached a basic block, in order. */
function blockInstrIds(module: IRModule): number[] {
  const ids: number[] = [];
  for (const fn of module.functions) {
    for (const blockId of fn.blockIds) {
      const block = module.blocks[blockId];
      if (block !== undefined) ids.push(...block.instrIds);
    }
  }
  return ids;
}

describe('generateAsm (naive x86-64 lowering)', () => {
  it('lowers a clean program into numbered, well-formed lines', () => {
    const { result, asm } = asmOf('int main() { return 7; }');

    expect(asm.lines.length).toBeGreaterThan(4);
    asm.lines.forEach((line, index) => {
      expect(line.lineNo).toBe(index + 1);
      expect(VALID_KINDS.has(line.kind)).toBe(true);
      expect(line.text.trim().length).toBeGreaterThan(0);
    });

    // Prologue, body label, epilogue and ret are always present.
    const text = textOf(asm);
    expect(text).toContain('push rbp');
    expect(text).toContain('mov rbp, rsp');
    expect(text).toContain('.Lmain.epilogue:');
    expect(text).toContain('ret');

    // The IR is still available alongside the assembly.
    expect(result.ir).not.toBeNull();
  });

  it('emits the header comment stating the assembly is text only', () => {
    const { asm } = asmOf('int main() { return 0; }');
    const header = asm.lines.slice(0, 2).map((line) => line.text).join('\n');
    expect(header).toContain('never assembled or executed');
  });

  it('maps every IR instruction to at least one assembly line', () => {
    const { result, asm } = asmOf(`
      int add(int a, int b) {
        return a + b;
      }
      int main() {
        int x = add(2, 3);
        return x * 4;
      }
    `);

    const mapped = new Set(
      asm.lines
        .map((line) => line.irInstrId)
        .filter((id): id is number => id !== undefined),
    );
    for (const instrId of blockInstrIds(result.ir!.module)) {
      expect(mapped.has(instrId), `IR instruction ${instrId} has no assembly line`).toBe(true);
    }
  });

  it('only maps assembly lines to instructions that exist in the IR', () => {
    const { result, asm } = asmOf(`
      int main() {
        int i = 0;
        while (i < 3) {
          i = i + 1;
        }
        return i;
      }
    `);

    const knownIds = new Set(Object.values(result.ir!.module.instrs).map((instr) => instr.id));
    for (const line of asm.lines) {
      if (line.irInstrId !== undefined) {
        expect(knownIds.has(line.irInstrId)).toBe(true);
      }
    }
  });

  it('lowers control flow into labels and jumps', () => {
    const { asm } = asmOf(`
      int main() {
        int i = 0;
        while (i < 3) {
          i = i + 1;
        }
        return i;
      }
    `);

    const text = textOf(asm);
    expect(text).toMatch(/jmp \.Lmain\./);
    expect(text).toMatch(/cmp /);
    expect(text).toMatch(/j(ne|le|l|g|ge|e) /);
  });

  it('lowers calls into call instructions with the callee name', () => {
    const { asm } = asmOf(`
      int add(int a, int b) {
        return a + b;
      }
      int main() {
        return add(40, 2);
      }
    `);

    const text = textOf(asm);
    expect(text).toContain('call add');
    expect(text).toContain('add:');
    expect(text).toContain('main:');
    // The first two incoming arguments arrive in edi/esi.
    expect(text).toMatch(/DWORD PTR \[rbp - \d+\], edi/);
    expect(text).toMatch(/DWORD PTR \[rbp - \d+\], esi/);
  });

  it('keeps the stack frame a multiple of 16 bytes', () => {
    const { asm } = asmOf(`
      int main() {
        int a = 1;
        int b = 2;
        int c = 3;
        return a + b + c;
      }
    `);

    const match = textOf(asm).match(/sub rsp, (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) % 16).toBe(0);
  });

  it('is deterministic and JSON-serialisable', () => {
    const first = asmOf('int main() { return 1 + 2; }').asm;
    const second = asmOf('int main() { return 1 + 2; }').asm;
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('is produced by a full compile and blocked by an earlier failure', () => {
    const ok = compile('int main() { return 0; }');
    expect(ok.asm).not.toBeNull();
    expect(ok.completed.asm).toBe('ok');

    const failed = compile('int main() { return 1 }');
    expect(failed.asm).toBeNull();
    expect(failed.completed.asm).toBe('blocked');
  });
});
