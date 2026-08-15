import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const dshRoot = resolve(process.cwd(), 'third-party', 'dsh')
const dshAliases = {
  '@deepseek-ai/cordis': 'vendor/cordis/src/index.ts',
  '@deepseek-ai/cordis-plugin-include': 'vendor/include/src/index.ts',
  '@deepseek-ai/cordis-plugin-loader': 'vendor/loader/src/index.ts',
  '@deepseek-ai/cosmokit': 'vendor/cosmokit/src/index.ts',
  '@deepseek-ai/schemastery': 'vendor/schemastery/src/index.ts',
  '@deepseek-ai/dsh-brand': 'packages/util/brand/src/index.ts',
  '@deepseek-ai/dsh-invariants': 'packages/runtime-diagnostics/invariants/src/index.ts',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm/src/index.ts',
  '@deepseek-ai/dsh-scope': 'packages/core/scope/src/index.ts',
  '@deepseek-ai/dsh-typert-protocol': 'packages/typert/protocol/src/index.ts',
  '@deepseek-ai/dsh-session': 'packages/core/session/src/index.ts',
  '@deepseek-ai/dsh-session-persistence': 'packages/session/session-persistence/src/index.ts',
  '@deepseek-ai/dsh-session-persistence-jsonl': 'packages/session/session-persistence-jsonl/src/index.ts',
  '@deepseek-ai/dsh-storage': 'packages/storage/storage/src/index.ts',
  '@deepseek-ai/dsh-storage-domain': 'packages/storage/storage-domain/src/index.ts',
  '@deepseek-ai/dsh-storage-json': 'packages/storage/storage-json/src/index.ts',
  '@deepseek-ai/dsh-subprocess': 'packages/subprocess/subprocess/src/index.ts',
  '@deepseek-ai/dsh-subprocess-local': 'packages/subprocess/subprocess-local/src/index.ts',
  '@deepseek-ai/dsh-timeout': 'packages/util/timeout/src/index.ts',
  '@deepseek-ai/dsh-workspace': 'packages/workspace/workspace/src/index.ts',
  '@deepseek-ai/dsh-sandbox': 'packages/sandbox/sandbox/src/index.ts',
  '@deepseek-ai/dsh-sandbox-local': 'packages/sandbox/sandbox-local/src/index.ts',
  '@deepseek-ai/dsh-sandbox-windows-acl': 'packages/sandbox/sandbox-windows-acl/src/index.ts',
  '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment/src/index.ts'
}

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(Object.entries(dshAliases).map(([name, relativePath]) => [name, resolve(dshRoot, relativePath)]))
  },
  test: {
    testTimeout: 15_000,
    hookTimeout: 15_000,
    include: ['apps/**/*.test.ts', 'workers/**/*.test.ts', 'contracts/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['legacy/**', 'node_modules/**', 'out/**']
  }
})
