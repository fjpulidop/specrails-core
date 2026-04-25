import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      reporter: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],
      // Hard gates for the cross-platform installer. Set deliberately
      // below the current local pass rate so legitimate refactors
      // don't bounce; raise as the codebase matures. CI-enforced.
      thresholds: {
        lines: 75,
        functions: 75,
        statements: 75,
        branches: 70,
      },
    },
  },
})
