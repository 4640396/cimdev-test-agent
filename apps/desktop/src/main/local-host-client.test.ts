import { describe, expect, it } from 'vitest'
import type { TaskInput } from '../../../../contracts/src/contracts.js'
import type { HostMessage } from '../../../../contracts/src/local-host-protocol.js'
import { LocalHostClient, type LocalHostIO } from './local-host-client.js'

class FakeIO implements LocalHostIO {
  readonly writes: string[] = []
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()

  write(line: string): void {
    this.writes.push(line)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener)
    return () => { this.lineListeners.delete(listener) }
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  push(message: HostMessage): void {
    for (const listener of this.lineListeners) listener(JSON.stringify(message))
  }
}

describe('LocalHostClient', () => {
  it('correlates a handshake response by request id', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const promise = client.handshake()
    const request = JSON.parse(io.writes[0]) as { id: string; kind: string }

    io.push({ id: request.id, kind: 'handshake', ok: true, protocolVersion: 1, hostVersion: '0.1.0' })

    await expect(promise).resolves.toMatchObject({ id: request.id, kind: 'handshake', ok: true })
  })

  it('streams run messages and resolves only on the terminal run message', async () => {
    const io = new FakeIO()
    const client = new LocalHostClient(io)
    const received: HostMessage[] = []
    client.onMessage((message) => received.push(message))
    const input: TaskInput = { projectPath: 'C:/tmp/project', systemName: 'demo', version: '1', testTypes: [] }
    const promise = client.run(input, 'exec-1')
    const request = JSON.parse(io.writes[0]) as { id: string }

    io.push({ id: request.id, kind: 'run-accepted', executionId: 'exec-1' })
    io.push({ id: request.id, kind: 'event', executionId: 'exec-1', event: { level: 'info', message: 'running' } })

    let resolved = false
    void promise.then(() => { resolved = true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    expect(resolved).toBe(false)

    io.push({ id: request.id, kind: 'run-result', executionId: 'exec-1', outcome: { ok: true } })
    await expect(promise).resolves.toMatchObject({ kind: 'run-result', executionId: 'exec-1' })
    expect(received.map((message) => message.kind)).toEqual(['run-accepted', 'event', 'run-result'])
  })
})
