import type { AgentEvent } from '../agent/types.js'
import type { TestExecutorRegistry } from '../executors/runtime.js'
import type { RunEventStore } from '../run-events.js'

export interface WorkerPluginContext {
  projectPath: string
  executionId: string
  capabilities: readonly string[]
  executors: TestExecutorRegistry
  events: RunEventStore
  signal: AbortSignal
  emit(event: AgentEvent): void | Promise<void>
}

export interface WorkerPluginPolicy {
  timeoutMs: number
  maxAttempts: number
  retryDelayMs: number
}

export interface WorkerPlugin<Name extends string, Input, Output> {
  readonly name: Name
  readonly policy?: Partial<WorkerPluginPolicy>
  execute(context: WorkerPluginContext, input: Input): Output | Promise<Output>
}

export type PluginExecutionStatus = 'started' | 'succeeded' | 'failed' | 'timed_out' | 'aborted' | 'retrying'

export interface PluginExecutionRecord {
  executionId: string
  plugin: string
  attempt: number
  status: PluginExecutionStatus
  timestamp: string
  durationMs?: number
  error?: { code: string; message: string; retryable: boolean }
}

const DEFAULT_POLICY: WorkerPluginPolicy = { timeoutMs: 60_000, maxAttempts: 1, retryDelayMs: 0 }
type AnyPlugin = WorkerPlugin<string, unknown, unknown>

export class WorkerPluginError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'WorkerPluginError'
  }
}

function resolvePolicy(plugin: AnyPlugin, override?: Partial<WorkerPluginPolicy>): WorkerPluginPolicy {
  const policy = { ...DEFAULT_POLICY, ...plugin.policy, ...override }
  if (!Number.isFinite(policy.timeoutMs) || policy.timeoutMs <= 0) throw new TypeError(`${plugin.name}: timeoutMs must be positive`)
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 3) throw new TypeError(`${plugin.name}: maxAttempts must be 1..3`)
  if (!Number.isFinite(policy.retryDelayMs) || policy.retryDelayMs < 0) throw new TypeError(`${plugin.name}: retryDelayMs must be non-negative`)
  return policy
}

function errorOf(error: unknown): WorkerPluginError {
  if (error instanceof WorkerPluginError) return error
  if (error instanceof Error) return new WorkerPluginError(error.message, 'PLUGIN_EXECUTION_FAILED', false, { cause: error })
  return new WorkerPluginError(String(error), 'PLUGIN_EXECUTION_FAILED')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new WorkerPluginError('Worker plugin aborted during retry delay', 'PLUGIN_ABORTED'))
    }, { once: true })
  })
}

/** Deterministic Worker plugin registry with owned disposal, deadlines, bounded retries and replayable audit events. */
export class WorkerPluginRuntime {
  private readonly plugins = new Map<string, AnyPlugin>()
  private sealed = false
  constructor(private readonly policyOverrides: Readonly<Record<string, Partial<WorkerPluginPolicy>>> = {}) {}

  register<Name extends string, Input, Output>(plugin: WorkerPlugin<Name, Input, Output>): () => void {
    if (this.sealed) throw new Error('Worker plugin registry is sealed')
    if (this.plugins.has(plugin.name)) throw new Error(`Worker plugin already registered: ${plugin.name}`)
    resolvePolicy(plugin as AnyPlugin, this.policyOverrides[plugin.name])
    this.plugins.set(plugin.name, plugin as AnyPlugin)
    return () => { this.plugins.delete(plugin.name) }
  }

  seal(): void {
    this.sealed = true
  }

  auditArtifact(context: WorkerPluginContext): string {
    return context.events.artifact()
  }

  private record(context: WorkerPluginContext, record: Omit<PluginExecutionRecord, 'executionId' | 'timestamp'>): void {
    context.events.append('plugin/execution', record)
  }

  private async notify(context: WorkerPluginContext, event: AgentEvent): Promise<void> {
    try {
      await context.emit(event)
    } catch {
      // Observability must not own or interrupt plugin execution.
    }
  }

  async execute<Name extends string, Input, Output>(name: Name, context: WorkerPluginContext, input: Input): Promise<Output> {
    const plugin = this.plugins.get(name) as WorkerPlugin<Name, Input, Output> | undefined
    if (!plugin) throw new Error(`Unknown worker plugin: ${name}`)
    if (context.signal.aborted) throw new WorkerPluginError(`Worker plugin aborted before start: ${name}`, 'PLUGIN_ABORTED')
    const policy = resolvePolicy(plugin as AnyPlugin, this.policyOverrides[name])

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const startedAt = Date.now()
      const deadline = new AbortController()
      const timeout = setTimeout(() => deadline.abort(new WorkerPluginError(`${name} timed out after ${policy.timeoutMs}ms`, 'PLUGIN_TIMEOUT', true)), policy.timeoutMs)
      const abortFromCaller = (): void => deadline.abort(context.signal.reason)
      context.signal.addEventListener('abort', abortFromCaller, { once: true })
      const scopedContext = { ...context, signal: deadline.signal }
      this.record(context, { plugin: name, attempt, status: 'started' })
      await this.notify(context, { level: 'info', message: `插件开始：${name}（尝试 ${attempt}/${policy.maxAttempts}）` })
      try {
        const result = await plugin.execute(scopedContext, input)
        deadline.signal.throwIfAborted()
        this.record(context, { plugin: name, attempt, status: 'succeeded', durationMs: Date.now() - startedAt })
        await this.notify(context, { level: 'success', message: `插件完成：${name}` })
        return result
      } catch (cause) {
        const error = context.signal.aborted
          ? new WorkerPluginError(`Worker plugin aborted: ${name}`, 'PLUGIN_ABORTED')
          : deadline.signal.aborted
          ? errorOf(deadline.signal.reason)
          : errorOf(cause)
        const status: PluginExecutionStatus = error.code === 'PLUGIN_TIMEOUT' ? 'timed_out' : error.code === 'PLUGIN_ABORTED' ? 'aborted' : 'failed'
        this.record(context, { plugin: name, attempt, status, durationMs: Date.now() - startedAt, error: { code: error.code, message: error.message, retryable: error.retryable } })
        if (error.retryable && attempt < policy.maxAttempts && !context.signal.aborted) {
          this.record(context, { plugin: name, attempt, status: 'retrying', error: { code: error.code, message: error.message, retryable: true } })
          await this.notify(context, { level: 'warning', message: `插件重试：${name}；${error.message}` })
          await sleep(policy.retryDelayMs, context.signal)
          continue
        }
        await this.notify(context, { level: 'error', message: `插件失败：${name}；${error.message}` })
        throw error
      } finally {
        clearTimeout(timeout)
        context.signal.removeEventListener('abort', abortFromCaller)
      }
    }
    throw new WorkerPluginError(`${name} exhausted retry policy`, 'PLUGIN_RETRY_EXHAUSTED')
  }
}
