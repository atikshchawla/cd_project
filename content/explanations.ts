import { typeToString as describeType } from '@/lib/compiler/typeutil';
import type { AstKind, IROpcode, Stage, TokenKind, Type } from '@/lib/compiler/types';

export interface StageExplanation {
  label: string;
  shortLabel: string;
  simple: string;
  technical: string;
  whyItMatters: string;
}

export const STAGE_ORDER: Stage[] = ['source', 'lex', 'parse', 'sema', 'ir', 'opt', 'asm', 'sim'];

export const STAGE_EXPLANATIONS: Record<Stage, StageExplanation> = {
  source: {
    label: 'Source',
    shortLabel: 'Source',
    simple:
      'This is the Mini-C program you write. The compiler reads it as plain text, one character at a time.',
    technical:
      'The source is normalised to line-feed line endings and hashed. Every later artifact records character offsets into this text, which is how the stages stay linked.',
    whyItMatters:
      'Source ranges are the shared coordinates for the whole pipeline. A token, syntax node or instruction can always point back to the exact characters that produced it.',
  },
  lex: {
    label: 'Lexical Analysis',
    shortLabel: 'Lexical',
    simple:
      'The lexer groups characters into words called tokens: names, numbers, keywords and punctuation. Comments and whitespace are skipped.',
    technical:
      'The lexer scans left to right, applies longest-match rules to operators, records a character range for every token, and reports unsupported or invalid characters without stopping.',
    whyItMatters:
      'Tokens are the compiler’s first structured view of the program. They are also the smallest unit you can select to trace a piece of text through the pipeline.',
  },
  parse: {
    label: 'Syntax Analysis (AST)',
    shortLabel: 'Syntax',
    simple:
      'The parser checks that the tokens form valid Mini-C sentences and builds a tree that shows how they nest.',
    technical:
      'A hand-written recursive-descent parser applies the Mini-C grammar with precedence climbing. It produces an abstract syntax tree (AST) whose nodes carry exact source ranges.',
    whyItMatters:
      'The tree removes irrelevant punctuation and makes structure explicit: which expression is inside which statement, and which operator applies first.',
  },
  sema: {
    label: 'Semantic Analysis',
    shortLabel: 'Semantics',
    simple:
      'The compiler checks meaning: every name must be declared, types must fit, calls must use the right number of arguments, and break must be inside a loop.',
    technical:
      'A scope-stack walk records symbols and scopes, annotates every expression with a type, resolves each name to its declaration, and collects multiple diagnostics instead of stopping at the first.',
    whyItMatters:
      'A program can be grammatically valid and still be wrong. Semantic analysis catches those mistakes before any intermediate code is generated.',
  },
  ir: {
    label: 'Intermediate Representation',
    shortLabel: 'IR',
    simple:
      'The compiler rewrites the program in a small, regular language of instructions and labelled blocks. This app prints it in an LLVM-like style.',
    technical:
      'Generation uses an unoptimised, -O0-like shape: locals live in stack slots created by alloca, values move through load and store, and every basic block ends with exactly one terminator. The IR style uses opaque pointers.',
    whyItMatters:
      'The intermediate representation sits between human-readable C and machine instructions. It is where control flow, values and data flow become explicit and checkable.',
  },
  opt: {
    label: 'Optimization',
    shortLabel: 'Optimize',
    simple:
      'The same program can be written with fewer instructions. Four small passes rewrite a copy of the IR, and this stage shows exactly what each one changed in your program.',
    technical:
      'Local value forwarding, constant and branch folding, block-local common-subexpression elimination and dead-code elimination run in order on a deep clone of the IR — the IR stage keeps the original untouched. Every transformation is recorded against the instruction ID it came from and, through that instruction, against its AST node and source range, so the side-by-side view can be navigated by ID rather than by matching text.',
    whyItMatters:
      'Optimisation is where speed and correctness meet: every rewrite must provably mean the same thing as the code it replaced. Selecting a change connects the optimised instruction, the original instruction and the source expression that produced them.',
  },
  asm: {
    label: 'Generated Assembly',
    shortLabel: 'Assembly',
    simple:
      'Assembly is a low-level textual form of a program, close to what a processor executes. This stage lowers the IR to illustrative x86-64 assembly text.',
    technical:
      'The lowering is deliberately naive: every IR value lives in its own stack slot, arguments move through the standard integer registers, and each assembly line records the IR instruction it came from so the mapping is exact. The output uses Intel syntax.',
    whyItMatters:
      'Seeing the lowering from IR to assembly completes the story of how high-level structure becomes simple instructions and memory accesses.',
  },
  sim: {
    label: 'Execution (VM)',
    shortLabel: 'Execution',
    simple:
      'This stage runs the generated IR on a small simulated machine, one instruction at a time, and shows the stack, frames and memory as they change.',
    technical:
      'A trace-first interpreter executes the selected IR — original or optimised — with 32-bit C integer semantics. Every step records a snapshot of the machine: the data segment (globals), the stack of frames with their 4-byte cells, and the current instruction. Stepping back just moves an index through the recorded trace.',
    whyItMatters:
      'Watching execution step by step makes abstract ideas concrete: frames really occupy stack space, calls really push and returns really pop, and every value really lives somewhere.',
  },
};

