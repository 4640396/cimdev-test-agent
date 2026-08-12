import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createAgentAdapter } from './agent/factory.js'
import type { AgentEvent, AgentRunResult } from './agent/types.js'
import { buildKnowledgeContext, collectKnowledgeRefs, resolveKnowledgeRoots } from './knowledge.js'
import { computeMetrics, countAssertionFiles, runMavenUnitTests, runNodeUnitTests } from './validator.js'
import type { TaskInput } from '../../../contracts/src/contracts.js'

interface ClaimedTask { taskId: string; input: TaskInput }

const server = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const dataDirectory = resolve(process.env.TEST_AGENT_WORKER_DATA_DIR ?? join(process.cwd(), '.test-agent-worker'))
const capabilities = (process.env.TEST_AGENT_WORKER_CAPABILITIES ?? 'windows,node,codex-cli,go,java,vue,playwright').split(',').map((value) => value.trim()).filter(Boolean)
mkdirSync(dataDirectory, { recursive: true })
const idPath = join(dataDirectory, 'worker-id.txt')
const workerId = existsSync(idPath) ? readFileSync(idPath, 'utf8').trim() : randomUUID()
if (!existsSync(idPath)) writeFileSync(idPath, workerId, 'utf8')
const secretPath = join(dataDirectory, 'worker-secret.txt')
let workerSecret = existsSync(secretPath) ? readFileSync(secretPath, 'utf8').trim() : ''
const workerName = process.env.TEST_AGENT_WORKER_NAME ?? `${process.env.COMPUTERNAME ?? 'worker'}-${workerId.slice(0, 8)}`
let stopping = false

const TOOL_CHECKS: Record<string, { command: string; args: string[] }> = {
  node: { command: 'node', args: ['--version'] },
  java: { command: 'java', args: ['-version'] },
  go: { command: 'go', args: ['version'] },
  codex: { command: process.platform === 'win32' ? 'codex.cmd' : 'codex', args: ['--version'] }
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
  try {
    if (!statSync(input.projectPath).isDirectory()) issues.push(`项目路径不是目录：${input.projectPath}`)
  } catch {
    issues.push(`项目路径不存在：${input.projectPath}`)
  }
  for (const capability of input.requiredCapabilities ?? []) {
    const check = TOOL_CHECKS[capability]
    if (!check) continue
    const version = toolVersion(check.command, check.args)
    if (version) details.push(`${capability} ${version}`)
    else issues.push(`缺少工具链：${capability}`)
  }
  const summary = [`os=${platform()} ${release()}`, `node=${process.version}`, `provider=${provider}`, `worker=${workerName}`, ...details].join(' | ')
  return { ok: issues.length === 0, issues, summary }
}

function workerHeaders(): Record<string, string> {
  return { 'x-worker-id': workerId, 'x-worker-secret': workerSecret }
}

