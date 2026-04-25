import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Windows runners under load take 25-40s for git + scaffold
    // integration tests and trip the 20s ceiling, leaving subprocesses
    // holding files open which cascades into EBUSY rmdir failures
    // across the rest of the suite. 60s gives generous headroom;
    // healthy POSIX runs still finish in <5s.
    testTimeout: 60_000,
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
