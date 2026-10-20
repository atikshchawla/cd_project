import type { Stage } from '@/lib/compiler/types';

export interface Example {
  id: string;
  title: string;
  category: 'learn' | 'error';
  objective: string;
  code: string;
  suggestedStage: Stage;
  explanation: string;
  expected: 'success' | 'warnings' | 'error';
  expectedErrorCodes?: string[];
}

/**
 * The full MVP example set (§10): eight learning examples, each focused on one
 * idea, plus four error examples that demonstrate diagnostics and warnings.
 */
export const EXAMPLES: Example[] = [
  {
    id: 'variables-arithmetic',
    title: 'Variables and arithmetic',
    category: 'learn',
    objective:
      'See how named variables become symbols with types, and how arithmetic becomes instructions.',
    code: `int main() {
  int a = 6;
  int b = 7;
  int product = a * b;
  return product;
}
`,
    suggestedStage: 'sema',
    explanation:
      'Each int variable gets a name, a type and a place to live. The compiler checks that a and b exist before it allows the multiplication.',
    expected: 'success',
  },
  {
    id: 'operator-precedence',
    title: 'Operator precedence',
    category: 'learn',
    objective: 'Watch multiplication bind tighter than addition in both the tree and the IR.',
    code: `int main() {
  return 2 + 3 * 4;
}
`,
    suggestedStage: 'parse',
    explanation:
      'The syntax tree nests 3 * 4 inside the addition, so the multiplication runs first. In the IR the mul instruction appears before the add.',
    expected: 'success',
  },
  {
    id: 'if-else',
    title: 'If / else',
    category: 'learn',
    objective: 'Watch a decision turn into a condition and two alternative paths.',
    code: `int max(int a, int b) {
  if (a > b) {
    return a;
  } else {
    return b;
  }
}
`,
    suggestedStage: 'parse',
    explanation:
      'The condition a > b is an expression, while the two return statements are separate branches. The syntax tree shows that nesting clearly.',
    expected: 'success',
  },
  {
    id: 'while-loop',
    title: 'While loop',
    category: 'learn',
    objective: 'Follow a loop from source through the tree and into labelled blocks in the IR.',
    code: `int main() {
  int i = 1;
  int total = 0;
  while (i <= 5) {
    total = total + i;
    i++;
  }
  return total;
}
`,
    suggestedStage: 'ir',
    explanation:
      'A while loop needs a condition check, a body and a jump back. The intermediate representation makes those jumps visible as labelled blocks.',
    expected: 'success',
  },
  {
    id: 'for-loop',
    title: 'For loop',
    category: 'learn',
    objective: 'See the three parts of a for loop become separate IR blocks.',
    code: `int main() {
  int sum = 0;
  for (int i = 0; i < 5; i++) {
    if (i == 2) continue;
    sum += i;
  }
  return sum;
}
`,
    suggestedStage: 'ir',
    explanation:
      'The initialiser runs once, the condition is re-checked every iteration, and the increment runs before jumping back. The IR splits these into for.cond, for.body, for.inc and for.end blocks; continue jumps straight to for.inc.',
    expected: 'success',
  },
  {
    id: 'function-call',
    title: 'Function with parameters',
    category: 'learn',
    objective: 'Follow values into a function and back out through its return value.',
    code: `int add(int a, int b) {
  return a + b;
}

int main() {
  return add(2, 3);
}
`,
    suggestedStage: 'ir',
    explanation:
      'Parameters arrive as values, get copied into stack slots, and the return statement hands a result back. The call site becomes a call instruction with typed arguments.',
    expected: 'success',
  },
  {
    id: 'recursion',
    title: 'Recursion (factorial)',
    category: 'learn',
    objective: 'See a function call itself and trace the same instructions reused for smaller inputs.',
    code: `int fact(int n) {
  if (n <= 1) {
    return 1;
  }
  return n * fact(n - 1);
}

int main() {
  return fact(5);
}
`,
    suggestedStage: 'ir',
    explanation:
      'The IR contains one copy of fact’s instructions; each call re-enters them with a smaller argument. The base case n <= 1 stops the chain.',
    expected: 'success',
  },
  {
    id: 'short-circuit',
    title: 'Short-circuit && and ||',
    category: 'learn',
    objective: 'See how the right side of && / || only runs when the left side demands it.',
    code: `int main() {
  int a = 0;
  int b = 7;
  if (a != 0 && b / a > 1) {
    return 1;
  }
  if (a == 0 || b > 3) {
    return 2;
  }
  return 0;
}
`,
    suggestedStage: 'ir',
    explanation:
      'The IR evaluates the left side first and jumps straight to the result when the answer is already decided, so b / a never divides by zero. Real Clang uses phi nodes for this; this app uses a hidden temporary instead.',
    expected: 'success',
  },
  {
    id: 'missing-semicolon',
    title: 'Missing semicolon',
    category: 'error',
    objective: 'See where the parser stops on the first syntax error.',
    code: `int main() {
  int x = 1
  return x;
}
`,
    suggestedStage: 'parse',
    explanation:
      'The parser expects a semicolon after the declaration and reports E2001 with the exact position. Parsing stops there, so later stages never run.',
    expected: 'error',
    expectedErrorCodes: ['E2001'],
  },
  {
    id: 'undeclared-identifier',
    title: 'Undeclared identifier',
    category: 'error',
    objective: 'Watch semantic analysis catch a name that was never declared.',
    code: `int main() {
  int x = 1;
  return x + y;
}
`,
    suggestedStage: 'sema',
    explanation:
      'The parser accepts this fine — y is grammatically valid. Semantic analysis reports E3001 because y is not declared anywhere, and IR generation is blocked.',
    expected: 'error',
    expectedErrorCodes: ['E3001'],
  },
  {
    id: 'wrong-argument-count',
    title: 'Wrong argument count',
    category: 'error',
    objective: 'See a call checked against its function declaration.',
    code: `int add(int a, int b) {
  return a + b;
}

int main() {
  return add(1, 2, 3);
}
`,
    suggestedStage: 'sema',
    explanation:
      'add declares two parameters, but the call passes three. Semantic analysis reports E3004 with both counts so you can fix the call or the declaration.',
    expected: 'error',
    expectedErrorCodes: ['E3004'],
  },
  {
    id: 'warnings',
    title: 'Warnings: unused variable and missing return',
    category: 'error',
    objective: 'See warnings that do not stop the compiler from producing IR.',
    code: `int helper(int x) {
  int unused = x + 1;
}

int main() {
  return helper(2);
}
`,
    suggestedStage: 'sema',
    explanation:
      'helper never reads "unused" (W4001) and may end without returning a value (W4002). Warnings do not block later stages: the IR is still generated so you can inspect it.',
    expected: 'warnings',
    expectedErrorCodes: ['W4001', 'W4002'],
  },
];

export function getExampleById(id: string | null): Example | null {
  if (id === null) return null;
  return EXAMPLES.find((example) => example.id === id) ?? null;
}
