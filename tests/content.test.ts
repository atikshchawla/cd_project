import { describe, expect, it } from 'vitest';
import { EXAMPLES, getExampleById } from '@/content/examples';
import {
  AST_KIND_EXPLANATIONS,
  DIAGNOSTIC_CODE_EXPLANATIONS,
  IROPCODE_EXPLANATIONS,
  STAGE_EXPLANATIONS,
  STAGE_ORDER,
} from '@/content/explanations';
import { compile } from '@/lib/compiler';
import type { AstKind, IROpcode } from '@/lib/compiler/types';

const ALL_AST_KINDS: AstKind[] = [
  'TranslationUnit',
  'FunctionDecl',
  'ParamDecl',
  'VarDecl',
  'CompoundStmt',
  'DeclStmt',
  'ExprStmt',
  'IfStmt',
  'WhileStmt',
  'ForStmt',
  'ReturnStmt',
  'BreakStmt',
  'ContinueStmt',
  'NullStmt',
  'BinaryOperator',
  'UnaryOperator',
  'CompoundAssignOperator',
  'CallExpr',
  'DeclRefExpr',
  'IntegerLiteral',
  'ParenExpr',
];

const ALL_IR_OPCODES: IROpcode[] = [
  'alloca',
  'load',
  'store',
  'add',
  'sub',
  'mul',
  'sdiv',
  'srem',
  'icmp',
  'zext',
  'br',
  'ret',
  'call',
  'unreachable',
];

const ALL_DIAGNOSTIC_CODES = [
  'E1001',
  'E1002',
  'E1004',
  'E1010',
  'E2001',
  'E2002',
  'E3001',
  'E3002',
  'E3003',
  'E3004',
  'E3006',
  'E3009',
  'W4001',
  'W4002',
  'E9999',
];

describe('example set', () => {
  it('has twelve examples (8 learning + 4 error) with unique ids', () => {
    expect(EXAMPLES).toHaveLength(12);
    expect(new Set(EXAMPLES.map((example) => example.id)).size).toBe(EXAMPLES.length);
    expect(EXAMPLES.filter((example) => example.category === 'learn')).toHaveLength(8);
    expect(EXAMPLES.filter((example) => example.category === 'error')).toHaveLength(4);
  });

  it('has well-formed metadata on every example', () => {
    for (const example of EXAMPLES) {
      expect(example.title.length).toBeGreaterThan(0);
      expect(example.objective.length).toBeGreaterThan(0);
      expect(example.explanation.length).toBeGreaterThan(0);
      expect(example.code.trim().length).toBeGreaterThan(0);
      expect(STAGE_ORDER).toContain(example.suggestedStage);
    }
  });

  it('compiles every learning example cleanly with IR generated', () => {
    for (const example of EXAMPLES.filter((item) => item.category === 'learn')) {
      const result = compile(example.code);
      expect(result.diagnostics, example.id).toEqual([]);
      expect(result.completed, example.id).toMatchObject({
        lex: 'ok',
        parse: 'ok',
        sema: 'ok',
        ir: 'ok',
      });
      expect(result.ast, example.id).not.toBeNull();
      expect(result.ir, example.id).not.toBeNull();
    }
  });

  it('compiles every error example with its expected status and codes', () => {
    for (const example of EXAMPLES.filter((item) => item.category === 'error')) {
      const result = compile(example.code);
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
      for (const code of example.expectedErrorCodes ?? []) {
        expect(codes, example.id).toContain(code);
      }
      if (example.expected === 'error') {
        expect(result.completed.sema === 'failed' || result.completed.parse === 'failed', example.id).toBe(true);
        expect(result.ir, example.id).toBeNull();
      } else if (example.expected === 'warnings') {
        expect(result.completed.sema, example.id).toBe('warnings');
        expect(result.completed.ir, example.id).toBe('ok');
        expect(result.ir, example.id).not.toBeNull();
      }
    }
  });

  it('looks examples up by id and handles missing ids', () => {
    expect(getExampleById(EXAMPLES[0].id)?.title).toBe(EXAMPLES[0].title);
    expect(getExampleById(null)).toBeNull();
    expect(getExampleById('missing')).toBeNull();
  });
});

describe('stage explanations', () => {
  it('covers every stage with all four explanation fields', () => {
    for (const stage of STAGE_ORDER) {
      const explanation = STAGE_EXPLANATIONS[stage];
      expect(explanation.label.length).toBeGreaterThan(0);
      expect(explanation.simple.length).toBeGreaterThan(0);
      expect(explanation.technical.length).toBeGreaterThan(0);
      expect(explanation.whyItMatters.length).toBeGreaterThan(0);
    }
  });
});

describe('AST kind explanations', () => {
  it('covers every AST kind with a label and a simple explanation', () => {
    expect(Object.keys(AST_KIND_EXPLANATIONS).sort()).toEqual([...ALL_AST_KINDS].sort());
    for (const kind of ALL_AST_KINDS) {
      const explanation = AST_KIND_EXPLANATIONS[kind];
      expect(explanation.label.length).toBeGreaterThan(0);
      expect(explanation.simple.length).toBeGreaterThan(0);
    }
  });
});

describe('IR opcode explanations (M6 hardening)', () => {
  it('covers every IR opcode with a label and a simple explanation', () => {
    expect(Object.keys(IROPCODE_EXPLANATIONS).sort()).toEqual([...ALL_IR_OPCODES].sort());
    for (const opcode of ALL_IR_OPCODES) {
      const explanation = IROPCODE_EXPLANATIONS[opcode];
      expect(explanation.label.length).toBeGreaterThan(0);
      expect(explanation.simple.length).toBeGreaterThan(0);
    }
  });
});

describe('diagnostic code explanations (M6 hardening)', () => {
  it('covers every diagnostic code the compiler can emit', () => {
    for (const code of ALL_DIAGNOSTIC_CODES) {
      const explanation = DIAGNOSTIC_CODE_EXPLANATIONS[code];
      expect(explanation, code).toBeDefined();
      expect(explanation.title.length).toBeGreaterThan(0);
      expect(explanation.why.length).toBeGreaterThan(0);
    }
  });
});
