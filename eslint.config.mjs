// Lint rules for this extension's TypeScript. Linting is report-only for now: CI shows findings
// as annotations without failing the build. The rules beyond typescript-eslint's type-checked
// recommendations target this codebase's real risks: unhandled promises in the extension host,
// unsafe or needless type escapes, and synchronous file I/O, which blocks the extension host's
// single thread. A justified exception is marked where it occurs, with its reason:
//   // eslint-disable-next-line <rule> -- <reason>

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
    {
        ignores: ['out/', 'out-test/', 'coverage/', '.vscode-test/', 'node_modules/', 'tests/manual/', 'tests/fixtures/'],
    },
    js.configs.recommended,
    {
        files: ['**/*.ts'],
        extends: [tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: {
                // Type information for src/ and tests/ alike. Type-aware rules need it.
                project: ['./tsconfig.json', './test.tsconfig.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Async correctness. A dropped promise in the extension host loses its error silently.
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/require-await': 'error',

            // Type escapes and conditions the types already decide.
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'warn',
            '@typescript-eslint/no-unnecessary-condition': 'warn',
            '@typescript-eslint/no-unnecessary-type-assertion': 'error',
            '@typescript-eslint/switch-exhaustiveness-check': 'error',

            // Clearer equivalents.
            '@typescript-eslint/prefer-nullish-coalescing': 'warn',
            '@typescript-eslint/prefer-optional-chain': 'warn',
            '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
            'eqeqeq': 'error',
            'prefer-const': 'error',

            // Performance. Sequential awaits in a loop are sometimes deliberate, so this only warns.
            'no-await-in-loop': 'warn',
        },
    },
    {
        // Synchronous file I/O blocks the extension host thread, which every extension shares.
        files: ['src/**/*.ts'],
        rules: {
            'no-restricted-properties': ['warn',
                ...['existsSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync', 'writeFileSync'].map((property) => ({
                    object: 'fs',
                    property,
                    message: 'Synchronous file I/O blocks the extension host thread. Use fs.promises.',
                })),
            ],
        },
    },
    {
        // Test doubles cast deliberately, implement async interfaces without awaiting, and tests
        // assert on values they know exist.
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
        },
    },
);
