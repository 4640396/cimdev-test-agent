import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { TaskInput, TestType } from '../../../../contracts/src/contracts.js'
import type { TestCase } from '../router.js'
import type { AgentAdapter, AgentEvent, AgentRunResult } from './types.js'

const SKIP_DIRS = new Set(['node_modules', '.git', '.test-agent', 'out', 'dist', 'coverage'])

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(path))
    } else if (/(\.(test|spec)\.(js|mjs|cjs|ts))$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

export function discoverNodeTestCases(projectPath: string): TestCase[] {
  return walk(projectPath).sort().map((path, index) => ({
    id: `existing-node-${index + 1}`,
    title: basename(path),
    scenario: `Execute existing Node test file ${basename(path)}`,
    steps: ['Run the Node test runner with real coverage collection', 'Parse pass/fail and coverage results'],
    expected: 'The test file completes without assertion or module errors',
    priority: 'high',
    layer: 'unit',
    source: relative(projectPath, path)
  }))
}

export class NodeAdapter implements AgentAdapter {
  readonly name = 'Existing Node Suite'

  async run(input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    if (!existsSync(join(input.projectPath, 'package.json'))) {
      throw new Error('Existing Node provider requires a package.json at the project root')
    }
    const cases = discoverNodeTestCases(input.projectPath)
    emit({ level: cases.length > 0 ? 'success' : 'warning', message: `Discovered ${cases.length} existing Node test file(s)` })
    const types = input.testTypes.filter((type): type is TestType => type === 'unit' || type === 'regression')
    return {
      lanes: types.map((type) => ({ type, status: 'passed', summary: 'Existing suite discovered; final status is decided by independent Node verification' })),
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases
    }
  }
}
