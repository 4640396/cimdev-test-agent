import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'workers/**/*.test.ts', 'contracts/**/*.test.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'out/**']
  }
})