export const ABOUT_STATEMENT =
  'This app uses its own educational Mini-C compiler written in TypeScript. Its output resembles Clang/LLVM output but is not produced by Clang or LLVM.';

export type ProvenanceKind = 'generated' | 'derived' | 'illustrative' | 'simulated';

export const PROVENANCE: Record<ProvenanceKind, { label: string; description: string }> = {
  generated: {
    label: 'generated',
    description: 'Produced directly by this app’s Mini-C compiler from your source.',
  },
  derived: {
    label: 'derived',
    description: 'Built from generated data for explanation, without adding compiler facts.',
  },
  illustrative: {
    label: 'illustrative',
    description: 'Hand-written teaching material, not output from the compiler.',
  },
  simulated: {
    label: 'simulated',
    description:
      'Produced by this app’s own IR interpreter. It models execution faithfully but is not a real CPU.',
  },
};

export const NOTHING_SELECTED =
  'Nothing is selected yet. Select a token, syntax node, symbol or instruction to see an explanation here.';

export const SELECTION_DETAILS_PENDING =
  'Select a token, syntax node, symbol or instruction to see its details here.';

export const SELECTION_UNAVAILABLE =
  'This item has no reliable counterpart in the other stages. The compiler only links items by IDs and source ranges, so this app does not guess.';

export const COMPILE_HINT = 'Press Compile or Ctrl/Cmd + Enter to run the compiler.';

export const COMPILE_IN_PROGRESS = 'Compiling…';

export const COMPILE_IN_PROGRESS_DETAIL =
  'Running this app’s Mini-C compiler on the current source.';

export const EMPTY_WORKSPACE =
  'Pick an example or type a program, then compile it to begin exploring the compiler stages.';

export const STUB_NOTE =
  'This stage is reserved for a later milestone and does not produce data in this build.';

export const STALE_BANNER =
  'Source changed — recompile to refresh the results. Highlighting and markers are cleared until you do.';

export interface TokenKindExplanation {
  label: string;
  simple: string;
}

export const TOKEN_KIND_ORDER: TokenKind[] = [
  'keyword',
  'identifier',
  'integer-literal',
  'string-literal',
  'operator',
  'punctuator',
  'directive',
];

export const TOKEN_KIND_EXPLANATIONS: Record<TokenKind, TokenKindExplanation> = {
  keyword: {
    label: 'Keyword',
    simple:
      'A word with a fixed meaning in Mini-C, such as int, if or return. You cannot use it as a variable name.',
  },
  identifier: {
    label: 'Identifier',
    simple:
      'A name chosen by the programmer. It can name a variable, a parameter or a function.',
  },
  'integer-literal': {
    label: 'Integer literal',
    simple:
      'A whole number written directly in the source. Mini-C integers are 32-bit signed values.',
  },
  'string-literal': {
    label: 'String literal',
    simple:
      'Text between double quotes, used as the format of printf. Escapes such as \\n and \\t are resolved by the parser.',
  },
  operator: {
    label: 'Operator',
    simple:
      'A symbol that combines, compares, assigns or changes values, such as +, = or ++.',
  },
  punctuator: {
    label: 'Punctuator',
    simple:
      'Punctuation that groups or separates parts of the program: parentheses, braces, semicolons and commas.',
  },
  directive: {
    label: 'Directive',
    simple:
      'A preprocessor line. #include <...> lines are kept as one token and ignored by the Mini-C compiler.',
  },
};

export const TOKEN_EMPTY = 'No tokens yet. Compile a program to see how the lexer splits it up.';

