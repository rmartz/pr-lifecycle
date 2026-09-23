import { defineConfig } from 'vitest/config';

// Single-package repo: vitest globs the whole test tree, so there is no manual
// discovery list to fall out of sync with the files on disk.
//
// Coverage thresholds are enforced (CI runs `test:coverage`). The reconciler is
// the kind of logic where an untested branch is a latent mis-merge, so the bar
// starts high while the codebase is small — lowering a threshold is a CI
// loosening and goes in its own PR (see AGENTS.md).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // bin/ is a thin process-boundary shim over the tested cli module;
      // index.ts is a re-export barrel.
      exclude: ['src/bin/**', 'src/index.ts'],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
