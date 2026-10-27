# Mini-C Compiler Visualizer

An educational Next.js app for exploring how a small C-like program ("Mini-C") moves through
compiler stages: source → tokens → AST → semantic analysis → LLVM-style IR → IR optimisation → x86-64 assembly → execution (VM simulation).

This app uses its own educational Mini-C compiler written in TypeScript. Its output resembles
Clang/LLVM output but is not produced by Clang or LLVM. Everything runs in the browser; user code
is never executed natively, but can be interactively simulated in a sandboxed virtual machine.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Other commands:

```bash
npm run build
npm run lint
npm test
```

## Editor

The code editor is Monaco, loaded through `@monaco-editor/react` with its default CDN loading.
The first editor load therefore needs an internet connection. The `monaco-editor` package is not
bundled into the app.

## How to use

1. Pick an example from the example picker (or type your own Mini-C program).
2. Press **Compile**. The app runs the whole pipeline in the browser, synchronously and
   deterministically — the same source always produces the same result.
3. Step through the stage navigator: Source, Lexical Analysis, Syntax Analysis (AST), Semantic
   Analysis, Intermediate Representation, Optimization, Generated Assembly, and Execution (VM).
   Alternatively, use step-through mode to advance the pipeline one stage at a time.
4. Click tokens, AST nodes, symbols, IR instructions, or assembly lines to see them highlighted
   across the editor and the other stages. Selecting a diagnostic jumps to the stage that reported it.
5. In the Optimization stage, switch passes on and off and click any transformation to see its
   original instruction, its result, why it happened and why it is safe — synchronised with the
   source and both IR panes. The Assembly and Execution stages offer an Original/Optimised switch
   for the IR they work from; switching versions rewinds execution.
6. In the Execution (VM) stage, step forward and backward or run the program to see stack frames,
   global variables, and memory mutations change in real time.

## Supported Mini-C subset

- Types: `int`, `void` (function returns only), pointers `int *` (including `int **`), arrays
  `int a[3]` / `int m[2][3]`, and `struct` / `union` records with named fields. A field may be a
  pointer, an array, or another record — nesting works to any depth (`t.m.l.v`), and `struct P
  a[3]` is an array of records.
- Declarations: global variables with integer or `{ … }` initialisers, record declarations,
  function definitions with parameters, local variables with optional initialisers or
  `{ … }` lists, and `sizeof(type)`.
- Statements: expression statements, `if`/`else`, `while`, `for`, `break`, `continue`,
  `return`, blocks, `print(value)`, `printf("format", …)` and `delete ptr;`.
- Expressions: integer literals, string literals (as a `printf` format), variable references,
  array indexing `a[i]`, field access `p.x` / `p->y`, address-of `&x`, dereference `*p`,
  pointer arithmetic (`p + n`, `p - n`, `p - q`, `p == q`, `p != q`), function calls,
  parentheses, unary `-` and `!`, binary `+ - * / % < > <= >= == != && ||`, the compound
  assignments `+= -= *= /= %=`, prefix/postfix `++` / `--`, and `new T` / `new T[n]`.
- Dynamic memory: `malloc(n)` / `free(p)` and `new` / `delete` reserve and release heap
  cells; the Execution stage lists each block (with its address range) as it is allocated and
  struck through once it is released.
- The lexer recognises reserved-but-unsupported keywords (`char`, `float`, `switch`, …) and
  reports them as errors rather than silently mis-lexing them.
- Everything runs in the browser on this app's own interpreter: a program is never turned
  into machine code and never executed natively.

Not supported (each reported as a friendly error, never executed): `char` and text used as values
outside a `printf` format, bitwise and shift operators (`&` is address-of only), the ternary `?:`,
the comma operator, `do`/`while`, `switch`/`case`, `goto`, floating point, casts, `typedef` /
`enum` / `const` / `static` / `extern` / `unsigned`, variable-length array sizes (`int a[n]`,
`int a[]`, `int f(int a[][3])`, `sizeof(int[3])`), hexadecimal literals (a `0x10` is a syntax
error) and octal notation (a leading zero is *not* octal here — `010` is the decimal ten),
passing or
returning a record by value, whole-record assignment, non-literal global initialisers, function
pointers, varargs, `#define` and other preprocessor directives (`#include <…>` lines are simply
ignored), and every other C construct outside the list above. Each one is caught at the stage
that owns it and explained — nothing here is ever silently mis-compiled.

## Optimization

The Optimization stage sits between IR and assembly and compares two versions of the same module:
the **original** IR the compiler produced, and an **optimised** clone of it. Four passes run in a
fixed order, all written in TypeScript for this project — they are this app's own passes, not
LLVM's, and no LLVM is involved:

1. **Local Value Forwarding** — reuses a value already known inside a basic block instead of
   re-reading memory (store → load and load → load), dropping the redundant load.
2. **Constant & Branch Folding** — evaluates pure instructions whose operands are all literals
   with the same 32-bit helpers the interpreter uses, and reduces a `br` with a constant condition
   to an unconditional branch.
3. **Block-Local CSE** — computes the same pure expression once per block and merges the duplicate
   into the earlier result.
4. **Dead-Code Elimination** — deletes arithmetic, comparisons, conversions and loads whose
   results nothing reads (stores, calls, allocas and terminators are never candidates).

What the stage shows:

- Side-by-side **original / optimised IR** with a per-instruction status marker, plus a written
  legend (`=` unchanged, `±` changed, `→` replaced, `−` removed, `+` added) so no state is
  communicated by colour alone.
