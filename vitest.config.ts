import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    exclude: ['dist/**', 'node_modules/**'],
  },
})
