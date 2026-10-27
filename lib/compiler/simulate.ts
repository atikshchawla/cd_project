import { compare32, div32, mul32, rem32, wrap32 } from './int32';
import type { IRFunction, IRModule, IROperand } from './types';

/**
 * A trace-first interpreter over the unoptimised IR (SPEC §13.3).
 *
 * The simulated machine has a flat, cell-addressed memory:
 *
 * - **globals** are laid out first, at addresses 1, 2, … (`0` is null),
 * - every `alloca` reserves cells on the **stack** of the running frame,
 * - `malloc` / `new` reserve cells on the **heap**, released by
 *   `free` / `delete`.
 *
 * A *block* remembers where it starts, how many cells it has, who owns it and
 * whether it is still live, which is what lets the interpreter report a null
 * dereference, an out-of-bounds index, a use-after-free, a double free, a free
 * of something that was never heap-allocated and an unrelated pointer
 * difference as clear runtime errors instead of silently reading nonsense.
 *
 * The interpreter is pure, total and deterministic: every step records a
 * copy-on-write snapshot of the machine state (paged memory, so a snapshot
 * only copies a page map), so stepping back is just moving an index.
 * Limits: 5000 steps, call depth 100, 1 000 000 cells of memory.
 */

export const SIM_STEP_LIMIT = 5000;
export const SIM_CALL_DEPTH_LIMIT = 100;
/** Total cells one run may ever reserve — protects the browser from runaway code. */
export const SIM_MEMORY_LIMIT = 1_000_000;
/** Largest single allocation, matching the reference interpreter's cap. */
export const SIM_MAX_ALLOC_CELLS = 100_000;

/** Memory is paged so a snapshot copies the page map, not every cell. */
const PAGE_SHIFT = 8;
const PAGE_SIZE = 1 << PAGE_SHIFT;
const PAGE_MASK = PAGE_SIZE - 1;

/** Page index → cells. Cells are `int32`; unwritten cells read as 0. */
export type SimMemory = Record<number, number[]>;

export interface SimSlot {
  name: string; // SSA value name, e.g. '%x' or '%0'
  varName?: string; // source variable, when this slot is an alloca
  value: number;
  allocatedAt: number; // step index that reserved this cell
  updatedAt: number; // step index that last wrote it
  /** First address of the block this alloca reserved (`undefined` for temps). */
  addr?: number;
  /** Cells the alloca reserved (1 for a plain `int` or pointer). */
  cells?: number;
}

export interface SimFrame {
  funcName: string;
  slots: Record<string, SimSlot>;
  entryStep: number;
}

/** One contiguous run of cells: a global, a stack slot or a heap block. */
export interface SimAlloc {
  start: number; // first address (also the block's identity: never reused)
  size: number; // cells
  kind: 'global' | 'stack' | 'heap';
  name?: string; // source variable, for globals and named stack slots
  freed: boolean;
  /** Stack blocks only: `entryStep` of the frame that owns them. */
  frameToken?: number;
}

export interface SimState {
  globals: Record<string, number>; // cell 0 of every global, for the data panel
  frames: SimFrame[]; // last frame = currently executing
  returnValue: number | null; // set when main returns
  memory: SimMemory; // flat cell memory, paged
  allocations: SimAlloc[]; // blocks in address order
  nextAddr: number; // next free address (1 = first cell, 0 = null)
  output: string; // everything `print` / `printf` wrote
}

export type SimStepKind = 'start' | 'exec' | 'branch' | 'call' | 'ret';

export interface TraceStep {
  index: number;
  instrId: number | null; // null for the synthetic start step
  funcName: string | null;
  blockLabel: string | null;
  kind: SimStepKind;
  description: string;
  state: SimState;
  poppedFrame?: SimFrame; // frame released by a `ret` step
}

export type SimOutcome = 'finished' | 'step-limit' | 'no-main' | 'error';

export interface SimulationResult {
  steps: TraceStep[];
  outcome: SimOutcome;
  message: string | null;
  result: number | null; // main's return value (null for void main)
}

/** Read one cell of the memory the given snapshot sees. */
export function readCell(state: SimState, addr: number): number {
  if (addr <= 0) return 0;
  const page = state.memory[addr >>> PAGE_SHIFT];
  return page?.[addr & PAGE_MASK] ?? 0;
}

/** Every cell of one block, as the execution view shows them. */
export function blockCells(state: SimState, block: SimAlloc): number[] {
  const cells: number[] = [];
  for (let index = 0; index < block.size; index += 1) cells.push(readCell(state, block.start + index));
  return cells;
}

