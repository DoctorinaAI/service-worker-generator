import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  { ignores: ['dist/', 'playwright-report/', 'test-results/'] },
  ...tsPlugin.configs['flat/recommended'],
  {
    rules: {
      // Mocks keep the parameters of the API they stand in for.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
