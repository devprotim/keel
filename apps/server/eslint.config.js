import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // MemoryDocStore and the AI provider test doubles deliberately implement
      // async interfaces with synchronous bodies, so callers and future
      // implementations (a Postgres-backed store, a real provider) share one
      // Promise-returning contract. Not a bug this rule should catch here.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