export const TOKEN_FILTER_LABEL = 'Filter by kind';

export const TOKEN_LEGEND_TITLE = 'Token categories';

export const TOKEN_LIMIT_NOTICE =
  'Showing the first 2,000 tokens only. Narrow the list with the kind filter to inspect the rest.';

export const TOKEN_COUNT_LABEL = 'tokens';

export const STALE_SELECTION_NOTE =
  'The source changed after this result was produced, so no reliable highlight mapping is shown.';

export const SOURCE_RANGE_NONE = 'No token overlaps this source range.';

export const SOURCE_RANGE_ONE = 'Exactly one token overlaps this range:';

export function sourceRangeMany(count: number): string {
  return `${count} tokens overlap this range. Select a token row to inspect one.`;
}

export const TOKEN_NOT_FOUND =
  'This token no longer exists in the current compile result. Select a token again.';

export interface AstKindExplanation {
  label: string;
  simple: string;
}

export const AST_KIND_EXPLANATIONS: Record<AstKind, AstKindExplanation> = {
  TranslationUnit: {
    label: 'Translation unit',
    simple: 'The whole program: every top-level declaration, in order.',
  },
  FunctionDecl: {
    label: 'Function declaration',
    simple: 'A function definition, or a prototype without a body.',
  },
  ParamDecl: {
    label: 'Parameter declaration',
    simple: 'One parameter of a function: its type and name.',
  },
  VarDecl: {
    label: 'Variable declaration',
    simple: 'An int variable being declared, optionally with an initial value.',
  },
  CompoundStmt: {
    label: 'Block',
    simple: 'A group of statements inside braces, which can declare local variables.',
  },
  DeclStmt: {
    label: 'Declaration statement',
    simple: 'A declaration used where a statement is allowed.',
  },
  ExprStmt: {
    label: 'Expression statement',
    simple: 'An expression that runs for its effect, followed by a semicolon.',
  },
  IfStmt: {
    label: 'If statement',
    simple: 'Runs the "then" part when the condition is non-zero, otherwise the "else" part.',
  },
  WhileStmt: {
    label: 'While loop',
    simple: 'Repeats the body while the condition stays non-zero.',
  },
  ForStmt: {
    label: 'For loop',
    simple: 'A loop with an initialiser, a condition and an increment step.',
  },
  ReturnStmt: {
    label: 'Return statement',
    simple: 'Gives a value back to the caller and leaves the function.',
  },
  BreakStmt: {
    label: 'Break statement',
    simple: 'Jumps out of the innermost loop.',
  },
  ContinueStmt: {
    label: 'Continue statement',
    simple: 'Skips to the next iteration of the innermost loop.',
  },
  NullStmt: {
    label: 'Empty statement',
    simple: 'A lone semicolon: it does nothing.',
  },
  BinaryOperator: {
    label: 'Binary operator',
    simple: 'Combines two values with an operator such as +, < or =.',
  },
  UnaryOperator: {
    label: 'Unary operator',
    simple: 'Changes one value with - , ! , ++ or -- before or after it.',
  },
  CompoundAssignOperator: {
    label: 'Compound assignment',
    simple: 'Combines and stores in one step, such as += or *=.',
  },
  CallExpr: {
    label: 'Function call',
    simple: 'A call to a function with its arguments.',
  },
  DeclRefExpr: {
    label: 'Name reference',
    simple: 'A use of a variable or function name that was declared elsewhere.',
  },
  IntegerLiteral: {
    label: 'Integer literal',
    simple: 'A whole number written directly in the source.',
  },
  ParenExpr: {
    label: 'Parenthesised expression',
    simple: 'Parentheses that keep an inner expression together on purpose.',
  },
  StringLiteral: {
    label: 'String literal',
    simple:
      'Text between double quotes. Only printf uses one, as its format; the node holds the decoded text with escapes resolved.',
  },
  ArraySubscriptExpr: {
    label: 'Array subscript',
    simple: 'One element of an array or pointer: base[index]. Indexing checks the bounds at run time.',
  },
  MemberExpr: {
    label: 'Field access',
    simple:
      'One field of a record: value.field through a struct, or pointer->field through a pointer to one.',
  },
  InitListExpr: {
    label: 'Initialiser list',
    simple: 'A brace-separated { ... } list that fills an array or a record, missing values stay zero.',
  },
  RecordDecl: {
    label: 'Record declaration',
    simple: 'A struct or union definition: the fields it holds and how many cells they occupy.',
  },
  FieldDecl: {
    label: 'Field declaration',
    simple: 'One field of a struct or union: its type, its name and its offset inside the record.',
  },
  SizeOfExpr: {
    label: 'sizeof expression',
    simple: 'How many cells a type occupies. It is folded to a constant during semantic analysis.',
  },
  NewExpr: {
    label: 'new expression',
    simple:
      'Allocates one object (new T) or an array (new T[n]) on the heap and evaluates to a pointer to it.',
  },
  DeleteStmt: {
    label: 'delete statement',
    simple:
      'Releases a block that new allocated. Deleting null or an already-released block stops the program.',
  },
  PrintStmt: {
    label: 'print / printf statement',
    simple:
      'Writes a value with print, or a formatted string with printf, to the output of the running program.',
  },
};

