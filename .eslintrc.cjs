module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'prettier'
  ],
  ignorePatterns: ['dist', 'out', 'build', '.eslintrc.cjs', '*.config.*'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  settings: {
    react: { version: 'detect' }
  },
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    // Disable triple-slash-reference rule — both env.d.ts lines are standard
    // electron-vite boilerplate (/// <reference types="vite/client" /> and
    // /// <reference path="preload/index.d.ts" />) with no import equivalent.
    '@typescript-eslint/triple-slash-reference': 'off',
    // allowpopups is a valid Electron <webview> element attribute — it is not a
    // standard HTML property, so react/no-unknown-property must be told to allow it.
    'react/no-unknown-property': ['error', { ignore: ['allowpopups'] }]
  }
}
