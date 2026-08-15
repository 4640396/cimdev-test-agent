import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createAgentAdapter } from '../agent/factory.js'
import type { AgentAdapter } from '../agent/types.js'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { createTestExecutorRegistry, parseTestExecutionConfig, type TestExecutionConfig } from '../executors/index.js'
import { createWorkerPluginRuntime } from '../plugins/index.js'
import type { WorkerPluginPolicy } from '../plugins/runtime.js'
import { RunEventStore } from '../run-events.js'
import { authorizeProjectPath, parseAllowedProjectRoots } from '../security.js'
import { runTestKernel } from '../test-kernel.js'
import { EXECUTION_ID_PATTERN, LOCAL_HOST_PROTOCOL_VERSION, type ClientMessage, type HostMessage } from '../../../../contracts/src/local-host-protocol.js'

export const LOCAL_HOST_VERSION = '0.1.0'

export interface LocalAgentHostOptions {
  capabilities: readonly string[]
  allowedProjectRoots: readonly string[]
  pluginPolicyOverrides?: Record<string, Partial<WorkerPluginPolicy>>
  testExecutionConfig?: TestExecutionConfig
  createProvider?: () => AgentAdapter | null
}

interface ActiveRun {
  controller: AbortController
  provider: AgentAdapter
  resolvedPath: string
}

type Send = (message: HostMessage) => void | Promise<void>

/** Local endpoint execution host. It owns the TestKernel, not a shared queue. */
export class LocalAgentHost {
  private readonly active = new Map<string, ActiveRun>()
  private readonly protocolVersion = LOCAL_HOST_PROTOCOL_VERSION

  constructor(private readonly options: LocalAgentHostOptions) {}

  async handle(message: ClientMessage, send: Send): Promise<void> {
    switch (message.kind) {
      case 'handshake': {
        if (message.protocolVersion !== this.protocolVersion) {
          await send({
            id: message.id,
            kind: 'handshake',
            ok: false,
            protocolVersion: this.protocolVersion,
            error: `protocol version mismatch: ${message.protocolVersion}`
          })
          return
        }
        await send({
          id: message.id,
          kind: 'handshake',
          ok: true,
          protocolVersion: this.protocolVersion,
          hostVersion: LOCAL_HOST_VERSION,
          capabilities: [...this.options.capabilities]
        })
        return
      }
      case 'health': {
        await send({ id: message.id, kind: 'health', ok: true, activeRuns: this.active.size })
        return
      }
      case 'run': {
        if (!EXECUTION_ID_PATTERN.test(message.executionId)) {
          await send({ id: message.id, kind: 'error', message: `invalid executionId: ${message.executionId}` })
          return
        }
        if (this.active.has(message.executionId)) {
          await send({ id: message.id, kind: 'error', message: `execution already active: ${message.executionId}` })
          return
        }
        const authorization = authorizeProjectPath(message.input.projectPath, this.options.allowedProjectRoots)
        if (!authorization.ok || !authorization.resolvedPath) {
          await send({ id: message.id, kind: 'error', message: authorization.reason ?? 'Project path authorization failed' })
          return
        }
        const provider = this.options.createProvider ? this.options.createProvider() : createAgentAdapter(message.input.projectPath)
        if (!provider) {
          await send({ id: message.id, kind: 'error', message: 'No executable Agent Provider is configured' })
          return
        }
        const controller = new AbortController()
        this.active.set(message.executionId, { controller, provider, resolvedPath: authorization.resolvedPath })
        await send({ id: message.id, kind: 'run-accepted', executionId: message.executionId })
        void this.runSession(message, send, controller)
        return
      }
      case 'cancel': {
        const run = this.active.get(message.executionId)
        if (!run) {
          await send({ id: message.id, kind: 'error', message: `unknown execution: ${message.executionId}` })
          return
        }
        run.controller.abort()
        await send({ id: message.id, kind: 'cancelled', executionId: message.executionId })
        return
      }
      default: {
        const unknown = message as unknown as { id?: string }
        await send({ id: unknown.id ?? '', kind: 'error', message: 'unknown message kind' })
      }
    }
  }