export const AST_GRAPH_LABEL = 'Graph';
export const AST_OUTLINE_LABEL = 'Outline';
export const AST_EXPAND_ALL = 'Expand all';
export const AST_MODE_LABEL = 'Syntax tree view';
export const AST_NO_RESULT =
  'Compile a program to build a syntax tree.';
export const AST_PARSE_FAILED =
  'No syntax tree: the parser reported an error and stopped before building one.';
export const AST_BLOCKED =
  'No syntax tree: the lexer reported errors, so the parser did not run.';
export const AST_NODE_COUNT_LABEL = 'nodes';
export const AST_CHILD_COUNT_LABEL = 'children';
export const AST_PANEL_TITLE = 'Selected node';
export const AST_EMPTY =
  'Select a node in the tree to see what it represents and where it came from.';
export const AST_NODE_NOT_FOUND =
  'This syntax node is not part of the current compile result. Select a node again.';
export const AST_NODE_KIND_LABEL = 'Kind';
export const AST_NODE_RANGE_LABEL = 'Source range';
export const AST_NODE_NAME_LABEL = 'Name';
export const AST_NODE_OP_LABEL = 'Operator';
export const AST_NODE_TYPE_LABEL = 'Type';
export const AST_NODE_CHILDREN_LABEL = 'Children';

export function astChildCountLabel(count: number): string {
  return `${count} ${AST_CHILD_COUNT_LABEL}`;
}

export function astNodeCountLabel(count: number): string {
  return `${count} ${AST_NODE_COUNT_LABEL}`;
}

// ---------------------------------------------------------------------------
// Semantic view
// ---------------------------------------------------------------------------

export const SEMA_NO_RESULT = 'Compile a program to build a symbol table.';
export const SEMA_BLOCKED =
  'No symbol table: earlier errors stopped the compiler before semantic analysis ran.';
export const SEMA_SYMBOL_TABLE_TITLE = 'Symbol table';
export const SEMA_SYMBOL_COUNT_LABEL = 'symbols';
export const SEMA_COL_NAME = 'Name';
export const SEMA_COL_KIND = 'Kind';
export const SEMA_COL_TYPE = 'Type';
export const SEMA_COL_DECLARED = 'Declared at';
export const SEMA_COL_USES = 'Uses';
export const SEMA_USE_COUNT_LABEL = 'uses';
export const SEMA_SCOPE_LABEL = 'Scope';
export const SEMA_SCOPE_GLOBAL = 'global';
export const SEMA_SCOPE_FUNCTION = 'function';
export const SEMA_SCOPE_BLOCK = 'block';
export const SEMA_EMPTY_TABLE = 'This program declares no symbols.';
export const SEMA_USES_HINT =
  'Click a row to highlight the declaration and every use in the source, tokens and IR.';
export const SEMA_VIEW_MODE_LABEL = 'Semantic view';
export const SEMA_TREE_LABEL = 'Scope tree';
export const SEMA_TABLE_LABEL = 'Symbol table';
export const SEMA_TREE_EMPTY = 'This program has no scopes to show yet.';
export const SEMA_SCOPE_TREE_TITLE = 'Scope tree';
export const SEMA_SCOPE_PANEL_TITLE = 'Selected scope';
export const SEMA_SCOPE_EMPTY_SELECTION =
  'Click a scope or symbol node in the tree to see what it contains. Symbol nodes highlight their declaration and uses.';
