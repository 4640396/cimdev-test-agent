import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExistingMavenAdapter, discoverMavenTestCases } from './existing-maven-adapter.js'

describe('ExistingMavenAdapter', () => {
  it('discovers root and multi-module Maven test classes deterministically', async () => {
    const root = join(process.cwd(), '.test-agent', 'existing-maven-fixture')
    mkdirSync(join(root, 'src', 'test', 'java', 'demo'), { recursive: true })
    mkdirSync(join(root, 'module-a', 'src', 'test', 'java', 'demo'), { recursive: true })
    writeFileSync(join(root, 'pom.xml'), '<project/>')
    writeFileSync(join(root, 'src', 'test', 'java', 'demo', 'AlphaTest.java'), 'class AlphaTest {}')
    writeFileSync(join(root, 'module-a', 'src', 'test', 'java', 'demo', 'BetaIT.java'), 'class BetaIT {}')

    expect(discoverMavenTestCases(root).map((item) => item.title)).toEqual(['BetaIT', 'AlphaTest'])
    const result = await new ExistingMavenAdapter().run({
      projectPath: root,
      systemName: 'fixture',
      version: 'main',
      testTypes: ['unit', 'regression'],
      requiredCapabilities: ['java']
    }, () => undefined)
    expect(result.cases).toHaveLength(2)
    expect(result.lanes.map((lane) => lane.type)).toEqual(['unit', 'regression'])
  })
})