async function request<T>(path: string, init?: RequestInit, extraHeaders?: Record<string, string>): Promise<T> {
  const token = process.env.TEST_AGENT_API_TOKEN
  const response = await fetch(`${server}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extraHeaders ?? {}), ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return text ? JSON.parse(text) as T : undefined as T
}

async function register(): Promise<void> {
  const response = await request<{ secret?: string }>('/api/workers/register', { method: 'POST', body: JSON.stringify({ id: workerId, name: workerName, capabilities }) })
  if (response.secret) {
    workerSecret = response.secret
    writeFileSync(secretPath, workerSecret, 'utf8')
  }
  console.log(`Worker ${workerName} registered at ${server}`)
}

async function emit(taskId: string, event: AgentEvent): Promise<void> {
  await request(`/api/worker/tasks/${taskId}/events`, { method: 'POST', body: JSON.stringify(event) }, workerHeaders())
}

async function emitStage(taskId: string, stage: string): Promise<void> {
  await emit(taskId, { level: 'info', message: `进入阶段：${stage}`, stage })
}

async function uploadArtifacts(task: ClaimedTask, result: AgentRunResult): Promise<void> {
  for (const artifact of result.artifacts) {
    const absolute = resolve(task.input.projectPath, artifact)
    const root = resolve(task.input.projectPath)
    if (!absolute.startsWith(`${root}\\`) || !existsSync(absolute)) continue
    const form = new FormData()
    form.append('file', new Blob([readFileSync(absolute)]), basename(absolute))
    const token = process.env.TEST_AGENT_API_TOKEN
    const response = await fetch(`${server}/api/worker/tasks/${task.taskId}/artifacts`, { method: 'POST', body: form, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...workerHeaders() } })
    if (!response.ok) throw new Error(`Artifact upload failed: ${response.status} ${await response.text()}`)
  }
}

async function runTask(task: ClaimedTask): Promise<void> {
  const adapter = createAgentAdapter()
  if (!adapter) throw new Error('No executable Agent Provider is configured')
  const preflight = preflightEnvironment(task.input, adapter.name)
  if (!preflight.ok) {
    const message = `环境预检未通过：${preflight.issues.join('；')}`
    await emit(task.taskId, { level: 'error', message })
    throw new Error(message)
  }
  await emit(task.taskId, { level: 'info', message: `环境预检通过：${preflight.summary}` })
  await emitStage(task.taskId, 'PLANNING')
  const knowledge = collectKnowledgeRefs(resolveKnowledgeRoots(task.input, task.input.projectPath), task.input.systemName)
  const knowledgeMeta = {
    refs: knowledge.refs.map((ref) => ({ source: ref.source, version: ref.version, type: ref.type })),
    degraded: knowledge.degraded,
    reason: knowledge.reason
  }
  await emit(task.taskId, {
    level: knowledge.degraded ? 'warning' : 'success',
    message: knowledge.degraded
      ? `知识库降级：${knowledge.reason}`
      : `知识库命中 ${knowledge.refs.length} 条：${knowledge.refs.map((ref) => ref.source).join(', ')}`
  })
  const controller = new AbortController()
  const heartbeat = setInterval(() => {
    void request(`/api/worker/tasks/${task.taskId}/heartbeat?workerId=${encodeURIComponent(workerId)}`, { method: 'POST' }, workerHeaders()).catch(console.error)
    void request<{ status: string }>(`/api/tasks/${task.taskId}`).then((state) => { if (state.status === 'CANCELLED') controller.abort() }).catch(console.error)
  }, 15_000)
  try {
    await emit(task.taskId, { level: 'info', message: `Worker使用 ${adapter.name} 执行真实测试` })
    await emitStage(task.taskId, 'GENERATING')
    const result = await adapter.run(task.input, (event) => { void emit(task.taskId, event).catch(console.error) }, controller.signal, { knowledge: buildKnowledgeContext(knowledge) })
    const capabilities = task.input.requiredCapabilities ?? []
    const unitOutcome = task.input.testTypes.includes('unit')
      ? capabilities.includes('java')
        ? runMavenUnitTests(task.input.projectPath)
        : capabilities.includes('node')
          ? runNodeUnitTests(task.input.projectPath)
          : null
      : null
    if (unitOutcome) {
      await emitStage(task.taskId, 'VALIDATING')
      const outcome = unitOutcome
      const assertions = countAssertionFiles(task.input.projectPath)
      const metrics = computeMetrics(outcome, assertions)
      const knowledgeRate = knowledge.degraded ? 0 : Math.min(1, knowledge.refs.length / Math.max(assertions.total, 1))
      if (outcome.fail > 0 || outcome.compileError) {
        throw new Error(`独立验证未通过：${outcome.fail} 个测试失败${outcome.compileError ? '，存在编译错误' : ''}`)
      }
      if (result.report.passed !== outcome.pass || result.report.failed !== outcome.fail) {
        await emit(task.taskId, {
          level: 'warning',
          message: `独立验证与 Agent 报告不一致（Agent ${result.report.passed}/${result.report.failed}，独立 ${outcome.pass}/${outcome.fail}），以独立验证为准`
        })
      }
      const lanes = result.lanes.map((lane) => lane.type === 'unit'
        ? { ...lane, summary: `${lane.summary}（独立验证 ${outcome.pass} 通过 / ${outcome.fail} 失败，覆盖率 ${outcome.coverage ?? 'N/A'}%）` }
        : lane)
      const coverageTarget = task.input.coverageTarget ?? 60
      const coveragePassed = outcome.coverage === null
        ? true
        : outcome.coverage >= coverageTarget
      const gate = {
        coverageTarget,
        coverage: outcome.coverage,
        effectiveRate: metrics.effectiveRate,
        passed: coveragePassed,
        reason: outcome.coverage === null
          ? '未取得覆盖率数据，覆盖率门禁跳过（需配置覆盖率工具）'
          : coveragePassed
            ? '覆盖率达标'
            : `覆盖率 ${outcome.coverage}% 未达到目标 ${coverageTarget}%`
      }
      const report = {
        ...result.report,
        passed: outcome.pass,
        failed: outcome.fail,
        coverage: outcome.coverage,
        metrics: { ...metrics, knowledgeRate },
        gate,
        knowledge: knowledgeMeta
      }
      await emitStage(task.taskId, 'ANALYZING')
      await emit(task.taskId, {
        level: coveragePassed ? 'success' : 'warning',
        message: `覆盖率门禁：${gate.reason}；四率=编译${Math.round(metrics.compileRate * 100)}% 执行${Math.round(metrics.execRate * 100)}% 断言${Math.round(metrics.assertRate * 100)}% 有效${Math.round(metrics.effectiveRate * 100)}%`
      })
      await uploadArtifacts(task, result)
      await request(`/api/worker/tasks/${task.taskId}/complete`, { method: 'POST', body: JSON.stringify({ result: { ...result, report, lanes, gate } }) }, workerHeaders())
    } else {
      const report = { ...result.report, knowledge: knowledgeMeta }
      await uploadArtifacts(task, result)
      await request(`/api/worker/tasks/${task.taskId}/complete`, { method: 'POST', body: JSON.stringify({ result: { ...result, report } }) }, workerHeaders())
    }
  } catch (error) {
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