export const SEMA_SCOPE_KIND_LABEL = 'Kind';
export const SEMA_SCOPE_OWNER_LABEL = 'Owned by';
export const SEMA_SCOPE_PARENT_LABEL = 'Parent scope';
export const SEMA_SCOPE_SYMBOLS_LABEL = 'Symbols here';
export const SEMA_SCOPE_NONE = 'none (outermost scope)';
export const SEMA_SCOPE_SYMBOL_COUNT = 'symbols in this scope';
export const SEMA_SCOPE_TREE_HINT =
  'The scope tree shows how names are nested: each scope holds its own symbols, and inner scopes see outer ones. Click a symbol node to highlight it everywhere.';
export const SEMA_SCOPE_GLOBAL_LABEL = 'global scope';
export function semaScopeFunctionLabel(name: string): string {
  return `function ${name}`;
}
export const SEMA_SCOPE_BLOCK_LABEL = 'block';

export const SYMBOL_KIND_EXPLANATIONS: Record<string, string> = {
  function: 'A function defined (or declared) at the top level.',
  global: 'A variable declared outside every function; it lives for the whole program.',
  local: 'A variable declared inside a function or block.',
  param: 'An input value handed to a function by the caller.',
};

export const SYMBOL_NOT_FOUND =
  'This symbol is not part of the current compile result. Select a row again.';

export function typeToString(type: Type | undefined): string {
  if (type === undefined) return 'unknown';
  return describeType(type);
}

// ---------------------------------------------------------------------------
// IR view
// ---------------------------------------------------------------------------

export const IR_VIEW_TITLE = 'Generated IR';
export const IR_NO_RESULT = 'Compile a program to generate intermediate representation.';
export const IR_BLOCKED =
  'No IR: semantic errors stop the compiler before IR generation. Fix the errors and recompile.';
export const IR_FUNCTION_LABEL = 'Function';
export const IR_ALL_FUNCTIONS = 'All functions';
export const IR_COPY_LABEL = 'Copy IR';
export const IR_COPY_DONE = 'Copied';
export const IR_LINE_COUNT_LABEL = 'lines';
export const IR_NOTE_TITLE = 'About this IR';
export const IR_NOTE =
  'LLVM IR is an intermediate language: not C and not machine code. Real LLVM IR for the same program can differ (metadata, attributes, phi nodes). This app prints an LLVM-like style from its own Mini-C compiler; it is not produced by Clang or LLVM.';
export const IR_EMPTY_SELECTION =
  'Click an instruction row to see what it does and where it came from.';
export const IR_INSTRUCTION_TITLE = 'Selected instruction';
export const IR_OPERANDS_LABEL = 'Operands';
export const IR_RESULT_LABEL = 'Result';
export const IR_PREDICATE_LABEL = 'Comparison';
export const IR_CALLEE_LABEL = 'Callee';
export const IR_VAR_LABEL = 'Source variable';
export const IR_NO_ORIGIN =
  'This line is compiler scaffolding; it does not correspond to a source expression.';
export const IR_OPCODE_LEGEND_TITLE = 'Instruction meanings';

export interface IROpcodeExplanation {
  label: string;
  simple: string;
}

export const IROPCODE_EXPLANATIONS: Record<IROpcode, IROpcodeExplanation> = {
  alloca: {
    label: 'alloca',
    simple:
      'Reserves stack cells for a variable — one cell for an int or a pointer, several for an array or a struct. The slot lives until the function returns.',
  },
  load: {
    label: 'load',
    simple: 'Reads the cell at an address: a variable, one element of an array or one field of a struct.',
  },
  store: {
    label: 'store',
    simple: 'Writes a value into the cell at an address, which may be a variable or a computed location.',
  },
  add: {
    label: 'add',
    simple: 'Integer addition. "nsw" means no signed overflow is allowed (a promise, like C).',
  },
  sub: {
    label: 'sub',
    simple: 'Integer subtraction, also with the "nsw" overflow promise.',
  },
  mul: {
    label: 'mul',
    simple: 'Integer multiplication, also with the "nsw" overflow promise.',
  },
  sdiv: {
    label: 'sdiv',
    simple: 'Signed integer division, truncating toward zero.',
  },
  srem: {
    label: 'srem',
    simple: 'Signed remainder after sdiv; it keeps the sign of the dividend.',
  },
  icmp: {
    label: 'icmp',
    simple:
      'Compares two integers and produces an i1 (one-bit true/false) result, used by branches.',
  },
  zext: {
    label: 'zext',
    simple:
      'Widens a smaller value to a bigger type without changing it — here an i1 comparison result becomes an i32.',
  },
  br: {
    label: 'br',
    simple:
      'Branches. With one label it always jumps there; with an i1 condition it picks between two labels.',
  },
  ret: {
    label: 'ret',
    simple: 'Returns a value (or nothing, for void) to the caller and leaves the function.',
  },
  ptradd: {
    label: 'ptradd',
    simple:
      'Adds a cell offset to an address: base + index * element size. It is how arrays, fields and pointer arithmetic are computed.',
  },
  ptrdiff: {
    label: 'ptrdiff',
    simple:
      'Subtracts two addresses that live in the same block and yields how many cells apart they are.',
  },
  call: {
    label: 'call',
    simple:
      'Calls a function with typed arguments and receives its return value. malloc, free, delete, print and printf are built in.',
  },
  unreachable: {
    label: 'unreachable',
    simple:
      'Marks code the compiler believes can never run. Here it closes a non-void function that may fall off its end.',
  },
};

