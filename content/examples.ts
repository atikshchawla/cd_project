import type { OptPassId } from '@/lib/compiler';
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
  /**
   * Optimisation passes that must visibly change this program when they run on
   * their own (optimisation examples only). `tests/content.test.ts` runs each
   * listed pass in isolation and fails if it produces no transformation, so an
   * example can never advertise a pass it does not actually demonstrate.
   */
  demonstrates?: OptPassId[];
}

/**
 * The full example set (§10): seventeen learning examples, each focused on one
 * idea — including six that showcase the Optimization stage pass by pass — plus
 * seven error examples that demonstrate diagnostics, blocked stages and
 * warnings.
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
    id: 'value-forwarding',
    title: 'Local value forwarding',
    category: 'learn',
    objective: 'Watch a value that was just written be reused without reading memory again.',
    code: `int main() {
  int price = 20;
  int count = 3;
  int first = price;
  int second = price;
  int total = first + second;
  return total * count;
}
`,
    suggestedStage: 'opt',
    explanation:
      'price is written once and then read several times. Inside a basic block the optimiser already knows what the cell holds, so those reads use the value directly and the loads disappear. Switch the other three passes off to see this one working on its own.',
    expected: 'success',
    demonstrates: ['forwarding'],
  },
  {
    id: 'constant-folding',
    title: 'Constant folding',
    category: 'learn',
    objective: 'See arithmetic on literals computed while compiling instead of while running.',
    code: `int main() {
  int a = 2 + 3 * 4;
  int b = 10 - 4 / 2;
  int flag = 1 < 2;
  return a + b + flag;
}
`,
    suggestedStage: 'opt',
    explanation:
      'Every operand of 2 + 3 * 4, 10 - 4 / 2 and 1 < 2 is a literal, so the answer is already known. The instruction is removed and its uses read the number instead — computed with exactly the same 32-bit rules the interpreter uses, wrap-around and x / 0 included.',
    expected: 'success',
    demonstrates: ['folding'],
  },
  {
    id: 'branch-folding',
    title: 'Branch folding',
    category: 'learn',
    objective: 'Watch a condition that is already decided become a plain jump.',
    code: `int main() {
  int x = 0;
  if (1) {
    x = 10;
  } else {
    x = 20;
  }
  return x;
}
`,
    suggestedStage: 'opt',
    explanation:
      'if (1) is not really a decision: the IR turns the condition into a one-bit test, that test folds to 1, and the branch always goes to if.then. The branch keeps its place but drops the label it could never take. The else block stays in the module — it is simply never reached.',
    expected: 'success',
    demonstrates: ['folding'],
  },
  {
    id: 'common-subexpression',
    title: 'Common subexpression elimination',
    category: 'learn',
    objective: 'See the same expression computed once instead of twice in one block.',
    code: `int main() {
  int area1 = 12 * 8;
  int area2 = 12 * 8;
  return area1 + area2;
}
`,
    suggestedStage: 'opt',
    explanation:
      'Both lines compute 12 * 8 in the same basic block, so the second multiplication reads the first one’s result and is deleted. Only pure instructions are candidates: loads and calls can give different answers each time.',
    expected: 'success',
    demonstrates: ['cse'],
  },
  {
    id: 'dead-code',
    title: 'Dead-code elimination',
    category: 'learn',
    objective: 'Delete instructions whose results nobody ever reads.',
    code: `int main() {
  int a = 5;
  a * 2 + 1;
  return a;
}
`,
    suggestedStage: 'opt',
    explanation:
      'The statement a * 2 + 1; computes something complete and then throws it away. Nothing reads the result, so the multiply, the addition and the loads feeding them are removed. Stores and calls are never candidates — they can be observed from outside.',
    expected: 'success',
    demonstrates: ['dce'],
  },
  {
    id: 'optimisation-tour',
    title: 'Optimisation tour (all four passes)',
    category: 'learn',
    objective: 'Run every pass at once and watch the instruction count fall along the timeline.',
    code: `int main() {
  int x = 5;
  int a = x;
  int b = 6 * 7;
  int c = 6 * 7;
  if (1) {
    c = c + 1;
  }
  a + b + c;
  return x + a + b + c;
}
`,
    suggestedStage: 'opt',
    explanation:
      'One short program exercises every pass: a store forwarded into a load, two literal expressions folded, a duplicate expression merged, and a discarded computation deleted. Turn the passes off one at a time to see which transformation belongs to which, then click a transformation for its full explanation.',
    expected: 'success',
    demonstrates: ['forwarding', 'folding', 'cse', 'dce'],
  },
  {
    id: 'globals-and-calls',
    title: 'Globals and calls',
    category: 'learn',
    objective: 'Follow a global variable through a call and watch it in the VM’s data section.',
    code: `int counter = 0;

void bump() {
  counter = counter + 1;
}

int main() {
  counter = 10;
  bump();
  return counter;
}
`,
    suggestedStage: 'sim',
    explanation:
      'counter lives in the data section rather than on the stack: the IR names it @counter and the execution view shows its bytes next to the stack frames. Because bump() may change it, no pass may assume what a global holds across a call — which is why the optimiser leaves this program alone.',
    expected: 'success',
  },
  {
    id: 'scopes-and-shadowing',
    title: 'Scopes and shadowing',
    category: 'learn',
    objective: 'See two symbols with the same name live in different scopes.',
    code: `int main() {
  int value = 1;
  int result = value;
  {
    int value = 2;
    result = result + value;
  }
  return result + value;
}
`,
    suggestedStage: 'sema',
    explanation:
      'The inner declaration hides the outer one only inside its own block. The scope tree shows two separate symbols called value, each with its own uses, and the outer one is visible again after the block closes. Redeclaring in the same scope instead would be an error — see the redeclaration example.',
    expected: 'success',
  },
  {
    id: 'while-break',
    title: 'Break and continue in a while loop',
    category: 'learn',
    objective: 'See a loop decide for itself when to skip an iteration and when to stop.',
    code: `int main() {
  int i = 0;
  int sum = 0;
  while (1) {
    i++;
    if (i == 3) continue;
    if (i > 6) break;
    sum = sum + i;
  }
  return sum;
}
`,
    suggestedStage: 'ir',
    explanation:
      'while (1) never ends on its own, so every exit is explicit: continue jumps back to the condition check, break jumps to the end block. The IR gives each of those paths its own labelled block, and the execution stage lets you step around the loop.',
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
  {
    id: 'unsupported-character',
    title: 'Unsupported character',
    category: 'error',
    objective: 'Watch an illegal character stop the lexer before parsing can begin.',
    code: `int main() {
  int x = 1 @ 2;
  return x;
}
`,
    suggestedStage: 'lex',
    explanation:
      '@ is not part of Mini-C. The lexer reports E1010 at that exact character and fails, so parsing, semantics and IR are all blocked — the stages below stay blocked rather than guessing. The Token Explorer still shows every token scanned up to the error.',
    expected: 'error',
    expectedErrorCodes: ['E1010'],
  },
  {
    id: 'reserved-keyword',
    title: 'Reserved keyword',
    category: 'error',
    objective: 'See a reserved-but-unsupported word refused instead of used as a name.',
    code: `int main() {
  int struct = 1;
  return struct;
}
`,
    suggestedStage: 'parse',
    explanation:
      'struct is reserved for a future Mini-C that does not exist yet. The lexer recognises it as a word rather than mis-lexing it, and the parser refuses it with E1010 — so the error points at the word itself, not at some later symptom.',
    expected: 'error',
    expectedErrorCodes: ['E1010'],
  },
  {
    id: 'redeclaration',
    title: 'Redeclaration in the same scope',
    category: 'error',
    objective: 'Compare a redeclaration (an error) with shadowing in a nested block (allowed).',
    code: `int main() {
  int x = 1;
  int x = 2;
  return x;
}
`,
    suggestedStage: 'sema',
    explanation:
      'The second int x reuses the name in the same scope, so semantic analysis reports E3002 with a note pointing at the first declaration. Putting the second one in its own { } block instead would be shadowing, which is allowed — see the scopes and shadowing example.',
    expected: 'error',
    expectedErrorCodes: ['E3002'],
  },
];

export function getExampleById(id: string | null): Example | null {
  if (id === null) return null;
  return EXAMPLES.find((example) => example.id === id) ?? null;
}
