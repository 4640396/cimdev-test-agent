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

class FakeAdapter implements AgentAdapter {
  readonly name = 'fake'

  async run(_input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    emit({ level: 'info', message: 'fake adapter running' })
    return {
      lanes: [{ type: 'unit', status: 'passed', summary: '1/1' }],
      report: { passed: 1, failed: 0, coverage: null },
      artifacts: [],
      cases: []
    }
  }
}

describe('runTestKernel', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    }
    dirs.length = 0
  })

  it('produces a complete, transport-agnostic outcome with replayable run events', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'test-kernel-'))
    dirs.push(projectPath)
    const executionId = 'exec-1'
    const runEvents = new RunEventStore(projectPath, executionId)
    const emitted: AgentEvent[] = []
    const pluginRuntime = createWorkerPluginRuntime()
    const executors = createTestExecutorRegistry(parseTestExecutionConfig({ TEST_AGENT_EXECUTION_MODE: 'local' }))
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }

    const outcome = await runTestKernel({
      executionId,
      projectPath,
      input,
      capabilities: ['node'],
      provider: new FakeAdapter(),
      pluginRuntime,
      executors,
      runEvents,
      signal: new AbortController().signal,
      emit: (event) => { emitted.push(event) }
    })

    expect(outcome.report.passed).toBe(0)
    expect(outcome.report.failed).toBe(0)
    expect(outcome.gate).toBeDefined()
    expect(outcome.adapterResult.artifacts).toContain(runEvents.artifact())
    expect(emitted.some((event) => event.stage === 'GENERATING')).toBe(true)
    expect(emitted.some((event) => event.stage === 'VALIDATING')).toBe(true)
    expect(emitted.some((event) => event.stage === 'ANALYZING')).toBe(true)

    const types = runEvents.replay().map((event) => event.type)
    expect(types).toContain('agent/started')
    expect(types).toContain('agent/completed')
    expect(types).toContain('quality-gate/decided')
    expect(types).toContain('run/result-ready')
  })
})
