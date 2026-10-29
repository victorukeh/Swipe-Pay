// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.yarn/**', 'coverage/**', 'src/generated/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Money must never touch floating point. Catch the obvious offenders.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer-only. Use MoneyUtil.parse().' },
        { name: 'parseInt', message: 'Use BigInt() or MoneyUtil instead.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'Money is integer-only. Use MoneyUtil.parse().' },
        { object: 'Math', property: 'round', message: 'Rounding belongs in MoneyUtil, on BigInt.' },
      ],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // `expect(obj.method).toHaveBeenCalled()` is the standard Jest idiom and
      // deliberately passes the function unbound.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
