import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['test/e2e.test.ts', 'node_modules/**', 'examples/**/node_modules/**', 'examples/**/tests/**'],
  },
})
