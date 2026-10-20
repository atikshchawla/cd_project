export type Range = { start: number; end: number }; // char offsets, [start, end)
export type Stage = 'source' | 'lex' | 'parse' | 'sema' | 'ir' | 'asm';

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

export type Type =
  | { kind: 'int' }
  | { kind: 'void' }
  | { kind: 'function'; ret: Type; params: Type[] }; // later: char, pointer, array

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
  | 'ParenExpr';

export interface AstNode {
  id: number;
  kind: AstKind;
  range: Range;
  parentId: number | null;
  childIds: number[];
  name?: string;
  op?: string; // op: '+', '=', 'prefix++', 'postfix--', ...
  value?: number;
  type?: Type; // type filled by sema
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
  | 'unreachable';

export type IROperand =
  | { kind: 'value'; name: string }
  | { kind: 'const'; value: number; type: IRType }
  | { kind: 'label'; blockId: number }
  | { kind: 'global'; name: string };

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

export interface CompileResult {
  sourceHash: string;
  source: string; // source = normalised (LF only)
  tokens: Token[];
  ast: Ast | null;
  symbols: { symbols: Symbol[]; scopes: Scope[] } | null;
  diagnostics: Diagnostic[];
  ir: { module: IRModule; lines: IRLine[] } | null;
  asm: null; // reserved for a later milestone
  completed: Record<Stage, 'ok' | 'warnings' | 'failed' | 'blocked'>;
  meta: { compilerVersion: string; target: string; flags: string[]; elapsedMs: number };
}
