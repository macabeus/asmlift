/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-playground-to-benchmark',
      comment:
        'Pages must not import from each other. Move shared code to src/shared/ ' +
        '(components in src/shared/components, utilities in src/shared/utils).',
      severity: 'error',
      from: { path: '^src/pages/playground/' },
      to: { path: '^src/pages/benchmark/' },
    },
    {
      name: 'no-benchmark-to-playground',
      comment:
        'Pages must not import from each other. Move shared code to src/shared/ ' +
        '(components in src/shared/components, utilities in src/shared/utils).',
      severity: 'error',
      from: { path: '^src/pages/benchmark/' },
      to: { path: '^src/pages/playground/' },
    },
    {
      name: 'page-entry-points-only',
      comment:
        "Only a page's entry component may be imported from outside the page — " +
        'playground/Playground and benchmark/Benchmark are the only allowed entry points. ' +
        'Everything else in a page is internal. (Unit tests live outside src/ and are not scanned.)',
      severity: 'error',
      from: { pathNot: '^src/pages/' },
      to: {
        path: '^src/pages/',
        pathNot: '^src/pages/(playground/Playground|benchmark/Benchmark)\\.',
      },
    },
    {
      name: 'no-shared-to-pages',
      comment:
        'Shared code (src/shared/) must not depend on any page — shared is the common base, ' +
        'not a place to reach into a page.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/pages/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    // Resolve extensionless TS imports (e.g. "./pages/playground/Playground"). Required here
    // because the tsConfig alone doesn't register .ts/.tsx with the resolver under TypeScript 7,
    // and without it every cross-module dependency stays "unknown" and no rule can ever fire.
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
