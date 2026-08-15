import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { LOCAL_HOST_PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../../../../contracts/src/local-host-protocol.js'
import type { TaskInput } from '../../../../contracts/src/contracts.js'

export interface LocalHostIO {
  write(line: string): void
  close(): void
  onLine(listener: (line: string) => void): () => void
  onClose(listener: () => void): () => void
}

interface PendingRequest {
  predicate: (message: HostMessage) => boolean
  resolve: (message: HostMessage) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Minimal client for the local Host Sidecar over a newline-delimited JSON stream. */
export class LocalHostClient {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private sequence = 0

  constructor(private readonly io: LocalHostIO) {
    io.onLine((line) => this.handleLine(line))
    io.onClose(() => this.failAll(new Error('Local host closed')))
  }

  nextId(): string {
    this.sequence += 1
    return `r${this.sequence}-${randomUUID().slice(0, 8)}`
  }

  close(): void {
    this.io.close()
  }

  onMessage(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  handshake(): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'handshake', protocolVersion: LOCAL_HOST_PROTOCOL_VERSION },
      (message) => message.kind === 'handshake'
    )
  }

  health(): Promise<HostMessage> {
    return this.request({ id: this.nextId(), kind: 'health' }, (message) => message.kind === 'health')
  }

  cancel(executionId: string): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'cancel', executionId },
      (message) => message.kind === 'cancelled' || message.kind === 'error'
    )
  }

  run(input: TaskInput, executionId: string): Promise<HostMessage> {
    return this.request(
      { id: this.nextId(), kind: 'run', executionId, input },
      (message) => (message.kind === 'run-result' || message.kind === 'run-error') && message.executionId === executionId,
      3_600_000
    )
  }

  private request(message: ClientMessage, predicate: (message: HostMessage) => boolean, timeoutMs = 10_000): Promise<HostMessage> {
    return new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error(`${message.kind} request timed out`))
      }, timeoutMs)
      this.pending.set(message.id, { predicate, resolve, reject, timer })
      this.io.write(JSON.stringify(message))
    })
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    let message: HostMessage
    try {
      message = JSON.parse(line) as HostMessage
    } catch {
      return
    }
    for (const listener of this.listeners) {
      try { listener(message) } catch { /* A faulty observer must not break the transport. */ }
    }
    const pending = this.pending.get(message.id)
    if (pending && pending.predicate(message)) {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.resolve(message)
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export function createStdioHostIO(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): LocalHostIO {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as ChildProcessByStdio<Writable, Readable, Readable>
  let buffer = ''
  const lineListeners = new Set<(line: string) => void>()
  const closeListeners = new Set<() => void>()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') {
        for (const listener of lineListeners) listener(line)
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { process.stderr.write(chunk) })
  child.on('error', () => { for (const listener of closeListeners) listener() })
  child.on('close', () => { for (const listener of closeListeners) listener() })

  return {
    write: (line) => { child.stdin.write(`${line}\n`) },
    close: () => { child.kill() },
    onLine: (listener) => {
      lineListeners.add(listener)
      return () => { lineListeners.delete(listener) }
    },
    onClose: (listener) => {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    }
  }
}
