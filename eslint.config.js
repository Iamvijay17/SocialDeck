import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'data/**', 'backups/**', 'coverage/**', '.claude/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // The web app is JSX. Without a React plugin ESLint cannot see components used only in JSX, so imports starting
    // with a capital letter are exempt from the unused-variable rule here.
    files: ['apps/web/**/*.{js,jsx}'],
    languageOptions: { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^([A-Z]|_)', caughtErrors: 'none' }] },
  },
  { files: ['apps/web/vite.config.js'], languageOptions: { globals: { ...globals.node } } },
];