/** Write one cell of a draft state, copying its page first (copy-on-write). */
function writeCell(draft: SimState, addr: number, value: number): void {
  const index = addr >>> PAGE_SHIFT;
  const existing = draft.memory[index];
  const page = existing === undefined ? new Array<number>(PAGE_SIZE).fill(0) : existing.slice();
  page[addr & PAGE_MASK] = value;
  draft.memory[index] = page;
}

/** The live block containing `addr`, searched newest first. */
function findBlock(state: SimState, addr: number): SimAlloc | undefined {
  if (addr <= 0) return undefined;
  for (let index = state.allocations.length - 1; index >= 0; index -= 1) {
    const block = state.allocations[index];
    if (block.freed) continue;
    if (addr >= block.start && addr < block.start + block.size) return block;
  }
  return undefined;
}

/** Any block containing or starting at `addr`, including freed ones. */
function findBlockAny(state: SimState, addr: number): SimAlloc | undefined {
  if (addr <= 0) return undefined;
  for (let index = state.allocations.length - 1; index >= 0; index -= 1) {
    const block = state.allocations[index];
    const inRange = addr >= block.start && addr < block.start + block.size;
    const isStart = addr === block.start;
    if (inRange || isStart) return block;
  }
  return undefined;
}

/**
 * The closest live block that starts at or below `addr` without containing
 * it — the block an out-of-bounds index most likely stepped off the end of.
 */
function nearestBlock(state: SimState, addr: number): SimAlloc | undefined {
  if (addr <= 0) return undefined;
  let best: SimAlloc | undefined;
  for (const block of state.allocations) {
    if (block.freed || block.size === 0) continue;
    if (block.start > addr || addr < block.start + block.size) continue;
    if (best === undefined || block.start > best.start) best = block;
  }
  return best;
}

/**
 * Address space one block consumes: its cells plus a single *guard* cell that
 * belongs to no block at all.
 *
 * Without the gap the address just past `a[3]` would be the first cell of
 * whatever variable was declared next, so `a[3]` would silently read it instead
 * of being reported as out of bounds. The guard keeps blocks disjoint at their
 * edges, which is exactly what `nearestBlock` and the one-past-the-end rule
 * used by pointer subtraction rely on.
 */
function spanOf(cells: number): number {
  return Math.max(Math.trunc(cells), 1) + 1;
}

/** Reserve `size` cells; `null` when the run would exceed its memory budget. */function allocate(
  draft: SimState,
  size: number,
  kind: SimAlloc['kind'],
  name?: string,
  frameToken?: number,
): SimAlloc | null {
  const cells = Math.max(0, Math.trunc(size));
  const span = spanOf(cells); // payload + guard, so every start stays unique
  if (draft.nextAddr + span > SIM_MEMORY_LIMIT + 1) return null;
  const block: SimAlloc = {
    start: draft.nextAddr,
    size: cells,
    kind,
    freed: false,
    ...(name !== undefined ? { name } : {}),
    ...(frameToken !== undefined ? { frameToken } : {}),
  };
  draft.nextAddr += span;
  draft.allocations.push(block);
  return block;
}

/** How a person reads an address: decimal plus hex, as the trace does. */
function show(value: number): string {
  return `${value} (0x${(value >>> 0).toString(16)})`;
}

/** A human name for an address: `a[2]`, `@g`, or a heap block's offset. */
function describeAddress(state: SimState, addr: number): string {
  const block = findBlock(state, addr) ?? findBlockAny(state, addr);
  if (block === undefined) return show(addr);
  const offset = addr - block.start;
  if (block.name !== undefined) return offset === 0 ? block.name : `${block.name}[${offset}]`;
  if (block.kind === 'heap') {
    return offset === 0 ? `heap @ ${show(block.start)}` : `heap @ ${show(block.start)}[${offset}]`;
  }
  return show(addr);
}

function frameBytes(frame: SimFrame): number {
  let cells = 0;
  for (const slot of Object.values(frame.slots)) cells += slot.cells ?? 1;
  return cells * 4;
}

/**
 * Copy-on-write snapshot: the top frame is copied (it is the only one that
 * may change); older frames are shared, which keeps snapshots cheap and
 * guarantees stepping back cannot observe later writes. Memory pages and
 * allocation records are shared until something writes them.
 */