- **Pass toggles** (each with its applied/clean/off status), an **optimisation timeline** with the
  instruction count after every pass, and headline statistics (instructions before → after, removed,
  passes applied).
- A **transformations list**: every change records the original instruction, the result, why it
  happened and why it is safe. Before/after text is *derived* from the two modules; the reason and
  safety notes are *illustrative* hand-written prose, provenance-badged as such.
- **Synchronised selection** across the editor, both IR panes and the explanation panel. Mapping
  uses instruction IDs and AST source ranges only — never text matching — and a selection that
  cannot be mapped says why instead of guessing.

Six built-in examples belong to this stage — one per pass plus a tour that runs all four — and they
are grouped under **Optimisation** in the example picker. Each declares which passes it advertises,
and a test runs every advertised pass **on its own** against that example, failing if it produces no
transformation, so an example can never claim a pass it does not actually show.

The optimiser never mutates the compiler's own module (it works on a clone), never adds
instructions, keeps every 32-bit wrap-around/division-by-zero rule intact, and always leaves valid
terminators. `npm test` includes a suite that runs the whole example set through every pass subset
and asserts the optimised and unoptimised IR produce identical interpreter results.

## Limits and safety

- Source is capped at **20,000 characters / 800 lines**. Oversized input refuses to compile with
  a friendly message instead of freezing the tab.
- The compiler pipeline is pure TypeScript (`lib/compiler`). It never spawns processes, never
  calls a server, and never runs user code natively. The execution view is an in-browser interpreter
  capped at 5,000 steps and 100 call frames to ensure tab safety.
- `compile()` is total: it catches unexpected internal failures and reports them as a diagnostic
  instead of crashing the UI. Each stage view is additionally wrapped in an error boundary.

## Honesty model

- The compiler is an original educational implementation under `lib/compiler`. Nothing here is
  Clang, LLVM, WebAssembly, or a wrapper around them.
- IR output is **LLVM-style**: it uses LLVM-like syntax (`alloca`, `load`, `store`, `add nsw`,
  `icmp`/`zext`, `br`, `ret`, `call`) so it reads like real IR, but it is produced by this app's
  own generator and printer. It is not guaranteed to assemble with a real LLVM toolchain.
- Provenance badges mark every artifact: *generated* (derived from your source), *derived* (from
  another artifact), *illustrative* (extra teaching content), or *simulated* (derived from VM execution).
- The assembly stage lowers the selected IR version (original or optimised) to naive x86-64
  assembly text (Intel syntax) with exact line-to-IR mappings. It is illustrative text and is not
  assembled or executed natively.
- The VM execution stage runs the selected IR version in a trace-first interpreter with 32-bit C
  integer semantics, recording full stack and frame states for every step, plus the data segment,
  the heap blocks (`malloc`/`new`/`free`/`delete`) and everything `print`/`printf` wrote. It
  reports runtime failures — null dereference, use-after-free, double free, out-of-bounds index,
  invalid or unrelated pointers, division and modulo by zero — as errors instead of guessing.
- The optimization stage is a teaching diff: the four passes are this app's own TypeScript code,
  their before/after text is derived from the two IR modules, and the prose that explains each
  change is illustrative.

## Diagnostics

Errors and warnings carry stable codes with in-app explanations:

- `E1xxx` — lexical errors (unsupported characters, malformed literals, unterminated strings,
  reserved keywords).
- `E2xxx` — syntax errors (the parser stops at the first one).
- `E3xxx` — semantic errors (undeclared identifiers, redefinitions, type mismatches, unknown
  record members, wrong argument counts, missing returns). All semantic errors are reported, not
  just the first. Constructs this dialect deliberately does not lower — a record passed by value,
  a non-literal global initialiser, an array with no size — come back as `E1010` with the stage
  that found them.
- `W4001` / `W4002` — warnings (unused variable, missing return in a non-`void` function).
  Warnings never block later stages.

Lexical errors block parsing; syntax errors block semantic analysis and IR; semantic errors block
IR. Blocked stages say so explicitly and link to the first error.

## Current status

All 8 pipeline stages and interactive features are complete:
- Application shell with resizable panes and theme switcher (Dark, Light, Sepia, System)
- Pipeline stage navigator and step-through execution mode
- Monaco code editor with cross-stage highlighting and diagnostic markers
- 31 built-in examples (22 learning programs and 9 error demonstrations), including six that
  showcase the Optimization stage one pass at a time, and programs covering arrays,
  two-dimensional arrays, pointers and `malloc`, structs and unions, and recursion with `printf`
- Lexer and Token Explorer (filtering, token inspector, legend)
- Recursive-descent parser and AST Explorer (React Flow graph + accessible outline)
- Semantic analysis with clickable symbol table, interactive Scope Tree canvas, and diagnostics
- LLVM-style IR generation with per-instruction inspector and Copy IR
- Optimization stage with four passes (value forwarding, constant/branch folding, block-local CSE,
  dead-code elimination), pass toggles, a per-pass timeline, a status legend, side-by-side IR and
  a per-transformation explanation
- Naive x86-64 assembly generation with 1:1 IR line mappings and Intel syntax (original or
  optimised IR)
- Browser-based execution simulator (VM) with reversible stepping, call frame inspection, stack/memory visualization, and output capture (original or optimised IR)
- 241 unit and snapshot tests covering the entire pipeline, including a feature suite for arrays,
  pointers, records, `print`/`printf` and the runtime checks, plus an optimizer-equivalence suite
  that runs every example through all 16 pass combinations
