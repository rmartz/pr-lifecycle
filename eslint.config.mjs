// @ts-check
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for @rmartz/pr-lifecycle. Descended from the bot-automerge /
 * merge-safety configs (the fleet's code-style rules, promoted from AGENTS.md
 * prose to static enforcement), plus type-aware rules: this package is a state
 * reconciler whose correctness hinges on exhaustively handled states and awaited
 * GitHub API calls, so `switch-exhaustiveness-check` and `no-floating-promises`
 * earn their type-checking cost. Type information comes from tsconfig.json, which
 * covers src/ and test/.
 */

/** Code-style conventions enforced statically (see AGENTS.md §Code standards). */
const STYLE_RULES = {
  // Strict TypeScript — no `any`, no `@ts-ignore`. `ban-ts-comment` still permits
  // `@ts-expect-error` with a description (the sanctioned hatch).
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
  // Type-only imports: `import type`, side-effect-free (companion pair).
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-inferrable-types': 'error',
  // Every state/verdict union must be handled exhaustively — a new state that a
  // switch silently falls through is exactly the bug this package must not have.
  '@typescript-eslint/switch-exhaustiveness-check': [
    'error',
    { considerDefaultExhaustiveForUnions: false },
  ],
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  'import/no-cycle': ['error', { maxDepth: 1 }],
};

// "Prefer async/await over .then() chains", "No IIFEs", and "Named exports only".
// Core `no-restricted-syntax` selectors, so there is no plugin-compat risk.
// Config files are globally ignored, so tsup / eslint / vitest configs keep their
// required default export.
const RESTRICTED_SYNTAX = [
  {
    selector: "CallExpression[callee.property.name='then']",
    message: 'Prefer async/await over .then() chains (AGENTS.md).',
  },
  {
    selector: 'CallExpression[callee.type=/FunctionExpression|ArrowFunctionExpression/]',
    message:
      'No IIFEs — extract a named helper or compute the value with a plain expression (AGENTS.md).',
  },
  {
    selector: 'ExportDefaultDeclaration',
    message: 'Named exports only — no default exports (AGENTS.md).',
  },
];

// Tests additionally forbid Vitest's `test()` alias — the repo uses describe/it.
const TEST_RESTRICTED_SYNTAX = [
  ...RESTRICTED_SYNTAX,
  {
    selector: "CallExpression[callee.name='test']",
    message: 'Use it() from Vitest, not test() (AGENTS.md).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.config.*',
      '.git-worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: ['tsconfig.json'] },
        node: true,
      },
    },
  },
  {
    // Package source. max-lines is the JS/TS file-length hard cap (non-TS files
    // are capped by repo-hygiene's file-caps check): aim for ~200 lines, split at
    // ~240, hard ceiling 400.
    files: ['src/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: false, skipComments: false }],
      ...STYLE_RULES,
      'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX],
    },
  },
  {
    // Tests — table-driven cases and fixtures legitimately run longer.
    files: ['test/**/*.ts'],
    rules: {
      'max-lines': ['error', { max: 600, skipBlankLines: false, skipComments: false }],
      ...STYLE_RULES,
      'no-restricted-syntax': ['error', ...TEST_RESTRICTED_SYNTAX],
    },
  },
  {
    // Plain JS/MJS files (Node scripts under scripts/; this config itself is
    // ignored) get no type info, but do run under Node.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
