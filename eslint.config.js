// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/workflows run in Claude Code's workflow runtime (agent/pipeline/args
  // globals, top-level return); its hooks are plain Node scripts.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.claude/workflows/**'] },
  { files: ['.claude/hooks/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // The codebase uses `_`-prefixed names for intentionally unused values.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  { files: ['**/*.js', 'scripts/**'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
);
