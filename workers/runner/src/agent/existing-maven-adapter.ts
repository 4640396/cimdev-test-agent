import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { TaskInput, TestType } from '../../../../contracts/src/contracts.js'
import type { TestCase } from '../router.js'
import type { AgentAdapter, AgentEvent, AgentRunResult } from './types.js'

function walk(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (/((Test|Tests|IT)\.java)$/.test(entry.name)) files.push(path)
  }
  return files
}

export function discoverMavenTestCases(projectPath: string): TestCase[] {
  const roots = [join(projectPath, 'src', 'test', 'java')]
  for (const module of readdirSync(projectPath, { withFileTypes: true })) {
    if (module.isDirectory()) roots.push(join(projectPath, module.name, 'src', 'test', 'java'))
  }
  const unique = [...new Set(roots.flatMap(walk))].sort()
  return unique.map((path, index) => ({
    id: `existing-maven-${index + 1}`,
    title: basename(path, '.java'),
    scenario: `Execute existing Maven test class ${basename(path)}`,
    steps: ['Run the Maven test lifecycle in the isolated executor', 'Collect Surefire/Failsafe and coverage results'],
    expected: 'The test class completes without compilation or assertion failures',
    priority: 'high',
    layer: 'unit',
    source: relative(projectPath, path)
  }))
}

export class ExistingMavenAdapter implements AgentAdapter {
  readonly name = 'Existing Maven Suite'

  async run(input: TaskInput, emit: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentRunResult> {
    if (signal?.aborted) throw new Error('Task cancelled')
    if (!existsSync(join(input.projectPath, 'pom.xml'))) throw new Error('Existing Maven provider requires a pom.xml at the project root')
    const cases = discoverMavenTestCases(input.projectPath)
    emit({ level: cases.length > 0 ? 'success' : 'warning', message: `Discovered ${cases.length} existing Maven test class(es)` })
    const types = input.testTypes.filter((type): type is TestType => type === 'unit' || type === 'regression')
    return {
      lanes: types.map((type) => ({ type, status: 'passed', summary: 'Existing suite discovered; final status is decided by independent Maven verification' })),
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases
    }
  }
}
