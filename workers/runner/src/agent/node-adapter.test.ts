import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverNodeTestCases } from './node-adapter.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('NodeAdapter', () => {
  it('discovers node test and spec files while skipping dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'node-adapter-'))
    dirs.push(root)
    mkdirSync(join(root, 'test'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'test', 'math.test.js'), '')
    writeFileSync(join(root, 'node_modules', 'dep', 'skip.spec.js'), '')

    expect(discoverNodeTestCases(root).map((item) => item.source)).toEqual([join('test', 'math.test.js')])
  })
})
