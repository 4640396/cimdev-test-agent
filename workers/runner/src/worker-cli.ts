import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { createAgentAdapter } from './agent/factory.js'
import type { AgentEvent, AgentRunResult } from './agent/types.js'
import { createTestExecutorRegistry, parseTestExecutionConfig } from './executors/index.js'
import { createWorkerPluginRuntime, parsePluginPolicyConfig } from './plugins/index.js'
import { resolveBundledPlaywrightCli } from './validator.js'
import type { TaskInput } from '../../../contracts/src/contracts.js'
import { RunEventStore, type RunEvent } from './run-events.js'
import { authorizeProjectPath, parseAllowedProjectRoots } from './security.js'
import { runTestKernel } from './test-kernel.js'

interface ClaimedTask { taskId: string; input: TaskInput }

const server = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const workerApiToken = process.env.TEST_AGENT_WORKER_API_TOKEN ?? process.env.TEST_AGENT_API_TOKEN
const dataDirectory = resolve(process.env.TEST_AGENT_WORKER_DATA_DIR ?? join(process.cwd(), '.test-agent-worker'))
const capabilities = (process.env.TEST_AGENT_WORKER_CAPABILITIES ?? 'windows,node,codex-cli,go,java,vue,playwright').split(',').map((value) => value.trim()).filter(Boolean)
const allowedProjectRoots = parseAllowedProjectRoots(process.env.TEST_AGENT_ALLOWED_PROJECT_ROOTS)
const pluginPolicyOverrides = parsePluginPolicyConfig(process.env.TEST_AGENT_PLUGIN_POLICY_JSON)
createWorkerPluginRuntime(pluginPolicyOverrides)
const testExecutionConfig = parseTestExecutionConfig()
createTestExecutorRegistry(testExecutionConfig)
if (testExecutionConfig.mode === 'docker' && !capabilities.includes('docker')) throw new Error('Docker execution mode requires docker Worker capability')
mkdirSync(dataDirectory, { recursive: true })
const idPath = join(dataDirectory, 'worker-id.txt')
const workerId = existsSync(idPath) ? readFileSync(idPath, 'utf8').trim() : randomUUID()
if (!existsSync(idPath)) writeFileSync(idPath, workerId, 'utf8')
const secretPath = join(dataDirectory, 'worker-secret.txt')
let workerSecret = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : ''
if (existsSync(secretPath)) chmodSync(secretPath, 0o600)
const workerName = process.env.TEST_AGENT_WORKER_NAME ?? `${process.env.COMPUTERNAME ?? 'worker'}-${workerId.slice(0, 8)}`
let stopping = false

const TOOL_CHECKS: Record<string, { command: string; args: string[] }> = {
  node: { command: 'node', args: ['--version'] },
  java: { command: 'java', args: ['-version'] },
  go: { command: 'go', args: ['version'] },
  codex: { command: process.platform === 'win32' ? 'codex.cmd' : 'codex', args: ['--version'] },
  playwright: { command: 'node', args: [resolveBundledPlaywrightCli(), '--version'] },
  docker: { command: 'docker', args: ['version'] }
}

function toolVersion(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    if (result.status !== 0) return null
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    return text.split(/\r?\n/)[0].trim() || null
  } catch {
    return null
  }
}

interface PreflightResult {
  ok: boolean
  issues: string[]
  summary: string
}

function preflightEnvironment(input: TaskInput, provider: string): PreflightResult {
  const issues: string[] = []
  const details: string[] = []
  const authorization = authorizeProjectPath(input.projectPath, allowedProjectRoots)
  if (!authorization.ok) issues.push(authorization.reason ?? 'Project path authorization failed')
  else if (!statSync(authorization.resolvedPath!).isDirectory()) issues.push(`项目路径不是目录：${input.projectPath}`)
  for (const capability of input.requiredCapabilities ?? []) {
    if (capability === 'java' && testExecutionConfig.mode === 'docker') continue
    const check = TOOL_CHECKS[capability]
    if (!check) continue
    const version = toolVersion(check.command, check.args)
    if (version) details.push(`${capability} ${version}`)
    else issues.push(`缺少工具链：${capability}`)
  }
  if (testExecutionConfig.mode === 'docker') {
    const version = toolVersion(TOOL_CHECKS.docker.command, TOOL_CHECKS.docker.args)
    if (version) details.push(`docker ${version}`)
    else issues.push('Docker execution mode requires a reachable Docker Engine')
  }
  const summary = [`os=${platform()} ${release()}`, `node=${process.version}`, `provider=${provider}`, `worker=${workerName}`, ...details].join(' | ')
  return { ok: issues.length === 0, issues, summary }
}

function workerHeaders(): Record<string, string> {
  return { 'x-worker-id': workerId, 'x-worker-secret': workerSecret }
}

