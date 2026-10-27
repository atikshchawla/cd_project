export type Range = { start: number; end: number }; // char offsets, [start, end)
export type Stage = 'source' | 'lex' | 'parse' | 'sema' | 'ir' | 'opt' | 'asm' | 'sim';

export interface Diagnostic {
  id: number;
  severity: 'error' | 'warning' | 'note';
  code: string;
  stage: 'lex' | 'parse' | 'sema' | 'unsupported' | 'internal';
  message: string;
  range: Range;
  notes?: { message: string; range?: Range }[];
}

export type TokenKind =
  | 'keyword'
  | 'identifier'
  | 'integer-literal'
  | 'string-literal'
  | 'operator'
  | 'punctuator'
  | 'directive';

export interface Token {
  id: number;
  kind: TokenKind;
  text: string;
  range: Range;
  line: number;
  col: number;
  endLine: number;
  endCol: number; // 1-based; a tab counts as 1 column
}

/**
 * One field of a `struct` / `union` type.
 *
 * `offset` and `size` are counted in **abstract memory cells** (one cell = one
 * 32-bit value), which is how this dialect lays records out: every supported
 * scalar occupies exactly one cell. For a `union` every field sits at offset 0,
 * so writing one field really does overwrite the others — the simplified shared
 * storage behaviour this project documents.
 */
export interface RecordField {
  name: string;
  type: Type;
  offset: number;
  size: number;
  /** Source range of the `Type name;` line that declared this field. */
  range: Range;
}

/**
 * A declared type as *written* in the source, recorded by the parser.
 *
 * The parser knows the spelling (`int **p[2]`) but not yet what `struct Point`
 * contains, so records are referenced by tag and resolved during semantic
 * analysis. `dims` are the declarator's array sizes in source order (outermost
 * first), always positive integer literals.
 */
export interface TypeRef {
  base: 'int' | 'void' | 'struct' | 'union';
  /** For `struct` / `union`: the tag name following the keyword. */
  tag?: string;
  /** Number of `*` written between the type keyword and the name. */
  stars: number;
  /** Array sizes, outermost first (`int a[2][3]` → `[2, 3]`). */
  dims: number[];
}

export type Type =
  | { kind: 'int' }
  | { kind: 'void' }
  /** Format strings: only valid as the first argument of `printf`. */
  | { kind: 'string' }
  | { kind: 'pointer'; pointee: Type }
  /** Fixed-length array; `size` is the element count (a positive literal). */
  | { kind: 'array'; element: Type; size: number }
  | {
      kind: 'record';
      recordKind: 'struct' | 'union';
      name: string;
      fields: RecordField[];
      /** Total cells one value of this record occupies. */
      size: number;
    }
  | { kind: 'function'; ret: Type; params: Type[] };

export type AstKind =
  | 'TranslationUnit'
  | 'FunctionDecl'
  | 'ParamDecl'
  | 'VarDecl'
  | 'CompoundStmt'
  | 'DeclStmt'
  | 'ExprStmt'
  | 'IfStmt'
  | 'WhileStmt'
  | 'ForStmt'
  | 'ReturnStmt'
  | 'BreakStmt'
  | 'ContinueStmt'
  | 'NullStmt'
  | 'BinaryOperator'
  | 'UnaryOperator'
  | 'CompoundAssignOperator'
  | 'CallExpr'
  | 'DeclRefExpr'
  | 'IntegerLiteral'
  | 'StringLiteral'
  | 'ParenExpr'
  | 'ArraySubscriptExpr'
  | 'MemberExpr'
  | 'InitListExpr'
  | 'RecordDecl'
  | 'FieldDecl'
  | 'SizeOfExpr'
  | 'NewExpr'
  | 'DeleteStmt'
  | 'PrintStmt';

export interface AstNode {
  id: number;
  kind: AstKind;
  range: Range;
  parentId: number | null;
  childIds: number[];
  name?: string;
  op?: string; // op: '+', '=', 'prefix++', 'postfix--', 'struct', '.' , '->', ...
  value?: number;
  stringValue?: string; // StringLiteral: the decoded contents (escapes resolved)
  type?: Type; // type filled by sema
  typeRef?: TypeRef; // declarators, sizeof(type) and new: the written type (parser)
  refDeclId?: number; // DeclRefExpr -> declaring node id (sema)
  declRet?: 'int' | 'void'; // FunctionDecl: declared return type, recorded by the parser
  forRole?: 'init' | 'cond' | 'inc' | 'body'; // ForStmt children: which part this is
}

