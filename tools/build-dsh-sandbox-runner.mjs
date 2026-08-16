import { build } from 'esbuild'
import { resolve } from 'node:path'

const pkg = resolve(process.cwd(), 'third-party', 'harness', 'packages', 'sandbox', 'sandbox-windows-acl')
const entry = resolve(pkg, 'src', 'runner.ts')
const outfile = resolve(pkg, 'lib', 'runner.js')

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2024',
  external: ['koffi'],
  logLevel: 'info',
})

console.log(`DSH sandbox runner built: ${outfile}`)
