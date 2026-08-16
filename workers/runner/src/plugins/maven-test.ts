import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { MavenTestOutcome } from '../validator.js'
import type { WorkerPlugin } from './runtime.js'

export interface MavenTestInput {
  required: boolean
}

export interface MavenTestOutput extends MavenTestOutcome {
  executed: boolean
  required: boolean
  artifact: string | null
}

export const mavenTestPlugin: WorkerPlugin<'maven_test', MavenTestInput, MavenTestOutput> = {
  name: 'maven_test',
  policy: { timeoutMs: 300_000, maxAttempts: 1 },
  async execute(context, input) {
    if (!input.required) {
      return { executed: false, required: false, artifact: null, ok: true, tests: 0, pass: 0, fail: 0, coverage: null, compileError: false, raw: '', exitCode: null, signal: null, timedOut: false, aborted: false, outputTruncated: false }
    }
    const executor = context.executors.resolve<MavenTestOutcome>('maven', context.capabilities)
    const outcome = await executor.execute({ projectPath: context.projectPath, signal: context.signal, sandbox: context.sandbox })
    const absolute = join(context.projectPath, '.test-agent', 'runs', context.executionId, 'maven-test.log')
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, outcome.raw, 'utf8')
    return { ...outcome, executed: true, required: true, artifact: relative(context.projectPath, absolute) }
  }
}
