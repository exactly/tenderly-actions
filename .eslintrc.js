/** @type {import('eslint').Linter.Config} */
module.exports = {
  parserOptions: { project: 'tsconfig.json' },
  settings: { 'import/resolver': 'typescript' },
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:node/recommended',
    'plugin:eslint-comments/recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    'no-continue': 'off',
    'no-await-in-loop': 'off',
    'no-restricted-syntax': 'off',
    'node/no-missing-import': ['error', { tryExtensions: ['.ts', '.js', '.json'] }],
    'eslint-comments/no-unused-disable': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, args: 'all', argsIgnorePattern: '^_' }],
    'node/no-unsupported-features/es-syntax': ['error', { ignores: ['modules', 'dynamicImport'] }],
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
  overrides: [
    { files: ['actions/**/*'], parserOptions: { project: 'actions/tsconfig.json' } },
    { files: ['{scripts,test}/**/*'], rules: { 'import/no-extraneous-dependencies': ['error', { devDependencies: true }] } },
    {
      files: ['test/**/*'],
      extends: ['plugin:mocha/recommended', 'plugin:chai-expect/recommended', 'plugin:chai-friendly/recommended'],
      rules: {
        'node/no-missing-import': 'off',
        'mocha/no-mocha-arrows': 'off',
        'mocha/no-exclusive-tests': 'error',
      },
    },
  ],
};
