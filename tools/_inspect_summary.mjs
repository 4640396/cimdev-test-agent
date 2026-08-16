import { readFileSync } from 'node:fs'
const text = readFileSync(new URL('../workers/runner/src/test-kernel.ts', import.meta.url), 'utf8')
const lines = text.split(/\r?\n/)
lines.slice(311, 315).forEach((line, index) => console.log(index + 312, JSON.stringify(line)))
