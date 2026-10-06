import eslintConfigPrettier from 'eslint-config-prettier'
import pluginImport from 'eslint-plugin-import'
import unusedImports from 'eslint-plugin-unused-imports'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/*',
      '**/.next/*',
      '**/.contentlayer/*',
      '**/node_modules/*',
    ],
  },

  // CLI package: enforce using CliProcessEnv instead of ProcessEnv
  {
    files: ['cli/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@codebuff/common/env-process',
              importNames: ['getProcessEnv', 'processEnv'],
              message:
                'CLI should use getCliEnv() from "../utils/env" or "./env" instead of getProcessEnv() from common. This ensures CLI uses CliEnv type.',
            },
          ],
          patterns: [
            {
              group: ['@codebuff/common/types/contracts/env'],
              importNames: ['ProcessEnv'],
              message:
                'CLI should use CliEnv from "../types/env" instead of ProcessEnv from common.',
            },
          ],
        },
      ],
    },
  },

  // SDK package: enforce using SdkProcessEnv instead of ProcessEnv
  {
    files: ['sdk/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@codebuff/common/env-process',
              importNames: ['getProcessEnv', 'processEnv'],
              message:
                'SDK should use getSdkEnv() from "./env" instead of getProcessEnv() from common. This ensures SDK uses SdkEnv type.',
            },
          ],
          patterns: [
            {
              group: ['@codebuff/common/types/contracts/env'],
              importNames: ['ProcessEnv'],
              message:
                'SDK should use SdkEnv from "./types/env" instead of ProcessEnv from common.',
            },
          ],
        },
      ],
    },
  },

  // Base config for JS/TS files
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: pluginImport,
      'unused-imports': unusedImports,
      '@typescript-eslint': tseslint.plugin,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      'import/order': [
        'warn',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'type',
          ],
          alphabetize: { order: 'asc', caseInsensitive: true },
          'newlines-between': 'always',
        },
      ],
      'import/no-unresolved': 'off', // Disabled: TypeScript/Bun handles module resolution; this rule produces false positives with path aliases
      'import/no-duplicates': 'warn',
      'unused-imports/no-unused-imports': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_', // Allow unused args prefixed with _
          varsIgnorePattern: '^_', // Allow unused vars prefixed with _
          args: 'none', // Don't check function arguments (common in callbacks with required signatures)
        },
      ],
      'react-hooks/exhaustive-deps': 'off', // Disabled: plugin not configured for all packages
      '@next/next/no-img-element': 'off', // Disabled: plugin not configured for all packages
    },
  },

  // Prettier config (last to override formatting rules)
  eslintConfigPrettier,
)
