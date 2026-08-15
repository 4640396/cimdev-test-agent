import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

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
