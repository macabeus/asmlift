import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import unusedImports from 'eslint-plugin-unused-imports';

export default [
  {
    // `pnpm lint` is `eslint .`, and two of the trees under `.` are gitignored working dirs that
    // are not this repo's code — so linting them makes the command mean one thing in CI (which
    // clones neither) and another on a developer's machine.
    //
    //   research/                   scratch probes. Present only in a full checkout, and its
    //                               errors are unfixable BY a commit — the files are gitignored,
    //                               so `pnpm lint` sat permanently at "3 errors" locally while CI
    //                               was green. A gate that is always red teaches you to skip it,
    //                               and the house rule that grew around it (`eslint apps
    //                               packages`, not `pnpm lint`) then drifted between two prompts.
    //   apps/benchmark/checkouts/   the real tier's decomp projects, 2.2 GB of OTHER people's
    //                               source. In a full checkout that is 218 more files linted
    //                               against rules they never agreed to.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/benchmark/.cache/**',
      'research/**',
      'apps/benchmark/checkouts/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
  },
  {
    plugins: {
      '@typescript-eslint': typescriptEslint,
      'unused-imports': unusedImports,
    },

    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },

    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],

      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      semi: 'warn',

      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      'no-restricted-syntax': [
        'error',
        {
          selector: ':matches(PropertyDefinition, MethodDefinition)[accessibility="private"]',
          message: 'Use #private instead',
        },
      ],
    },
  },
  {
    // gates.ts `without` is the TEST-ONLY ablation (guardedBy differential tests must ablate sound
    // gates); shipped code derives ablated tables through `ablateHeuristic`, which refuses them.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: ':matches(PropertyDefinition, MethodDefinition)[accessibility="private"]',
          message: 'Use #private instead',
        },
        {
          selector: 'ImportSpecifier[imported.name="without"]',
          message: 'gates.ts `without` is test-only — shipped ablation goes through `ablateHeuristic`',
        },
      ],
    },
  },
];
