# Mini-C Compiler Visualizer

An educational Next.js app for exploring how a small C-like program ("Mini-C") moves through
compiler stages: source → tokens → AST → semantic analysis → LLVM-style IR.

This app uses its own educational Mini-C compiler written in TypeScript. Its output resembles
Clang/LLVM output but is not produced by Clang or LLVM. Everything runs in the browser; user code
is never executed.

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
   Analysis, Intermediate Representation. Generated Assembly is reserved for a later milestone and
   shows "Coming soon".
4. Click tokens, AST nodes, symbols, or IR instructions to see them highlighted across the editor
   and the other stages. Selecting a diagnostic jumps to the stage that reported it.

## Supported Mini-C subset

- Types: `int` and `void` (functions only; no pointers, arrays, or structs).
- Declarations: global variables, function definitions with parameters, local variables with
  optional initialisers.
- Statements: expression statements, `if`/`else`, `while`, `for`, `break`, `continue`, `return`,
  and blocks.
- Expressions: integer literals, variable references, function calls, parentheses, unary `-` and
  `!`, binary `+ - * / % < > <= >= == != && ||`, and the compound assignments
  `+= -= *= /= %=` (plus plain `=`).
- The lexer recognises reserved-but-unsupported keywords (`char`, `float`, `struct`, …) and
  reports them as errors rather than silently mis-lexing them.

Not supported (reported as friendly errors, never executed): bitwise operators, addresses,
strings, arrays, `#include`/preprocessor directives, and every other C construct.

## Limits and safety

- Source is capped at **20,000 characters / 800 lines**. Oversized input refuses to compile with
  a friendly message instead of freezing the tab.
- The compiler pipeline is pure TypeScript (`lib/compiler`). It never spawns processes, never
  calls a server, and never runs user code — it only analyses it.
- `compile()` is total: it catches unexpected internal failures and reports them as a diagnostic
  instead of crashing the UI. Each stage view is additionally wrapped in an error boundary.

## Honesty model

- The compiler is an original educational implementation under `lib/compiler`. Nothing here is
  Clang, LLVM, WebAssembly, or a wrapper around them.
- IR output is **LLVM-style**: it uses LLVM-like syntax (`alloca`, `load`, `store`, `add nsw`,
  `icmp`/`zext`, `br`, `ret`, `call`) so it reads like real IR, but it is produced by this app's
  own generator and printer. It is not guaranteed to assemble with a real LLVM toolchain.
- Provenance badges mark every artifact: *generated* (derived from your source), *derived* (from
  another artifact), or *illustrative* (extra teaching content).
- The assembly stage is intentionally disabled and marked "Coming soon" rather than faked.

## Diagnostics

Errors and warnings carry stable codes with in-app explanations:

- `E1xxx` — lexical errors (unsupported characters, malformed literals, reserved keywords).
- `E2xxx` — syntax errors (the parser stops at the first one).
- `E3xxx` — semantic errors (undeclared identifiers, redefinitions, type mismatches, wrong
  argument counts, missing returns). All semantic errors are reported, not just the first.
- `W4001` / `W4002` — warnings (unused variable, missing return in a non-`void` function).
  Warnings never block later stages.

Lexical errors block parsing; syntax errors block semantic analysis and IR; semantic errors block
IR. Blocked stages say so explicitly and link to the first error.

## Current status

All planned milestones (1–6) are complete: application shell, stage navigator, About dialog,
provenance badges, example picker, Monaco editor with cross-stage highlighting, compile flow,
lexer, Token Explorer, parser and AST Explorer (React Flow graph + accessible outline), semantic
analysis with a clickable symbol table, LLVM-style IR generation with a per-instruction view and
Copy IR, per-code and per-opcode explanations, source size limits, and 12 built-in examples
(8 learning programs and 4 that demonstrate specific errors).

Generated assembly remains reserved for a later milestone.