async function request<T>(path: string, init?: RequestInit, extraHeaders?: Record<string, string>): Promise<T> {
  const response = await fetch(`${server}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(workerApiToken ? { authorization: `Bearer ${workerApiToken}` } : {}), ...(extraHeaders ?? {}), ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return text ? JSON.parse(text) as T : undefined as T
}

async function register(): Promise<void> {
  const response = await request<{ secret?: string }>('/api/workers/register', { method: 'POST', body: JSON.stringify({ id: workerId, name: workerName, capabilities }) }, workerSecret ? workerHeaders() : undefined)
  if (response.secret) {
    workerSecret = response.secret
    writeFileSync(secretPath, workerSecret, { encoding: 'utf8', mode: 0o600 })
    chmodSync(secretPath, 0o600)
  }
  console.log(`Worker ${workerName} registered at ${server}`)
}

async function emit(taskId: string, event: AgentEvent): Promise<void> {
  await request(`/api/worker/tasks/${taskId}/events`, { method: 'POST', body: JSON.stringify(event) }, workerHeaders())
}

async function emitStage(taskId: string, stage: string): Promise<void> {
  await emit(taskId, { level: 'info', message: `进入阶段：${stage}`, stage })
}

async function uploadRunEvent(taskId: string, event: RunEvent): Promise<void> {
  await request(`/api/worker/tasks/${taskId}/run-events`, { method: 'POST', body: JSON.stringify(event) }, workerHeaders())
}

async function uploadArtifacts(task: ClaimedTask, result: AgentRunResult): Promise<void> {
  for (const artifact of result.artifacts) {
    const absolute = resolve(task.input.projectPath, artifact)
    const root = resolve(task.input.projectPath)
    const withinRoot = relative(root, absolute)
    if (withinRoot.startsWith('..') || isAbsolute(withinRoot) || !existsSync(absolute)) continue
    const form = new FormData()
    form.append('file', new Blob([readFileSync(absolute)]), basename(absolute))
    const response = await fetch(`${server}/api/worker/tasks/${task.taskId}/artifacts`, { method: 'POST', body: form, headers: { ...(workerApiToken ? { authorization: `Bearer ${workerApiToken}` } : {}), ...workerHeaders() } })
    if (!response.ok) throw new Error(`Artifact upload failed: ${response.status} ${await response.text()}`)
  }
}

async function runTask(task: ClaimedTask): Promise<void> {
  const adapter = createAgentAdapter()
  const pluginRuntime = createWorkerPluginRuntime(pluginPolicyOverrides)
  const executors = createTestExecutorRegistry(testExecutionConfig)
  const runEvents = new RunEventStore(task.input.projectPath, task.taskId)
  let eventUpload = Promise.resolve()
  let eventUploadFailure: unknown
  runEvents.subscribe((event) => {
    eventUpload = eventUpload.then(async () => {
      if (eventUploadFailure !== undefined) return
      try { await uploadRunEvent(task.taskId, event) } catch (error) { eventUploadFailure = error }
    })
  })
  runEvents.append('run/started', { workerId, requestedTestTypes: task.input.testTypes })
  if (!adapter) throw new Error('No executable Agent Provider is configured')
  const preflight = preflightEnvironment(task.input, adapter.name)
  if (!preflight.ok) {
    const message = `环境预检未通过：${preflight.issues.join('；')}`
    await emit(task.taskId, { level: 'error', message })
    throw new Error(message)
  }
  await emit(task.taskId, { level: 'info', message: `环境预检通过：${preflight.summary}` })
  await emitStage(task.taskId, 'PLANNING')
  const controller = new AbortController()
  const heartbeat = setInterval(() => {
    void request(`/api/worker/tasks/${task.taskId}/heartbeat?workerId=${encodeURIComponent(workerId)}`, { method: 'POST' }, workerHeaders()).catch(console.error)
    void request<{ status: string }>(`/api/worker/tasks/${task.taskId}/status`, undefined, workerHeaders()).then((state) => { if (state.status === 'CANCELLED') controller.abort() }).catch(console.error)
  }, 15_000)
  try {
    const outcome = await runTestKernel({
      executionId: task.taskId,
      projectPath: task.input.projectPath,
      input: task.input,
      capabilities,
      provider: adapter,
      pluginRuntime,
      executors,
      runEvents,
      signal: controller.signal,
      emit: (event) => emit(task.taskId, event)
    })
    await eventUpload
    if (eventUploadFailure !== undefined) throw new Error('中央运行事件上送失败', { cause: eventUploadFailure })
    await uploadArtifacts(task, outcome.adapterResult)
    await request(`/api/worker/tasks/${task.taskId}/complete`, { method: 'POST', body: JSON.stringify({ result: { ...outcome.adapterResult, report: outcome.report, lanes: outcome.lanes, gate: outcome.gate } }) }, workerHeaders())
  } catch (error) {
    runEvents.append('run/ended', { status: controller.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) })
    await eventUpload
    if (!controller.signal.aborted) {
      await request(`/api/worker/tasks/${task.taskId}/fail`, { method: 'POST', body: JSON.stringify({ error: error instanceof Error ? error.message : 'Worker execution failed' }) }, workerHeaders())
    }
  } finally {
    clearInterval(heartbeat)
  }
}

async function loop(): Promise<void> {
  await register()
  while (!stopping) {
    try {
      const task = await request<ClaimedTask | undefined>('/api/worker/tasks/claim', { method: 'POST', body: JSON.stringify({ workerId, capabilities }) }, workerHeaders())
      if (task) await runTask(task)
      else await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
    } catch (error) {
      console.error(error)
      await new Promise((resolveWait) => setTimeout(resolveWait, 5000))
    }
  }
}

process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })
await loop()
