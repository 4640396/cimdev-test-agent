import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../agent/types.js'
import type { TaskInput } from '../../../../contracts/src/contracts.js'
import { LocalAgentHost } from './host.js'
import { LOCAL_HOST_PROTOCOL_VERSION, type HostMessage } from '../../../../contracts/src/local-host-protocol.js'

class FakeAdapter implements AgentAdapter {
  readonly name = 'fake'

  async run(_input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    emit({ level: 'info', message: 'fake local run' })
    return {
      lanes: [{ type: 'unit', status: 'passed', summary: 'local run passed' }],
      report: { passed: 0, failed: 0, coverage: null },
      artifacts: [],
      cases: []
    }
  }
}

async function waitForMessage(messages: HostMessage[], kind: HostMessage['kind'], timeoutMs = 5000): Promise<HostMessage> {
  const start = Date.now()
  return await new Promise<HostMessage>((resolve, reject) => {
    const check = (): void => {
      const found = messages.find((message) => message.kind === kind)
      if (found) {
        resolve(found)
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${kind}`))
        return
      }
      setTimeout(check, 10)
    }
    check()
  })
}

describe('LocalAgentHost', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
    }
    dirs.length = 0
  })

  it('handshakes, runs an endpoint task and streams local events', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-'))
    dirs.push(projectPath)
    const allowedRoots = [realpathSync(projectPath)]
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: allowedRoots,
      createProvider: () => new FakeAdapter()
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }

    await host.handle({ id: 'h1', kind: 'handshake', protocolVersion: LOCAL_HOST_PROTOCOL_VERSION }, send)
    await host.handle({ id: 'h2', kind: 'health' }, send)
    const input: TaskInput = { projectPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }
    await host.handle({ id: 'r1', kind: 'run', executionId: 'exec-1', input }, send)

    const result = await waitForMessage(messages, 'run-result')
    expect(messages.some((message) => message.kind === 'run-accepted')).toBe(true)
    expect(messages.some((message) => message.kind === 'run-event')).toBe(true)
    expect(messages.some((message) => message.kind === 'event')).toBe(true)
    expect(result).toMatchObject({ id: 'r1', kind: 'run-result', executionId: 'exec-1' })
  })

  it('rejects unknown projects and duplicated executions', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'local-host-'))
    const otherPath = mkdtempSync(join(tmpdir(), 'local-host-other-'))
    dirs.push(projectPath, otherPath)
    const host = new LocalAgentHost({
      capabilities: ['node'],
      allowedProjectRoots: [realpathSync(projectPath)],
      createProvider: () => new FakeAdapter()
    })
    const messages: HostMessage[] = []
    const send = (message: HostMessage): void => { messages.push(message) }
    const input: TaskInput = { projectPath: otherPath, systemName: 'demo', version: '1', testTypes: [], coverageTarget: 0 }

    await host.handle({ id: 'r2', kind: 'run', executionId: 'exec-2', input }, send)
    await host.handle({ id: 'r3', kind: 'run', executionId: 'exec-2', input }, send)

    expect(messages.filter((message) => message.kind === 'error')).toHaveLength(2)
  })
})
