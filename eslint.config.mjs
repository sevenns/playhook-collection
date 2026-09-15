// Flat ESLint config, ported from playhook. Type-aware linting over src/, scripts/ and test/ with the
// same high-value async-safety rules: no-floating-promises / no-misused-promises catch forgotten
// awaits, and strict-boolean-expressions catches implicit nullable/number truthiness.
// eslint-config-prettier is applied last so no lint rule fights the formatter. The scripts are plain
// JavaScript under `// @ts-check`, so the type-aware rules reach them through tsconfig's allowJs.
// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.*'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'scripts/**/*.mjs', 'test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The launcher's "no non-null `!`" rule, enforced rather than left to discipline: tsc cannot
      // express it and recommendedTypeChecked does not carry it.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          // The codebase already writes explicit comparisons (=== true, !== undefined, .length > 0);
          // these options keep the rule aligned with that style without a mechanical rewrite.
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: {
      // The scripts are JavaScript, so core ESLint still runs no-undef on them — and flags `console` and
      // `process`, which are Node's. typescript-eslint switches the rule off for .ts files because the
      // compiler reports an unknown name anyway; under `// @ts-check` with @types/node the same holds
      // here, and it costs no `globals` dependency.
      'no-undef': 'off',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // An assertion on a fake's method references it unbound on purpose, and a fake implementing an
      // async interface has nothing to await — both fire on every test double, and neither says anything.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  prettier,
);