  private async runSession(message: Extract<ClientMessage, { kind: 'run' }>, send: Send, controller: AbortController): Promise<void> {
    const active = this.active.get(message.executionId)
    if (!active) return
    const runEvents = new RunEventStore(message.input.projectPath, message.executionId)
    const dshRoot = join(message.input.projectPath, '.test-agent', 'dsh-sessions')
    const dshContext = new Context()
    await dshContext.plugin(SessionStore)
    await dshContext.plugin(JsonlSessionPersistence, { root: dshRoot, compression: 'none' })
    await dshContext.plugin(Storage)
    const storageBackend = new JsonStorageBackend(join(message.input.projectPath, '.test-agent', 'dsh-storage'))
    dshContext.storage.backend.register('json', storageBackend)
    const facility = new DomainFacility(dshContext, { backend: 'json', routes: {} })
    dshContext.storage.mount('domain', facility)
    dshContext.provide('storageDomain', facility)
    await dshContext.plugin(WorkspaceRegistry)
    const workspace = await dshContext.workspaceRegistry.create(message.input.projectPath)
    const dshSession = dshContext.sessions.create(SessionId(message.executionId), { meta: { cwd: message.input.projectPath } })
    await workspace.attachSession(SessionId(message.executionId))
    runEvents.subscribe((event) => {
      try { dshSession.append(event.type, event.data) } catch (error) { console.error('DSH session append failed', error) }
    })
    runEvents.subscribe((event) => {
      void Promise.resolve(send({ id: message.id, kind: 'run-event', executionId: message.executionId, event })).catch(console.error)
    })
    runEvents.append('run/started', { executionTarget: 'endpoint', workspaceId: active.resolvedPath })
    const pluginRuntime = createWorkerPluginRuntime(this.options.pluginPolicyOverrides)
    const executors = createTestExecutorRegistry(this.options.testExecutionConfig ?? parseTestExecutionConfig())
    try {
      const outcome = await runTestKernel({
        executionId: message.executionId,
        projectPath: message.input.projectPath,
        input: message.input,
        capabilities: this.options.capabilities,
        provider: active.provider,
        pluginRuntime,
        executors,
        runEvents,
        signal: controller.signal,
        emit: async (event) => { await send({ id: message.id, kind: 'event', executionId: message.executionId, event }) }
      })
      await dshContext.sessions.flush(dshSession)
      await send({ id: message.id, kind: 'run-result', executionId: message.executionId, outcome })
    } catch (error) {
      runEvents.append('run/ended', { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) })
      try { await dshContext.sessions.flush(dshSession) } catch (flushError) { console.error('DSH session flush failed', flushError) }
      await send({
        id: message.id,
        kind: 'run-error',
        executionId: message.executionId,
        error: error instanceof Error ? error.message : String(error),
        cancelled: controller.signal.aborted
      })
    } finally {
      this.active.delete(message.executionId)
      try { await dshContext.fiber.dispose() } catch (error) { console.error('DSH context dispose failed', error) }
    }
  }
}

export function runStdioHost(options: LocalAgentHostOptions): void {
  const host = new LocalAgentHost(options)
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  const write = (message: HostMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
  lines.on('line', (line) => {
    if (line.trim() === '') return
    void (async () => {
      let message: ClientMessage
      try {
        message = JSON.parse(line) as ClientMessage
      } catch {
        write({ id: '', kind: 'error', message: 'invalid JSON' })
        return
      }
      await host.handle(message, write)
    })().catch((error) => {
      write({ id: '', kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  })
}

export function parseLocalHostOptions(env: NodeJS.ProcessEnv = process.env): LocalAgentHostOptions {
  const capabilities = (env.TEST_AGENT_HOST_CAPABILITIES ?? 'windows,node,codex-cli,go,java,vue,playwright').split(',').map((value) => value.trim()).filter(Boolean)
  return {
    capabilities,
    allowedProjectRoots: parseAllowedProjectRoots(env.TEST_AGENT_ALLOWED_PROJECT_ROOTS)
  }
}

export function canonicalWorkspacePath(projectPath: string): string {
  return realpathSync(projectPath)
}
