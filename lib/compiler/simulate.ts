import { div32, mul32, rem32, wrap32 } from './int32';
import type { IRFunction, IRModule, IROperand } from './types';

/**
 * A trace-first interpreter over the unoptimised IR (SPEC §13.3).
 *
 * The simulated machine has a data segment (globals), an empty heap (Mini-C
 * has no dynamic allocation) and a stack of frames. Every named IR value
 * lives in a 4-byte cell inside its frame, so you can watch cells and frames
 * being occupied on `call`/`alloca` and released on `ret`.
 *
 * The interpreter is pure, total and deterministic: every step records a
 * copy-on-write snapshot of the machine state, so stepping back is just
 * moving an index. Limits: 5000 steps, call depth 100.
 */

export const SIM_STEP_LIMIT = 5000;
export const SIM_CALL_DEPTH_LIMIT = 100;

export interface SimSlot {
  name: string; // SSA value name, e.g. '%x' or '%0'
  varName?: string; // source variable, when this slot is an alloca
  value: number;
  allocatedAt: number; // step index that reserved this cell
  updatedAt: number; // step index that last wrote it
}

export interface SimFrame {
  funcName: string;
  slots: Record<string, SimSlot>;
  entryStep: number;
}

export interface SimState {
  globals: Record<string, number>;
  frames: SimFrame[]; // last frame = currently executing
  returnValue: number | null; // set when main returns
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

function frameBytes(frame: SimFrame): number {
  return Object.keys(frame.slots).length * 4;
}

/**
 * Copy-on-write snapshot: the top frame is copied (it is the only one that
 * may change); older frames are shared, which keeps snapshots cheap and
 * guarantees stepping back cannot observe later writes.
 */
function cloneState(state: SimState): SimState {
  return {
    globals: { ...state.globals },
    frames: state.frames.map((frame, index) =>
      index === state.frames.length - 1 ? { ...frame, slots: { ...frame.slots } } : frame,
    ),
    returnValue: state.returnValue,
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

function readOperand(
  frame: SimFrame | undefined,
  globals: Record<string, number>,
  operand: IROperand,
): number {
  switch (operand.kind) {
    case 'const':
      return wrap32(operand.value);
    case 'global':
      return globals[operand.name] ?? 0;
    case 'value':
      return frame?.slots[operand.name]?.value ?? 0;
    case 'label':
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
  }
}

function compare(predicate: string, left: number, right: number): boolean {
  switch (predicate) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'slt':
      return left < right;
    case 'sle':
      return left <= right;
    case 'sgt':
      return left > right;
    case 'sge':
      return left >= right;
    default:
      return left !== right;
  }
}

/** Describe a value the way a person reads it: signed, with hex in parens. */
function show(value: number): string {
  return `${value} (0x${(value >>> 0).toString(16)})`;
}

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
  const globals: Record<string, number> = {};
  for (const global of module.globals) globals[global.name] = wrap32(global.init);

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
    };
  };

  const finish = (outcome: SimOutcome, message: string | null, result: number | null): SimulationResult => ({
    steps,
    outcome,
    message,
    result,
  });

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

    switch (instr.opcode) {
      case 'alloca': {
        if (instr.result === undefined) {
          nextInstr();
          return null;
        }
        const name = instr.result;
        const varName = instr.varName;
        record(
          'exec',
          `${name} = alloca — reserve 4 bytes for ${varName ?? 'a local'}.`,
          id,
          (draft) => setSlot(draft, name, 0, varName),
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
        let value = 0;
        let origin = operandText(ptr);
        if (ptr.kind === 'value' && current?.slots[ptr.name]?.varName !== undefined) {
          value = current.slots[ptr.name]?.value ?? 0;
          origin = current.slots[ptr.name]?.varName ?? ptr.name;
        } else if (ptr.kind === 'global') {
          value = state.globals[ptr.name] ?? 0;
          origin = `@${ptr.name}`;
        } else if (ptr.kind === 'value') {
          value = current?.slots[ptr.name]?.value ?? 0;
        }
        const resultName = instr.result;
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
        const value = readOperand(current, state.globals, stored);
        let origin = operandText(ptr);
        if (ptr.kind === 'value' && current?.slots[ptr.name]?.varName !== undefined) {
          origin = current.slots[ptr.name]?.varName ?? ptr.name;
        } else if (ptr.kind === 'global') {
          origin = `@${ptr.name}`;
        }
        record(
          'exec',
          `store ${operandText(stored)} → ${operandText(ptr)} — write ${origin} = ${show(value)}.`,
          id,
          (draft) => {
            if (ptr.kind === 'global') draft.globals[ptr.name] = value;
            else if (ptr.kind === 'value') setSlot(draft, ptr.name, value);
          },
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
        const a = readOperand(current, state.globals, left);
        const b = readOperand(current, state.globals, right);
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
        const divNote =
          (instr.opcode === 'sdiv' || instr.opcode === 'srem') && b === 0
            ? ' (division by zero yields 0: Mini-C has no UB model)'
            : '';
        const resultName = instr.result;
        record(
          'exec',
          `${resultName} = ${instr.opcode} ${operandText(left)}, ${operandText(right)} — ${a} ${symbol} ${b} = ${value}${divNote}.`,
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
        const a = readOperand(current, state.globals, left);
        const b = readOperand(current, state.globals, right);
        const predicate = instr.predicate ?? 'ne';
        const holds = compare(predicate, a, b);
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
        const value = readOperand(current, state.globals, source) !== 0 ? 1 : 0;
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
        const value = readOperand(current, state.globals, cond);
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
        const argValues = ops.map((operand) => readOperand(current, state.globals, operand));
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
        const value = returned !== undefined ? readOperand(current, state.globals, returned) : null;
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
        record(
          'ret',
          returned !== undefined
            ? `ret ${operandText(returned)} — ${retValue} leaves ${popped?.funcName ?? 'the frame'}; pop its frame and release ${released} bytes.`
            : `ret void — pop the frame of ${popped?.funcName ?? 'the caller'} and release ${released} bytes.`,
          id,
          (draft) => {
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