export const IR_PREDICATE_EXPLANATIONS: Record<string, string> = {
  eq: 'equal',
  ne: 'not equal',
  slt: 'signed less than',
  sle: 'signed less than or equal',
  sgt: 'signed greater than',
  sge: 'signed greater than or equal',
};

// ---------------------------------------------------------------------------
// Diagnostics list
// ---------------------------------------------------------------------------

export const DIAGNOSTICS_TITLE = 'Problems';
export const DIAGNOSTICS_EMPTY = 'No problems. The program passed every stage.';
export const DIAGNOSTICS_NONE_YET = 'Compile a program to see diagnostics here.';
export const DIAGNOSTIC_COUNT_ERRORS = 'errors';
export const DIAGNOSTIC_COUNT_WARNINGS = 'warnings';
export const DIAGNOSTIC_RAW_LABEL = 'Raw message and notes';
export const DIAGNOSTIC_WHY_LABEL = 'Why this error?';
export const DIAGNOSTIC_STAGE_LABEL = 'Stage';
export const DIAGNOSTIC_CODE_LABEL = 'Code';
export const DIAGNOSTIC_LOCATION_LABEL = 'Location';
export const STAGE_REPORTING_SEMA = 'sema';
export const STAGE_REPORTING_LEX = 'lex';
export const STAGE_REPORTING_PARSE = 'parse';

export interface DiagnosticCodeExplanation {
  title: string;
  why: string;
}

/** Short "Why this?" text for every diagnostic code the compiler can emit. */
export const DIAGNOSTIC_CODE_EXPLANATIONS: Record<string, DiagnosticCodeExplanation> = {
  E1001: {
    title: 'Invalid character',
    why: 'The lexer found a character that appears nowhere in Mini-C. Supported punctuation is listed in the About dialog; everything else must be written with the supported operators.',
  },
  E1002: {
    title: 'Unterminated block comment',
    why: 'A /* comment was opened but never closed with */. Either close it or remove the opening /*.',
  },
  E1003: {
    title: 'Unterminated string literal',
    why: 'A " was opened but never closed before the end of the line. printf formats are written as "text", with escapes such as \\n inside them.',
  },
  E1004: {
    title: 'Integer literal too large',
    why: 'Mini-C integers are 32-bit signed values, so the largest literal is 2147483647.',
  },
  E1010: {
    title: 'Unsupported construct',
    why: 'The construct uses a feature outside the supported Mini-C subset (for example char, floats, ternary ?:, bitwise operators or do-while). The message lists what is supported instead.',
  },
  E2001: {
    title: 'Expected a token',
    why: 'The parser reached the end of the input while a specific token was still required, such as a missing semicolon or closing brace. The message names what was expected.',
  },
  E2002: {
    title: 'Unexpected token',
    why: 'A token appeared where the grammar does not allow it. The message shows the token and what the parser expected in that position.',
  },
  E3001: {
    title: 'Undeclared identifier',
    why: 'Every name must be declared before it is used. Check the spelling, and remember that Mini-C variables must be declared with "int" in the same function (or at the top level for globals).',
  },
  E3002: {
    title: 'Redeclaration',
    why: 'The same name was declared twice in one scope. The note points at the previous declaration. To shadow a name instead, declare the new one inside a nested block.',
  },
  E3003: {
    title: 'Incompatible types',
    why: 'Types must fit where they are used: int and pointers are values, void is not a value at all, records are used through their fields, and only a { ... } list can initialise an array or a record.',
  },
  E3004: {
    title: 'Wrong number of arguments',
    why: 'The call passes a different number of arguments than the function declares. The message shows both counts.',
  },
  E3005: {
    title: 'No such member',
    why: 'The struct or union has no field with that name. The message lists the fields it does define.',
  },
  E3006: {
    title: 'break/continue outside a loop',
    why: 'break and continue only make sense inside a while or for loop, because they jump to that loop’s end or next iteration.',
  },
  E3009: {
    title: 'Return value mismatch',
    why: 'A void function must return without a value; a function that returns int or a pointer must return a value of that type. Falling off the end of a non-void function is also reported as a warning (W4002).',
  },
  W4001: {
    title: 'Unused variable',
    why: 'The variable is declared but never read. It is likely a typo or leftover code; removing it makes the program clearer.',
  },
  W4002: {
    title: 'Function may end without return',
    why: 'A non-void function that reaches its end without returning gives the caller an unpredictable value. Add a return statement at the end. main is exempt.',
  },
  E9999: {
    title: 'Internal compiler error',
    why: 'The Mini-C compiler hit an unexpected problem and stopped safely. This is a bug in the app, not in your program; reloading the page usually clears it.',
  },
};

