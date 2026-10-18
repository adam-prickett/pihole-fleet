// Lint rules: Google TypeScript Style (gts) plus checks for parts of the Google TypeScript
// style guide that gts doesn't enforce (https://google.github.io/styleguide/tsguide.html).
const globals = require('globals');
const gts = require('gts');

module.exports = [
  {ignores: ['build/', 'dist/', 'data/', 'node_modules/', '**/*.cjs']},
  ...gts,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.server.json', './tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: __dirname,
        ecmaFeatures: {jsx: true},
      },
    },
    rules: {
      // "Use named exports"; "Do not use #private fields"; "Do not use for...in".
      'no-restricted-syntax': [
        'error',
        {selector: 'ExportDefaultDeclaration', message: 'Use named exports, not default exports.'},
        {selector: 'PrivateIdentifier', message: 'Use the TypeScript `private` modifier, not #private fields.'},
        {selector: 'ForInStatement', message: 'Use for...of over Object.keys/entries instead of for...in.'},
      ],
      // "Use interfaces for object types"; "T[] for simple types, Array<T> otherwise".
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      // "import type" for type-only imports.
      '@typescript-eslint/consistent-type-imports': ['error', {fixStyle: 'inline-type-imports'}],
      // "Avoid any"; "Only throw Error objects"; "Don't use `public`" (it's the default).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', {accessibility: 'no-public'}],
      // "Type assertions: use `as`, never on object literals".
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {assertionStyle: 'as', objectLiteralTypeAssertions: 'never'},
      ],
      // "Don't annotate trivially inferred types".
      '@typescript-eslint/no-inferrable-types': 'error',
      // "Use === except for == null comparisons".
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      // "Control flow statements use braces, except single-line if statements".
      curly: ['error', 'multi-line'],
      'no-eval': 'error',
      'no-new-wrappers': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
      // Naming: lowerCamelCase values, UpperCamelCase types/classes/components,
      // CONSTANT_CASE for module-level constants.
      '@typescript-eslint/naming-convention': [
        'error',
        {selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow'},
        {selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase']},
        {selector: 'function', format: ['camelCase', 'PascalCase']},
        {selector: 'parameter', format: ['camelCase', 'PascalCase'], leadingUnderscore: 'allow'},
        {selector: 'typeLike', format: ['PascalCase']},
        {selector: 'enumMember', format: ['UPPER_CASE']},
        // Object keys mirror external formats (HTTP headers, Pi-hole API fields, CSS).
        {selector: ['objectLiteralProperty', 'objectLiteralMethod', 'typeProperty'], format: null},
        {selector: 'import', format: ['camelCase', 'PascalCase']},
      ],
    },
  },
  {
    files: ['src/**/*.tsx', 'src/**/*.ts'],
    languageOptions: {globals: globals.browser},
  },
  {
    files: ['server/**/*.ts', 'vite.config.ts'],
    languageOptions: {globals: globals.node},
  },
];
