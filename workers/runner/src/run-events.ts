import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

export const RUN_EVENT_SCHEMA_VERSION = 1

export interface RunEvent<T = unknown> {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION
  executionId: string
  sequence: number
  timestamp: string
  type: string
  data: T
}

export type RunEventListener = (event: RunEvent) => void

/** Append-only task fact log used for audit, replay and later report projection. */
export class RunEventStore {
  private sequence = 0
  private readonly listeners = new Set<RunEventListener>()
  readonly path: string

  constructor(readonly projectPath: string, readonly executionId: string) {
    if (executionId.trim() === '' || /[\\/]/.test(executionId)) throw new TypeError('executionId must be a non-empty opaque id')
    this.path = join(projectPath, '.test-agent', 'runs', executionId, 'events.jsonl')
    const prior = this.replay()
    this.sequence = prior.at(-1)?.sequence ?? 0
  }

  artifact(): string {
    return relative(this.projectPath, this.path)
  }

  append<T>(type: string, data: T): RunEvent<T> {
    if (type.trim() === '') throw new TypeError('run event type must be non-empty')
    const event: RunEvent<T> = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      executionId: this.executionId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      data
    }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' })
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* A faulty observer cannot break the run log owner. */ }
    }
    return event
  }

  replay(): RunEvent[] {
    if (!existsSync(this.path)) return []
    const events = readFileSync(this.path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
      const parsed = JSON.parse(line) as Partial<RunEvent>
      if (parsed.schemaVersion !== RUN_EVENT_SCHEMA_VERSION) throw new Error(`unsupported run event schema at line ${index + 1}`)
      if (parsed.executionId !== this.executionId) throw new Error(`execution id mismatch at line ${index + 1}`)
      if (parsed.sequence !== index + 1) throw new Error(`non-monotonic run event sequence at line ${index + 1}`)
      if (typeof parsed.type !== 'string' || typeof parsed.timestamp !== 'string') throw new Error(`invalid run event at line ${index + 1}`)
      return parsed as RunEvent
    })
    return events
  }

  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
