import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createAgentAdapter } from './agent/factory.js'
import type { AgentEvent, AgentRunResult } from './agent/types.js'
import type { TaskInput } from '../shared/contracts.js'

interface ClaimedTask { taskId: string; input: TaskInput }

const server = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const dataDirectory = resolve(process.env.TEST_AGENT_WORKER_DATA_DIR ?? join(process.cwd(), '.test-agent-worker'))
const capabilities = (process.env.TEST_AGENT_WORKER_CAPABILITIES ?? 'windows,node,codex-cli,go,java,vue,playwright').split(',').map((value) => value.trim()).filter(Boolean)
mkdirSync(dataDirectory, { recursive: true })
const idPath = join(dataDirectory, 'worker-id.txt')
const workerId = existsSync(idPath) ? readFileSync(idPath, 'utf8').trim() : randomUUID()
if (!existsSync(idPath)) writeFileSync(idPath, workerId, 'utf8')
const workerName = process.env.TEST_AGENT_WORKER_NAME ?? `${process.env.COMPUTERNAME ?? 'worker'}-${workerId.slice(0, 8)}`
let stopping = false

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.TEST_AGENT_API_TOKEN
  const response = await fetch(`${server}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return text ? JSON.parse(text) as T : undefined as T
}

async function register(): Promise<void> {
  await request('/api/workers/register', { method: 'POST', body: JSON.stringify({ id: workerId, name: workerName, capabilities }) })
  console.log(`Worker ${workerName} registered at ${server}`)
}

async function emit(taskId: string, event: AgentEvent): Promise<void> {
  await request(`/api/worker/tasks/${taskId}/events`, { method: 'POST', body: JSON.stringify(event) })
}

async function uploadArtifacts(task: ClaimedTask, result: AgentRunResult): Promise<void> {
  for (const artifact of result.artifacts) {
    const absolute = resolve(task.input.projectPath, artifact)
    const root = resolve(task.input.projectPath)
    if (!absolute.startsWith(`${root}\\`) || !existsSync(absolute)) continue
    const form = new FormData()
    form.append('file', new Blob([readFileSync(absolute)]), basename(absolute))
    const token = process.env.TEST_AGENT_API_TOKEN
    const response = await fetch(`${server}/api/worker/tasks/${task.taskId}/artifacts`, { method: 'POST', body: form, headers: token ? { authorization: `Bearer ${token}` } : {} })
    if (!response.ok) throw new Error(`Artifact upload failed: ${response.status} ${await response.text()}`)
  }
}

async function runTask(task: ClaimedTask): Promise<void> {
  const adapter = createAgentAdapter()
  if (!adapter) throw new Error('No executable Agent Provider is configured')
  const controller = new AbortController()
  const heartbeat = setInterval(() => {
    void request(`/api/worker/tasks/${task.taskId}/heartbeat?workerId=${encodeURIComponent(workerId)}`, { method: 'POST' }).catch(console.error)
    void request<{ status: string }>(`/api/tasks/${task.taskId}`).then((state) => { if (state.status === 'CANCELLED') controller.abort() }).catch(console.error)
  }, 15_000)
  try {
    await emit(task.taskId, { level: 'info', message: `Worker使用 ${adapter.name} 执行真实测试` })
    const result = await adapter.run(task.input, (event) => { void emit(task.taskId, event).catch(console.error) }, controller.signal)
    await uploadArtifacts(task, result)
    await request(`/api/worker/tasks/${task.taskId}/complete`, { method: 'POST', body: JSON.stringify({ result }) })
  } catch (error) {
    if (!controller.signal.aborted) {
      await request(`/api/worker/tasks/${task.taskId}/fail`, { method: 'POST', body: JSON.stringify({ error: error instanceof Error ? error.message : 'Worker execution failed' }) })
    }
  } finally {
    clearInterval(heartbeat)
  }
}

async function loop(): Promise<void> {
  await register()
  while (!stopping) {
    try {
      const task = await request<ClaimedTask | undefined>('/api/worker/tasks/claim', { method: 'POST', body: JSON.stringify({ workerId, capabilities }) })
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
