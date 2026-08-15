import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    include: ['apps/**/*.test.ts', 'workers/**/*.test.ts', 'contracts/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'out/**']
  }
})