function cloneState(state: SimState): SimState {
  return {
    globals: { ...state.globals },
    frames: state.frames.map((frame, index) =>
      index === state.frames.length - 1 ? { ...frame, slots: { ...frame.slots } } : frame,
    ),
    returnValue: state.returnValue,
    memory: { ...state.memory },
    allocations: [...state.allocations],
    nextAddr: state.nextAddr,
    output: state.output,
  };
}

/** Clone the top frame so its slots can be written without touching history. */
function mutableTopFrame(draft: SimState): SimFrame | null {
  const index = draft.frames.length - 1;
  const frame = draft.frames[index];
  if (frame === undefined) return null;
  const copy: SimFrame = { ...frame, slots: { ...frame.slots } };
  draft.frames[index] = copy;
  return copy;
}

/** Clone the (soon to be) top frame after a pop, then hand it back. */
function mutableNewTopFrame(draft: SimState): SimFrame | null {
  const index = draft.frames.length - 1;
  const frame = draft.frames[index];
  if (frame === undefined) return null;
  const copy: SimFrame = { ...frame, slots: { ...frame.slots } };
  draft.frames[index] = copy;
  return copy;
}

/**
 * The value of an operand.
 *
 * An alloca's operand *is* its address (a variable used as a pointer), a
 * `@global` operand resolves through `globalAddr` to that global's address,
 * and every other named value is the number sitting in its slot. String
 * operands are only ever read by `printf`, so they resolve to 0 here.
 */
function readOperand(
  frame: SimFrame | undefined,
  operand: IROperand,
  globalAddr: (name: string) => number,
): number {
  switch (operand.kind) {
    case 'const':
      return wrap32(operand.value);
    case 'global':
      return globalAddr(operand.name);
    case 'value': {
      const slot = frame?.slots[operand.name];
      return slot === undefined ? 0 : (slot.addr ?? slot.value);
    }
    case 'label':
    case 'string':
      return 0;
  }
}

