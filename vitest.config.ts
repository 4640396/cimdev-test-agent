import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const dshRoot = resolve(process.cwd(), 'third-party', 'harness')
const dshAliases = {
  '@cimdev/harness/cordis': 'vendor/cordis/src/index.ts',
  '@cimdev/harness/cordis-plugin-include': 'vendor/include/src/index.ts',
  '@cimdev/harness/cordis-plugin-loader': 'vendor/loader/src/index.ts',
  '@cimdev/harness/cosmokit': 'vendor/cosmokit/src/index.ts',
  '@cimdev/harness/schemastery': 'vendor/schemastery/src/index.ts',
  '@cimdev/harness/dsh-brand': 'packages/util/brand/src/index.ts',
  '@cimdev/harness/dsh-invariants': 'packages/runtime-diagnostics/invariants/src/index.ts',
  '@cimdev/harness/dsh-llm': 'packages/llm/llm/src/index.ts',
  '@cimdev/harness/dsh-scope': 'packages/core/scope/src/index.ts',
  '@cimdev/harness/dsh-typert-protocol': 'packages/typert/protocol/src/index.ts',
  '@cimdev/harness/dsh-session': 'packages/core/session/src/index.ts',
  '@cimdev/harness/dsh-session-persistence': 'packages/session/session-persistence/src/index.ts',
  '@cimdev/harness/dsh-session-persistence-jsonl': 'packages/session/session-persistence-jsonl/src/index.ts',
  '@cimdev/harness/dsh-storage': 'packages/storage/storage/src/index.ts',
  '@cimdev/harness/dsh-storage-domain': 'packages/storage/storage-domain/src/index.ts',
  '@cimdev/harness/dsh-storage-json': 'packages/storage/storage-json/src/index.ts',
  '@cimdev/harness/dsh-subprocess': 'packages/subprocess/subprocess/src/index.ts',
  '@cimdev/harness/dsh-subprocess-local': 'packages/subprocess/subprocess-local/src/index.ts',
  '@cimdev/harness/dsh-timeout': 'packages/util/timeout/src/index.ts',
  '@cimdev/harness/dsh-workspace': 'packages/workspace/workspace/src/index.ts',
  '@cimdev/harness/dsh-sandbox': 'packages/sandbox/sandbox/src/index.ts',
  '@cimdev/harness/dsh-sandbox-local': 'packages/sandbox/sandbox-local/src/index.ts',
  '@cimdev/harness/dsh-sandbox-windows-acl': 'packages/sandbox/sandbox-windows-acl/src/index.ts',
  '@cimdev/harness/dsh-attachment': 'packages/attachment/attachment/src/index.ts',
  '@cimdev/harness/node-addon-landlock-run': 'native/landlock-run/packages/entry/src/index.ts',
  '@cimdev/harness/dsh-workflow': 'packages/workflow/workflow/index.ts',
  '@cimdev/harness/dsh-tool-workflow': 'packages/workflow/tool-workflow/index.ts'
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
