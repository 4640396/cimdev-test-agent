import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentEvent, AgentRunResult } from './agent/types.js'
import type { TaskInput } from '../../../contracts/src/contracts.js'
import { createTestExecutorRegistry, parseTestExecutionConfig } from './executors/index.js'
import { createWorkerPluginRuntime } from './plugins/index.js'
import { RunEventStore } from './run-events.js'
import { runTestKernel } from './test-kernel.js'

class CountedAdapter implements AgentAdapter {
  readonly name = 'counted'
  calls = 0

  async run(_input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    this.calls += 1
    emit({ level: 'info', message: `counted run #${this.calls}` })
    return {
      lanes: [],
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases: []
    }
  }
}

describe('runTestWorkflow fix loop', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    }
    dirs.length = 0
  })

  it('re-runs the agent when the quality gate keeps failing', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'test-workflow-'))
    dirs.push(projectPath)
    const adapter = new CountedAdapter()
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: ['unit'], coverageTarget: 0 }
    const runEvents = new RunEventStore(projectPath, 'exec-loop')
    const pluginRuntime = createWorkerPluginRuntime()
    const executors = createTestExecutorRegistry(parseTestExecutionConfig({ TEST_AGENT_EXECUTION_MODE: 'local' }))

    const outcome = await runTestKernel({
      executionId: 'exec-loop',
      projectPath,
      input,
      capabilities: ['node'],
      provider: adapter,
      pluginRuntime,
      executors,
      runEvents,
      signal: new AbortController().signal,
      emit: () => {}
    })

    expect(adapter.calls).toBeGreaterThan(1)
    expect(outcome.gate.passed).toBe(false)
    expect(outcome.report.failedCases).toBeDefined()
  })
})
