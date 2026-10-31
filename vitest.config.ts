import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-live.ts'],
    // Live Magpie DeepSeek turns are slower than MockModel.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
