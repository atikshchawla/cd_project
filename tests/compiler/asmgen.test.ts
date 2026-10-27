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

  it('lowers pointer arithmetic into scaled addressing and cell differences', () => {
    const { result, asm } = asmOf(`
int a[3] = {7, 8, 9};
int main() {
  int *p = a;
  int i = 2;
  return p[i] + (p - a);
}
`);
    const text = textOf(asm);

    // p[i] lowers to `ptradd`, i.e. base + index * 4 bytes per cell.
    expect(text).toMatch(/lea \w+, \[\w+ \+ \w+\*4\]/);
    // p - a lowers to `ptrdiff`: subtract the addresses, then shift back into cells.
    expect(text).toMatch(/sub e[a-z]{2}, e[a-z]{2}/);
    expect(text).toMatch(/sar \w+, 2/);
    // The global array reaches the data segment with all of its cells.
    expect(text).toContain('a:');
    expect(text).toContain('.long 7, 8, 9');

    // Every instruction, including ptradd and ptrdiff, still has an assembly line.
    const mapped = new Set(
      asm.lines
        .map((line) => line.irInstrId)
        .filter((id): id is number => id !== undefined),
    );
    for (const instrId of blockInstrIds(result.ir!.module)) {
      expect(mapped.has(instrId), `IR instruction ${instrId} has no assembly line`).toBe(true);
    }
  });

  it('reserves every cell of a multi-cell alloca in the stack frame', () => {
    const frameSize = (source: string): number => {
      const line = asmOf(source)
        .asm.lines.map((entry) => entry.text)
        .find((text) => text.trim().startsWith('sub rsp'));
      expect(line, 'the function must reserve a frame').toBeDefined();
      return Number(line!.split(', ')[1]);
    };

    const scalar = frameSize('int main() { int a = 7; return a; }');
    const array = frameSize('int main() { int a[3] = {7, 8, 9}; return a[2]; }');

    // Three cells need 12 bytes where a scalar needs 4, so the frame grows by at
    // least 8 bytes — the array is not collapsed into a single slot.
    expect(array - scalar).toBeGreaterThanOrEqual(8);
    expect(scalar % 16).toBe(0);
    expect(array % 16).toBe(0);
  });
});