export interface Ast {
  rootId: number;
  nodes: Record<number, AstNode>;
}

export interface Symbol {
  id: number;
  name: string;
  type: Type;
  kind: 'function' | 'global' | 'local' | 'param';
  scopeId: number;
  declNodeId: number;
  useNodeIds: number[];
}

export interface Scope {
  id: number;
  parentId: number | null;
  kind: 'global' | 'function' | 'block';
  ownerNodeId: number;
  symbolIds: number[];
}

export type IRType = 'i1' | 'i32' | 'ptr' | 'void';
export type IROpcode =
  | 'alloca'
  | 'load'
  | 'store'
  | 'add'
  | 'sub'
  | 'mul'
  | 'sdiv'
  | 'srem'
  | 'icmp'
  | 'zext'
  | 'br'
  | 'ret'
  | 'call'
  | 'ptradd'
  | 'ptrdiff'
  | 'unreachable';

export type IROperand =
  | { kind: 'value'; name: string }
  | { kind: 'const'; value: number; type: IRType }
  | { kind: 'label'; blockId: number }
  | { kind: 'global'; name: string }
  /** A string literal (a `printf` format); never a pointer the program can write. */
  | { kind: 'string'; value: string };

export interface IRInstr {
  id: number; // unique per module, never reused
  opcode: IROpcode;
  type: IRType;
  result?: string; // '%name' fixed at creation, NEVER renumbered
  operands: IROperand[];
  predicate?: 'eq' | 'ne' | 'slt' | 'sle' | 'sgt' | 'sge';
  astNodeId?: number; // origin AST node; omit when there is no honest origin
  varName?: string; // on alloca: the source variable it holds
  callee?: string; // on call: the function name (without '@')
  toType?: IRType; // on zext: the target type
  /** On alloca: how many cells it reserves (1 for a plain `int` or pointer). */
  cells?: number;
  /** On alloca: a short description of the reserved shape, e.g. `[5 x i32]`. */
  shape?: string;
}

export interface IRBlock {
  id: number;
  label: string;
  instrIds: number[];
}

export interface IRFunction {
  name: string;
  ret: IRType;
  params: { name: string; type: IRType }[];
  blockIds: number[];
  isDeclaration: boolean;
  astNodeId?: number;
}

export interface IRGlobal {
  name: string;
  init: number;
  /** Cells this global reserves (1 for a scalar, N for an array or record). */
  cells?: number;
  /** Per-cell initial values for multi-cell globals (missing = zero-filled). */
  inits?: number[];
  astNodeId?: number;
}

export interface IRModule {
  functions: IRFunction[];
  globals: IRGlobal[];
  blocks: Record<number, IRBlock>;
  instrs: Record<number, IRInstr>;
}

export interface IRLine {
  lineNo: number;
  text: string;
  instrId?: number;
  blockId?: number;
  funcName?: string;
}

export type AsmLineKind = 'directive' | 'label' | 'instruction' | 'comment';

/** One line of illustrative x86-64 assembly text lowered from the IR. */
export interface AsmLine {
  lineNo: number;
  text: string;
  kind: AsmLineKind;
  irInstrId?: number; // the IR instruction this line lowers (exact mapping)
  funcName?: string;
}

export interface AsmModule {
  lines: AsmLine[];
}

export interface CompileResult {
  sourceHash: string;
  source: string; // source = normalised (LF only)
  tokens: Token[];
  ast: Ast | null;
  symbols: { symbols: Symbol[]; scopes: Scope[] } | null;
  diagnostics: Diagnostic[];
  ir: { module: IRModule; lines: IRLine[] } | null;
  asm: AsmModule | null; // naive x86-64 text lowered from the IR
  completed: Record<Stage, 'ok' | 'warnings' | 'failed' | 'blocked'>;
  meta: { compilerVersion: string; target: string; flags: string[]; elapsedMs: number };
}