export function diagnosticCountLabel(count: number, severity: 'error' | 'warning'): string {
  return `${count} ${severity === 'error' ? DIAGNOSTIC_COUNT_ERRORS : DIAGNOSTIC_COUNT_WARNINGS}`;
}

// ---------------------------------------------------------------------------
// Blocked stages (spec §8)
// ---------------------------------------------------------------------------

export function blockedStageMessage(stageLabel: string, blockingLabel: string): string {
  return `Not available — ${blockingLabel} reported errors, so the compiler stopped before this stage.`;
}

export const BLOCKED_SELECT_FIRST_ERROR = 'Select the first error';
export const BLOCKED_NO_ERROR_LINK =
  'This stage is unavailable because an earlier stage failed.';

// ---------------------------------------------------------------------------
// Robustness limits
// ---------------------------------------------------------------------------

export const SOURCE_LIMIT_CHARS = 20000;
export const SOURCE_LIMIT_LINES = 800;
export const SOURCE_LIMIT_MESSAGE =
  'This program is too large for the visualizer (limit: 20,000 characters and 800 lines). Trim it or explore a smaller example.';
export const SOURCE_LIMIT_SHORT =
  'Over the 20,000-character limit — compile is disabled.';

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

export const STAGE_CRASH_TITLE = 'This stage view stopped working';
export const STAGE_CRASH_BODY =
  'A view in the stage workspace hit an unexpected error. Your source and compile result are safe. Switch to another stage, or reload the page.';
export const STAGE_CRASH_RELOAD = 'Reload the page';

// ---------------------------------------------------------------------------
// Assembly view
// ---------------------------------------------------------------------------

export const ASM_NO_RESULT = 'Compile a program to generate assembly text.';
export const ASM_BLOCKED =
  'No assembly: earlier errors stopped the compiler before IR generation. Fix the errors and recompile.';
export const ASM_LINE_COUNT_LABEL = 'lines';
export const ASM_NOTE_TITLE = 'About this assembly';
export const ASM_NOTE =
  'This is illustrative x86-64 assembly text produced by this app’s own compiler from its IR — not by Clang or LLVM. It is never assembled or executed here; the Execution stage interprets the IR directly instead.';
export const ASM_EMPTY_SELECTION =
  'Click an instruction row to see which IR instruction it lowers and where that came from in the source.';
export const ASM_INSTRUCTION_TITLE = 'Selected instruction';
export const ASM_MAPPED_IR_LABEL = 'Lowers this IR';
export const ASM_NO_MAPPING =
  'This line is scaffolding (a label, directive or prologue instruction). It has no single IR origin.';
export const ASM_FUNCTION_LABEL = 'Function';
export const ASM_ALL_FUNCTIONS = 'All functions';

// ---------------------------------------------------------------------------
// Execution (VM) view
// ---------------------------------------------------------------------------

export const EXEC_NO_RESULT = 'Compile a program, then open this stage to execute its IR.';
export const EXEC_BLOCKED =
  'No execution: the IR was not generated, so there is nothing to run. Fix the earlier errors and recompile.';
