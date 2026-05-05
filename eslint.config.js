import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const PURE_FORBIDDEN = [
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      'Math.random is forbidden inside `pure: true` node evaluators (V2). Use mulberry32(seed) and pass `seed` as a parameter.',
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      'Date.now is forbidden inside `pure: true` node evaluators (V2/V3). Time enters via the `Time` socket.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message:
      'performance.now is forbidden inside `pure: true` node evaluators (V2/V3). Time enters via the `Time` socket.',
  },
  {
    selector: "MemberExpression[object.name='crypto'][property.name='randomUUID']",
    message:
      'crypto.randomUUID is forbidden inside `pure: true` node evaluators (V2). Use a deterministic id from (params, inputs).',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'build', 'node_modules', 'playwright-report', 'test-results', 'blockbench'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/nodes/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...PURE_FORBIDDEN],
    },
  },
);
