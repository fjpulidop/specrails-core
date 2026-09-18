import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Safety net: pin SPECRAILS_REGISTRY_HOME to a throwaway tmp dir so no test
    // can write the relocation registry/workspace into the real ~/.specrails.
    setupFiles: ['src/installer/__tests__/vitest-setup.ts'],
    // Windows runners under load take 25-40s for git + scaffold
    // integration tests and trip the 20s ceiling, leaving subprocesses
    // holding files open which cascades into EBUSY rmdir failures
    // across the rest of the suite. 60s gives generous headroom;
    // healthy POSIX runs still finish in <5s. The programmatic-runtime
    // host tests (core-host, compact-runtime) drive three or four real
    // workflows per test — git + OpenSpec + spawned verification — and a
    // loaded Windows runner has taken >60s on one (run 35369707501), so
    // win32 gets a wider ceiling; POSIX keeps the tight one.
    testTimeout: process.platform === 'win32' ? 180_000 : 60_000,
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