export const EXEC_SIMULATED_LABEL = 'simulated';
export const EXEC_STEP_LABEL = 'Step';
export const EXEC_STEP_BACK_LABEL = 'Step back';
export const EXEC_RUN_LABEL = 'Run';
export const EXEC_PAUSE_LABEL = 'Pause';
export const EXEC_RESET_LABEL = 'Reset';
export const EXEC_STEP_OF = (index: number, total: number): string =>
  `Step ${index} of ${Math.max(total - 1, 0)}`;
export const EXEC_STACK_TITLE = 'Stack';
export const EXEC_STACK_EMPTY = 'The stack is empty.';
export const EXEC_FRAME_BYTES = (bytes: number): string => `${bytes} bytes`;
export const EXEC_SLOT_UNTITLED = 'value';
export const EXEC_DATA_TITLE = 'Data segment (globals)';
export const EXEC_DATA_EMPTY = 'This program has no global variables.';
export const EXEC_HEAP_TITLE = 'Heap';
export const EXEC_HEAP_EMPTY =
  'Nothing has been allocated yet. malloc, new, free and delete reserve and release the blocks shown here.';
export const EXEC_HEAP_FREED = 'released';
export const EXEC_OUTPUT_TITLE = 'Program output';
export const EXEC_OUTPUT_EMPTY =
  'print and printf have not written anything at this step.';
export const EXEC_MEMORY_TITLE = 'Memory';
export const EXEC_STACK_DEPTH = (frames: number): string =>
  `${frames} frame${frames === 1 ? '' : 's'}`;
export const EXEC_TRACE_TITLE = 'Execution trace';
export const EXEC_TRACE_EMPTY = 'Run or step the program to build a trace.';
export const EXEC_CURRENT_INSTRUCTION = 'Current instruction';
export const EXEC_NO_INSTRUCTION = 'No instruction is executing at this step.';
export const EXEC_RESULT_TITLE = 'Result';
export const EXEC_RESULT_RUNNING = 'The program has not finished yet.';
export const EXEC_RESULT_VALUE = (value: number): string =>
  `main returned ${value} (0x${(value >>> 0).toString(16)}).`;
export const EXEC_RESULT_VOID = 'main returned without a value (void).';
export const EXEC_OUTCOME_FINISHED = 'Finished';
export const EXEC_OUTCOME_STEP_LIMIT = 'Stopped at the step limit';
export const EXEC_OUTCOME_NO_MAIN = 'No main function';
export const EXEC_OUTCOME_ERROR = 'Runtime error';
export const EXEC_JUST_ALLOCATED = 'just allocated';
export const EXEC_JUST_WRITTEN = 'just written';
export const EXEC_RELEASED_TITLE = 'Just released';
export const EXEC_RELEASED_FRAME = (name: string, bytes: number): string =>
  `Frame of ${name} — ${bytes} bytes returned to the stack.`;
export const EXEC_SLOT_COUNT = (count: number): string =>
  `${count} cell${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Step-through mode
// ---------------------------------------------------------------------------

export const STEP_THROUGH_LABEL = 'Step through';
export const STEP_THROUGH_ACTIVE = 'Step mode';
export const STEP_THROUGH_TITLE = 'Step-through compilation';
export const STEP_THROUGH_HINT =
  'Each action runs the next compiler stage and opens its view, so you can watch the pipeline one stage at a time.';
export const STEP_THROUGH_REACHED = (label: string): string => `Ran: ${label}`;
export const STEP_THROUGH_NEXT = (label: string): string => `Run ${label}`;
export const STEP_THROUGH_RUN_ALL = 'Run remaining';
export const STEP_THROUGH_EXIT = 'Exit step mode';
export const STEP_THROUGH_START = 'Start at the first stage';
export const STEP_THROUGH_DONE = 'Every compile stage has run.';
export const STEP_THROUGH_FAILED = (label: string): string =>
  `${label} reported errors, so the pipeline stopped here.`;
export const STEP_NOT_RUN_TITLE = 'This stage has not run yet';
export const STEP_NOT_RUN_BODY = (label: string): string =>
  `Step-through mode has not reached ${label} yet. Run the next stage, or run the remaining stages at once.`;
export const STEP_NOT_RUN_RUN_NEXT = 'Run the next stage';
export const STEP_NOT_RUN_RUN_THIS = (label: string): string => `Run ${label}`;