function operandText(operand: IROperand): string {
  switch (operand.kind) {
    case 'const':
      return String(operand.value);
    case 'global':
      return `@${operand.name}`;
    case 'value':
      return operand.name;
    case 'label':
      return 'label';
    case 'string':
      return `"${operand.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
}

/**
 * Format a `printf` argument list the way the reference interpreter does:
 * `%d` / `%i` / `%u` / `%s` take a number, `%c` takes a code point and `%%`
 * is a literal percent. Anything the reference would refuse to format (a
 * trailing `%`, a missing argument, an unknown conversion, an argument left
 * over) returns `null`, and the caller then writes the format out unchanged.
 */
function formatPrintf(format: string, values: number[]): string | null {
  let out = '';
  let used = 0;
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    if (char !== '%') {
      out += char;
      continue;
    }
    const spec = format[index + 1];
    if (spec === undefined) return null;
    if (spec === '%') {
      out += '%';
      index += 1;
      continue;
    }
    const value = values[used];
    if (value === undefined) return null;
    if (spec === 'c') {
      if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return null;
      out += String.fromCodePoint(value);
    } else if (spec === 'd' || spec === 'i' || spec === 'u' || spec === 's') {
      out += String(value);
    } else {
      return null;
    }
    used += 1;
    index += 1;
  }
  if (used < values.length) return null;
  return out;
}

/** The five calls the language provides itself; they never push a frame. */
type BuiltinName = 'malloc' | 'free' | 'delete' | 'print' | 'printf';

const BUILTIN_CALLS: Record<string, BuiltinName> = {
  malloc: 'malloc',
  free: 'free',
  delete: 'delete',
  print: 'print',
  printf: 'printf',
};

export function simulate(module: IRModule): SimulationResult {
  const main = module.functions.find((fn) => fn.name === 'main' && !fn.isDeclaration);
  if (main === undefined) {
    return {
      steps: [],
      outcome: 'no-main',
      message: 'This program has no `main` function with a body, so there is nothing to execute.',
      result: null,
    };
  }

  const steps: TraceStep[] = [];

  // ---- Data segment: globals occupy the first addresses, in source order ----
  const globalBlocks = new Map<string, { start: number; size: number }>();
  const globals: Record<string, number> = {};
  const memory: SimMemory = {};
  const allocations: SimAlloc[] = [];
  let nextAddr = 1;
  for (const global of module.globals) {
    const cells = global.cells ?? 1;
    if (nextAddr + spanOf(cells) > SIM_MEMORY_LIMIT + 1) break;
    const start = nextAddr;
    nextAddr += spanOf(cells);
    const block: SimAlloc = {
      start,
      size: cells,
      kind: 'global',
      name: global.name,
      freed: false,
    };
    allocations.push(block);
    globalBlocks.set(global.name, { start, size: cells });
    globals[global.name] = wrap32(global.init);
    const inits = global.inits;
    for (let index = 0; index < cells; index += 1) {
      const value = wrap32(inits?.[index] ?? (index === 0 ? global.init : 0));
      const addr = start + index;
      const pageIndex = addr >>> PAGE_SHIFT;
      const page = memory[pageIndex] ?? new Array<number>(PAGE_SIZE).fill(0);
      page[addr & PAGE_MASK] = value;
      memory[pageIndex] = page;
    }
  }
  // `@name` operands denote addresses; this map turns a name into one.
  const globalAddress = (name: string): number => globalBlocks.get(name)?.start ?? 0;

  interface ReturnSite {
    func: IRFunction;
    blockId: number;
    instrIndex: number;
  }

  let state: SimState = {
    globals: { ...globals },
    frames: [
      {
        funcName: main.name,
        slots: Object.fromEntries(
          main.params.map((param) => [
            param.name,
            { name: param.name, value: 0, allocatedAt: 0, updatedAt: 0 },
          ]),
        ),
        entryStep: 0,
      },
    ],
    returnValue: null,
    memory: { ...memory },
    allocations: [...allocations],
    nextAddr,
    output: '',
  };
  const returnStack: ReturnSite[] = [];
  let func = main;
  let blockId = main.blockIds[0] ?? -1;
  let instrIndex = 0;

  steps.push({
    index: 0,
    instrId: null,
    funcName: main.name,
    blockLabel: module.blocks[blockId]?.label ?? null,
    kind: 'start',
    description: 'Call main() — push the first stack frame for main (the stack grows).',
    state,
  });

  const record = (
    kind: SimStepKind,
    description: string,
    instrId: number,
    mutate: (draft: SimState) => void,
    poppedFrame?: SimFrame,
  ): void => {
    const next = cloneState(state);
    mutate(next);
    steps.push({
      index: steps.length,
      instrId,
      funcName: func.name,
      blockLabel: module.blocks[blockId]?.label ?? null,
      kind,
      description,
      state: next,
      ...(poppedFrame !== undefined ? { poppedFrame } : {}),
    });
    state = next;
  };

  const setSlot = (draft: SimState, name: string, value: number, varName?: string): void => {
    const top = mutableTopFrame(draft);
    if (top === null) return;
    const existing = top.slots[name];
    top.slots[name] = {
      name,
      ...(varName !== undefined
        ? { varName }
        : existing?.varName !== undefined
          ? { varName: existing.varName }
          : {}),
      value,
      allocatedAt: existing?.allocatedAt ?? steps.length,
      updatedAt: steps.length,
      ...(existing?.addr !== undefined ? { addr: existing.addr } : {}),
      ...(existing?.cells !== undefined ? { cells: existing.cells } : {}),
    };
  };

  const finish = (outcome: SimOutcome, message: string | null, result: number | null): SimulationResult => ({
    steps,
    outcome,
    message,
    result,
  });

  /** Stop with a runtime error, leaving the failing instruction in the trace. */
  const fail = (message: string, instrId: number): SimulationResult => {
    record('exec', message, instrId, () => {});
    return finish('error', message, null);
  };

  /** Execute one instruction; updates control flow and appends one step. */
  const stepOnce = (): SimulationResult | null => {
    const block = module.blocks[blockId];
    const instrId = block?.instrIds[instrIndex];
    if (block === undefined || instrId === undefined) {
      return finish('error', 'Execution fell off the end of a basic block without a terminator.', null);
    }
    const instr = module.instrs[instrId];
    if (instr === undefined) {
      return finish('error', 'Execution reached an instruction that is not part of this module.', null);
    }

    const current = state.frames[state.frames.length - 1];
    const ops = instr.operands;
    const id = instr.id;
    const nextInstr = (): void => {
      instrIndex += 1;
    };
    const jumpTo = (targetBlockId: number): void => {
      blockId = targetBlockId;
      instrIndex = 0;
    };

    /** Read an operand, where a `@global` denotes that global's address. */
    const read = (operand: IROperand): number => readOperand(current, operand, globalAddress);

    /**
     * Resolve a pointer operand, reporting null dereferences, use-after-free
     * and plain invalid addresses instead of reading arbitrary memory.
     */
    const deref = (operand: IROperand): { addr: number; error: string | null } => {
      const addr = read(operand);
      if (addr === 0) return { addr, error: 'Runtime error: null pointer — address 0 is never a valid object.' };
      const block = findBlock(state, addr);
      if (block !== undefined) return { addr, error: null };
      const dead = findBlockAny(state, addr);
      if (dead !== undefined) {
        return {
          addr,
          error: `Runtime error: use-after-free — ${describeAddress(state, addr)} was released before this access.`,
        };
      }
      const nearest = nearestBlock(state, addr);
      if (nearest !== undefined) {
        return {
          addr,
          error: `Runtime error: out of bounds — ${describeAddress(state, addr)} is past the end of a ${nearest.size}-cell block (addresses ${nearest.start}–${nearest.start + nearest.size - 1}).`,
        };
      }
      return {
        addr,
        error: `Runtime error: invalid pointer — ${describeAddress(state, addr)} is not inside any live block.`,
      };
    };

    switch (instr.opcode) {
      case 'alloca': {
        if (instr.result === undefined) {
          nextInstr();
          return null;
        }
        const name = instr.result;
        const varName = instr.varName;
        const cells = instr.cells ?? 1;
        const frameToken = current?.entryStep ?? 0;
        if (state.nextAddr + spanOf(cells) > SIM_MEMORY_LIMIT + 1) {
          return fail(
            `Runtime error: out of memory — ${cells} more cells would exceed the ${SIM_MEMORY_LIMIT}-cell limit.`,
            id,
          );
        }
        const shape = cells > 1 ? ` [${cells} x i32]` : '';
        record(
          'exec',
          `${name} = alloca${shape} — reserve ${cells * 4} bytes for ${varName ?? 'a local'}.`,
          id,
          (draft) => {
            const allocated = allocate(draft, cells, 'stack', varName, frameToken);
            const top = mutableTopFrame(draft);
            if (top === null) return;
            top.slots[name] = {
              name,
              ...(varName !== undefined ? { varName } : {}),
              value: 0,
              allocatedAt: steps.length,
              updatedAt: steps.length,
              ...(allocated !== null ? { addr: allocated.start, cells } : {}),
            };
          },
        );
        nextInstr();
        return null;
      }

      case 'load': {
        const ptr = ops[0];
        if (ptr === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const resolved = deref(ptr);
        if (resolved.error !== null) return fail(resolved.error, id);
        const value = readCell(state, resolved.addr);
        const resultName = instr.result;
        const origin =
          ptr.kind === 'value' && current?.slots[ptr.name]?.varName !== undefined
            ? (current.slots[ptr.name]?.varName ?? ptr.name)
            : ptr.kind === 'global'
              ? `@${ptr.name}`
              : describeAddress(state, resolved.addr);
        record(
          'exec',
          `${resultName} = load ${operandText(ptr)} — read ${origin} = ${show(value)}.`,
          id,
          (draft) => setSlot(draft, resultName, value),
        );
        nextInstr();
        return null;
      }

      case 'store': {
        const [stored, ptr] = ops;
        if (stored === undefined || ptr === undefined) {
          nextInstr();
          return null;
        }
        const resolved = deref(ptr);
        if (resolved.error !== null) return fail(resolved.error, id);
        const value = read(stored);
        const origin =
          ptr.kind === 'value' && current?.slots[ptr.name]?.varName !== undefined
            ? (current.slots[ptr.name]?.varName ?? ptr.name)
            : ptr.kind === 'global'
              ? `@${ptr.name}`
              : describeAddress(state, resolved.addr);
        const addr = resolved.addr;
        record(
          'exec',
          `store ${operandText(stored)} → ${operandText(ptr)} — write ${origin} = ${show(value)}.`,
          id,
          (draft) => {
            writeCell(draft, addr, value);
            // Keep the data panel and the slot mirrors in step with memory.
            const block = findBlock(draft, addr);
            if (block?.kind === 'global' && block.name !== undefined && addr === block.start) {
              draft.globals[block.name] = value;
            }
            draft.frames = draft.frames.map((frame, index) => {
              const hit = Object.values(frame.slots).find(
                (slot) => slot.addr === addr && addr !== 0,
              );
              if (hit === undefined) return frame;
              // Frames older than the top are shared with history: copy first.
              const source = index === draft.frames.length - 1 ? frame : { ...frame, slots: { ...frame.slots } };
              source.slots[hit.name] = { ...source.slots[hit.name], value, updatedAt: steps.length };
              return source;
            });
          },
        );
        nextInstr();
        return null;
      }

      case 'ptradd': {
        const [base, offset] = ops;
        if (base === undefined || offset === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const from = read(base);
        const cells = read(offset);
        const result = wrap32(from + cells);
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = ptradd ${operandText(base)}, ${operandText(offset)} — move ${cells} cells from ${show(from)} to ${show(result)}.`,
          id,
          (draft) => setSlot(draft, resultName, result),
        );
        nextInstr();
        return null;
      }

      case 'ptrdiff': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const a = read(left);
        const b = read(right);
        if (a === b) {
          const resultName = instr.result;
          record(
            'exec',
            `${resultName} = ptrdiff ${operandText(left)}, ${operandText(right)} — both are ${show(a)}, so 0 cells apart.`,
            id,
            (draft) => setSlot(draft, resultName, 0),
          );
          nextInstr();
          return null;
        }
        const blockA = a === 0 ? undefined : findBlock(state, a) ?? onePastEnd(state, a);
        const blockB = b === 0 ? undefined : findBlock(state, b) ?? onePastEnd(state, b);
        if (blockA === undefined || blockB === undefined || blockA.start !== blockB.start) {
          return fail(
            `Runtime error: subtracting unrelated pointers — ${describeAddress(state, a)} and ${describeAddress(state, b)} are not in the same block.`,
            id,
          );
        }
        const result = wrap32(a - b);
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = ptrdiff ${operandText(left)}, ${operandText(right)} — ${show(a)} − ${show(b)} = ${result} cells apart.`,
          id,
          (draft) => setSlot(draft, resultName, result),
        );
        nextInstr();
        return null;
      }

      case 'add':
      case 'sub':
      case 'mul':
      case 'sdiv':
      case 'srem': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const a = read(left);
        const b = read(right);
        if ((instr.opcode === 'sdiv' || instr.opcode === 'srem') && b === 0) {
          return fail(
            instr.opcode === 'sdiv'
              ? 'Runtime error: division by zero'
              : 'Runtime error: modulo by zero',
            id,
          );
        }
        let value: number;
        let symbol: string;
        if (instr.opcode === 'add') {
          value = wrap32(a + b);
          symbol = '+';
        } else if (instr.opcode === 'sub') {
          value = wrap32(a - b);
          symbol = '-';
        } else if (instr.opcode === 'mul') {
          value = mul32(a, b);
          symbol = '*';
        } else if (instr.opcode === 'sdiv') {
          value = div32(a, b);
          symbol = '/';
        } else {
          value = rem32(a, b);
          symbol = '%';
        }
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = ${instr.opcode} ${operandText(left)}, ${operandText(right)} — ${a} ${symbol} ${b} = ${value}.`,
          id,
          (draft) => setSlot(draft, resultName, value),
        );
        nextInstr();
        return null;
      }

      case 'icmp': {
        const [left, right] = ops;
        if (left === undefined || right === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const a = read(left);
        const b = read(right);
        const predicate = instr.predicate ?? 'ne';
        const holds = compare32(predicate, a, b);
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = icmp ${predicate} ${operandText(left)}, ${operandText(right)} — is ${a} ${predicate} ${b}? ${holds ? 'yes → 1' : 'no → 0'}.`,
          id,
          (draft) => setSlot(draft, resultName, holds ? 1 : 0),
        );
        nextInstr();
        return null;
      }

      case 'zext': {
        const source = ops[0];
        if (source === undefined || instr.result === undefined) {
          nextInstr();
          return null;
        }
        const value = read(source) !== 0 ? 1 : 0;
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = zext to ${instr.toType ?? 'i32'} — widen ${value} to 32 bits.`,
          id,
          (draft) => setSlot(draft, resultName, value),
        );
        nextInstr();
        return null;
      }

      case 'br': {
        if (ops.length === 1 && ops[0].kind === 'label') {
          const target = ops[0].blockId;
          const label = module.blocks[target]?.label ?? `block${target}`;
          record('branch', `br label %${label} — unconditional jump to ${label}.`, id, () => {});
          jumpTo(target);
          return null;
        }
        const [cond, trueOp, falseOp] = ops;
        if (cond === undefined || trueOp?.kind !== 'label' || falseOp?.kind !== 'label') {
          nextInstr();
          return null;
        }
        const value = read(cond);
        const takenId = value !== 0 ? trueOp.blockId : falseOp.blockId;
        const takenLabel = module.blocks[takenId]?.label ?? `block${takenId}`;
        record(
          'branch',
          `br ${operandText(cond)} → ${value !== 0 ? 'true' : 'false'} path — jump to %${takenLabel}.`,
          id,
          () => {},
        );
        jumpTo(takenId);
        return null;
      }

      case 'call': {
        const calleeName = instr.callee ?? '';
        const builtin = BUILTIN_CALLS[calleeName];
        if (builtin !== undefined) return builtinCall(builtin, instr, ops, current);
        const callee = module.functions.find((fn) => fn.name === calleeName && !fn.isDeclaration);
        if (callee === undefined) {
          return finish(
            'error',
            `Call to \`${calleeName}\`, which has no body in this module (prototypes cannot be executed).`,
            null,
          );
        }
        if (returnStack.length + 1 >= SIM_CALL_DEPTH_LIMIT) {
          return finish(
            'error',
            `Call depth limit of ${SIM_CALL_DEPTH_LIMIT} reached — stopping to protect the browser.`,
            null,
          );
        }
        const argValues = ops.map((operand) => read(operand));
        const argList = argValues.map((value) => String(value)).join(', ');
        const resultName = instr.result;
        returnStack.push({ func, blockId, instrIndex: instrIndex + 1 });
        record(
          'call',
          `call ${instr.type} @${calleeName}(${argList}) — push a new frame for ${calleeName} (the stack grows).`,
          id,
          (draft) => {
            if (resultName !== undefined) {
              // Reserve the result cell in the caller frame before we leave it.
              const caller = mutableTopFrame(draft);
              if (caller !== null) {
                caller.slots[resultName] = {
                  name: resultName,
                  value: 0,
                  allocatedAt: steps.length,
                  updatedAt: steps.length,
                };
              }
            }
            draft.frames.push({
              funcName: callee.name,
              slots: Object.fromEntries(
                callee.params.map((param, index) => [
                  param.name,
                  {
                    name: param.name,
                    value: argValues[index] ?? 0,
                    allocatedAt: steps.length,
                    updatedAt: steps.length,
                  },
                ]),
              ),
              entryStep: steps.length,
            });
          },
        );
        func = callee;
        blockId = callee.blockIds[0] ?? -1;
        instrIndex = 0;
        return null;
      }

      case 'ret': {
        const returned = ops[0];
        const value = returned !== undefined ? read(returned) : null;
        const popped = current;
        const released = popped !== undefined ? frameBytes(popped) : 0;
        const site = returnStack.pop();

        // If the callee's caller expects a result, find the name it was given.
        let callerResultName: string | null = null;
        if (site !== undefined) {
          const callerBlock = module.blocks[site.blockId];
          const callerInstrId = callerBlock?.instrIds[site.instrIndex - 1];
          const callerInstr = callerInstrId !== undefined ? module.instrs[callerInstrId] : undefined;
          if (callerInstr?.opcode === 'call' && callerInstr.result !== undefined) {
            callerResultName = callerInstr.result;
          }
        }

        const retValue = value;
        const frameToken = popped?.entryStep;
        record(
          'ret',
          returned !== undefined
            ? `ret ${operandText(returned)} — ${retValue} leaves ${popped?.funcName ?? 'the frame'}; pop its frame and release ${released} bytes.`
            : `ret void — pop the frame of ${popped?.funcName ?? 'the caller'} and release ${released} bytes.`,
          id,
          (draft) => {
            // The frame's stack blocks die with it: later access is a
            // use-after-return, caught by `deref`.
            for (const block of draft.allocations) {
              if (block.kind === 'stack' && block.frameToken === frameToken) block.freed = true;
            }
            draft.frames.pop();
            if (site === undefined) {
              draft.returnValue = retValue;
              return;
            }
            if (callerResultName !== null && retValue !== null) {
              const caller = mutableNewTopFrame(draft);
              const existing = caller?.slots[callerResultName];
              if (caller !== null && existing !== undefined) {
                caller.slots[callerResultName] = {
                  ...existing,
                  value: retValue,
                  updatedAt: steps.length,
                };
              }
            }
          },
          popped,
        );

        if (site === undefined) {
          return finish('finished', null, retValue);
        }
        func = site.func;
        blockId = site.blockId;
        instrIndex = site.instrIndex;
        return null;
      }

      case 'unreachable':
        return finish('error', 'Execution reached `unreachable` — the IR promises this path cannot run.', null);
    }

    nextInstr();
    return null;
  };

  /** A block that ends exactly at `addr` (the one-past-the-end pointer). */
  function onePastEnd(state: SimState, addr: number): SimAlloc | undefined {
    for (let index = state.allocations.length - 1; index >= 0; index -= 1) {
      const block = state.allocations[index];
      if (!block.freed && block.size > 0 && addr === block.start + block.size) return block;
    }
    return undefined;
  }

  /** The five calls the language provides itself; they never push a frame. */
  const builtinCall = (
    name: BuiltinName,
    instr: { id: number; result?: string },
    ops: IROperand[],
    current: SimFrame | undefined,
  ): SimulationResult | null => {
    const values = ops.map((operand) => readOperand(current, operand, globalAddress));
    const resultName = instr.result;

    /** Perform `effect` and, if the call yields one, publish its result. */
    const callStep = (description: string, effect: (draft: SimState) => void, result?: number): void => {
      record('call', description, instr.id, (draft) => {
        effect(draft);
        if (resultName === undefined || result === undefined) return;
        const top = mutableTopFrame(draft);
        if (top === null) return;
        const existing = top.slots[resultName];
        top.slots[resultName] = {
          name: resultName,
          value: result,
          allocatedAt: existing?.allocatedAt ?? steps.length,
          updatedAt: steps.length,
        };
      });
      instrIndex += 1;
    };

    switch (name) {
      case 'malloc': {
        const asked = Number.isFinite(values[0]) ? Math.trunc(values[0]) : 1;
        const cells = Math.max(1, Math.min(asked, SIM_MAX_ALLOC_CELLS));
        const start = state.nextAddr;
        if (start + spanOf(cells) > SIM_MEMORY_LIMIT + 1) {
          return fail(
            `Runtime error: out of memory — malloc(${asked}) needs ${cells} cells and only ${SIM_MEMORY_LIMIT - start + 1} remain.`,
            instr.id,
          );
        }
        callStep(
          `call @malloc(${asked}) — reserve ${cells} cell${cells === 1 ? '' : 's'} on the heap at ${show(start)}.`,
          (draft) => {
            allocate(draft, cells, 'heap');
          },
          start,
        );
        return null;
      }

      case 'free':
      case 'delete': {
        const target = values[0] ?? 0;
        const strict = name === 'delete';
        if (target === 0) {
          if (strict) {
            return fail(
              'Runtime error: delete requires a heap pointer — deleting null is not allowed.',
              instr.id,
            );
          }
          callStep('call @free(0) — free(null) is a no-op.', () => {}, 0);
          return null;
        }
        const block = findBlockAny(state, target);
        if (block === undefined || block.kind !== 'heap' || block.start !== target) {
          return fail(
            `Runtime error: ${name} requires a heap pointer or null — ${describeAddress(state, target)} was never returned by malloc/new.`,
            instr.id,
          );
        }
        if (block.freed) {
          return fail(
            strict
              ? 'Runtime error: double free/delete — this block was already released.'
              : 'Runtime error: double free — this block was already released.',
            instr.id,
          );
        }
        const size = block.size;
        callStep(
          `call @${name}(${operandText(ops[0] ?? { kind: 'const', value: 0, type: 'i32' })}) — release ${size} cell${size === 1 ? '' : 's'} at ${show(target)}.`,
          (draft) => {
            const live = draft.allocations.find(
              (candidate) => candidate.start === target && candidate.kind === 'heap',
            );
            if (live !== undefined) live.freed = true;
          },
          0,
        );
        return null;
      }

      case 'print': {
        const value = values[0] ?? 0;
        callStep(
          `call @print(${value}) — write ${show(value)} to the output, followed by a newline.`,
          (draft) => {
            draft.output += `${value}\n`;
          },
          value,
        );
        return null;
      }

      case 'printf': {
        const format = ops[0]?.kind === 'string' ? ops[0].value : '';
        const formatted = formatPrintf(format, values.slice(1));
        const written = formatted ?? format;
        callStep(
          `call @printf(${operandText(ops[0] ?? { kind: 'const', value: 0, type: 'i32' })}${values.slice(1).map((value) => `, ${value}`).join('')}) — write ${JSON.stringify(written)} to the output.`,
          (draft) => {
            draft.output += written;
          },
          0,
        );
        return null;
      }
    }
  };

  for (;;) {
    if (steps.length >= SIM_STEP_LIMIT) {
      return finish(
        'step-limit',
        `Execution stopped at the ${SIM_STEP_LIMIT}-step limit. This usually means a very long or non-terminating loop.`,
        null,
      );
    }
    const done = stepOnce();
    if (done !== null) return done;
  }
}
