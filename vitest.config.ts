import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-live.ts'],
    // Live Magpie DeepSeek turns are slower than MockModel.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Live/demo drivers need provider keys and gh auth. They are not part of
      // the offline coverage baseline; `pnpm test:coverage` also excludes their
      // test files.
      exclude: ['src/cli/demos/**', 'test/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
