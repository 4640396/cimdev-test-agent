import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

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
  '@cimdev/harness/dsh-attachment': 'packages/attachment/attachment/src/index.ts'
}
const dshResolveAlias = Object.fromEntries(Object.entries(dshAliases).map(([name, relativePath]) => [name, resolve(dshRoot, relativePath)]))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: dshResolveAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve('apps/desktop/src/main/index.ts'),
          'worker-cli': resolve('workers/runner/src/worker-cli.ts'),
          'host-cli': resolve('workers/runner/src/host-cli.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('apps/desktop/src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [vue()],
    resolve: { alias: { '@renderer': resolve('apps/desktop/src/renderer/src') } },
    build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } }
  }
})
