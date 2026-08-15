import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { platform, release } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { createAgentAdapter } from './agent/factory.js'
import type { AgentEvent, AgentRunResult } from './agent/types.js'
import { createTestExecutorRegistry, parseTestExecutionConfig } from './executors/index.js'
import { buildKnowledgeContext, collectKnowledgeRefs, resolveKnowledgeRoots } from './knowledge.js'
import { createWorkerPluginRuntime, parsePluginPolicyConfig, type VerificationCheck } from './plugins/index.js'
import type { MavenTestInput, MavenTestOutput } from './plugins/maven-test.js'
import type { QualityGateInput, QualityGateOutput } from './plugins/quality-gate.js'
import type { TestPlanInput, TestPlanOutput } from './plugins/test-plan.js'
import { computeMetrics, countAssertionFiles, resolveBundledPlaywrightCli, runApiCases, runNodeUnitTests, runPlaywrightUiTests } from './validator.js'
import type { ApiCaseOutcome } from './validator.js'
import type { TaskInput } from '../../../contracts/src/contracts.js'
import { RunEventStore, type RunEvent } from './run-events.js'
import { authorizeProjectPath, parseAllowedProjectRoots } from './security.js'

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
    void request<{ status: string }>(`/api/worker/tasks/${task.taskId}/status`, undefined, workerHeaders()).then((state) => { if (state.status === 'CANCELLED') controller.abort() }).catch(console.error)
  }, 15_000)
  try {
    await emit(task.taskId, { level: 'info', message: `Worker使用 ${adapter.name} 执行真实测试` })
    await emitStage(task.taskId, 'GENERATING')
    runEvents.append('agent/started', { provider: adapter.name })
    const result = await adapter.run(task.input, (event) => { void emit(task.taskId, event).catch(console.error) }, controller.signal, { knowledge: buildKnowledgeContext(knowledge) })
    runEvents.append('agent/completed', { provider: adapter.name, lanes: result.lanes.length, artifacts: result.artifacts.length })
    const executionCapabilities = task.input.requiredCapabilities && task.input.requiredCapabilities.length > 0
      ? task.input.requiredCapabilities
      : capabilities
    const pluginContext = {
      projectPath: task.input.projectPath,
      executionId: task.taskId,
      capabilities: executionCapabilities,
      executors,
      events: runEvents,
      signal: controller.signal,
      emit: (event: AgentEvent) => emit(task.taskId, event)
    }
    const plan = await pluginRuntime.execute<'test_plan', TestPlanInput, TestPlanOutput>(
      'test_plan',
      pluginContext,
      { cases: result.cases }
    )
    result.artifacts = [...result.artifacts, ...plan.artifacts]
    const auditArtifact = pluginRuntime.auditArtifact(pluginContext)
    if (!result.artifacts.includes(auditArtifact)) result.artifacts.push(auditArtifact)
    await emit(task.taskId, {
      level: plan.degraded ? 'warning' : 'success',
      message: plan.degraded
        ? `测试计划降级：${plan.issues.join('；')}`
        : `测试计划 ${plan.meta.count} 条（按层 ${JSON.stringify(plan.meta.byLayer)}，按价值 ${JSON.stringify(plan.meta.byPriority)}）`
    })

    let apiResult: ApiCaseOutcome | null = null
    if (plan.cases.length > 0) {
      const apiCases = plan.routing
        .filter((item) => item.layer === 'api' && !item.skipped)
        .map((item) => plan.cases.find((caseItem) => caseItem.id === item.caseId))
        .filter((caseItem): caseItem is TestPlanOutput['cases'][number] => Boolean(caseItem))
      if (apiCases.length > 0) {
        const baseUrl = task.input.apiBaseUrl
        apiResult = baseUrl
          ? await runApiCases(apiCases, baseUrl)
          : { ok: true, pass: 0, fail: 0, skipped: apiCases.length, details: apiCases.map((caseItem) => ({ caseId: caseItem.id, status: 'skipped', reason: '未配置 apiBaseUrl' })) }
        await emit(task.taskId, {
          level: apiResult.ok ? 'success' : 'warning',
          message: `API 用例执行：${apiResult.pass} 通过 / ${apiResult.fail} 失败 / ${apiResult.skipped} 跳过`
        })
      }
    }

    const mavenRequired = executionCapabilities.includes('java') && (task.input.testTypes.includes('unit') || task.input.testTypes.includes('regression'))
    const mavenOutcome = await pluginRuntime.execute<'maven_test', MavenTestInput, MavenTestOutput>(
      'maven_test',
      pluginContext,
      { required: mavenRequired }
    )
    if (mavenOutcome.artifact && !result.artifacts.includes(mavenOutcome.artifact)) result.artifacts.push(mavenOutcome.artifact)
    const unitOutcome = task.input.testTypes.includes('unit')
      ? executionCapabilities.includes('java')
        ? mavenOutcome
        : executionCapabilities.includes('node')
          ? runNodeUnitTests(task.input.projectPath)
          : null
      : null
    const uiOutcome = task.input.testTypes.includes('ui') && executionCapabilities.includes('playwright')
      ? runPlaywrightUiTests(task.input.projectPath)
      : null
    const regressionTool = executionCapabilities.includes('java') ? 'java' : executionCapabilities.includes('node') ? 'node' : null
    const regressionOutcome = task.input.testTypes.includes('regression') && regressionTool
      ? (regressionTool === 'java' ? mavenOutcome : (unitOutcome ?? runNodeUnitTests(task.input.projectPath)))
      : null

    await emitStage(task.taskId, 'VALIDATING')
    const uniqueOutcomes = [...new Set([unitOutcome, uiOutcome, regressionOutcome].filter((outcome) => outcome !== null))]
    const baseOutcome = uniqueOutcomes[0] ?? {
      ok: apiResult?.ok ?? true,
      tests: (apiResult?.pass ?? 0) + (apiResult?.fail ?? 0),
      pass: apiResult?.pass ?? 0,
      fail: apiResult?.fail ?? 0,
      coverage: null,
      compileError: false,
      raw: ''
    }
    const assertions = countAssertionFiles(task.input.projectPath)
    const metrics = computeMetrics(baseOutcome, assertions)
    const knowledgeRate = knowledge.degraded ? 0 : Math.min(1, knowledge.refs.length / Math.max(assertions.total, 1))
    const totalFail = uniqueOutcomes.reduce((sum, outcome) => sum + outcome.fail, 0) + (apiResult?.fail ?? 0)
    const totalPass = uniqueOutcomes.reduce((sum, outcome) => sum + outcome.pass, 0) + (apiResult?.pass ?? 0)
    if (result.report.passed !== totalPass || result.report.failed !== totalFail) {
      await emit(task.taskId, {
        level: 'warning',
        message: `独立验证与 Agent 报告不一致（Agent ${result.report.passed}/${result.report.failed}，独立 ${totalPass}/${totalFail}），以独立验证为准`
      })
    }

    const lanes = result.lanes.map((lane) => {
      if (lane.type === 'unit' && unitOutcome) {
        return { ...lane, summary: `${lane.summary}（独立验证 ${unitOutcome.pass} 通过 / ${unitOutcome.fail} 失败，覆盖率 ${unitOutcome.coverage ?? 'N/A'}%）` }
      }
      if (lane.type === 'ui' && uiOutcome) {
        return { ...lane, summary: `${lane.summary}（Playwright 独立验证 ${uiOutcome.pass} 通过 / ${uiOutcome.fail} 失败）` }
      }
      if (lane.type === 'regression' && regressionOutcome) {
        return { ...lane, summary: `${lane.summary}（回归独立验证：全量套件 ${regressionOutcome.pass} 通过 / ${regressionOutcome.fail} 失败）` }
      }
      return lane
    })

    const checks: VerificationCheck[] = [
      {
        name: 'maven_test',
        required: mavenRequired,
        executed: mavenOutcome.executed,
        ok: mavenOutcome.ok,
        tests: mavenOutcome.tests,
        pass: mavenOutcome.pass,
        fail: mavenOutcome.fail,
        compileError: mavenOutcome.compileError,
        exitCode: mavenOutcome.exitCode,
        signal: mavenOutcome.signal,
        timedOut: mavenOutcome.timedOut,
        aborted: mavenOutcome.aborted,
        outputTruncated: mavenOutcome.outputTruncated
      },
      {
        name: 'node_test',
        required: !executionCapabilities.includes('java') && executionCapabilities.includes('node') && (task.input.testTypes.includes('unit') || task.input.testTypes.includes('regression')),
        executed: Boolean((unitOutcome || regressionOutcome) && !executionCapabilities.includes('java')),
        ok: executionCapabilities.includes('java') ? true : (unitOutcome ?? regressionOutcome)?.ok ?? true,
        tests: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.tests ?? 0,
        pass: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.pass ?? 0,
        fail: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.fail ?? 0,
        compileError: executionCapabilities.includes('java') ? false : (unitOutcome ?? regressionOutcome)?.compileError ?? false
      },
      {
        name: 'playwright_test',
        required: task.input.testTypes.includes('ui'),
        executed: uiOutcome !== null,
        ok: uiOutcome?.ok ?? true,
        tests: uiOutcome?.tests ?? 0,
        pass: uiOutcome?.pass ?? 0,
        fail: uiOutcome?.fail ?? 0,
        compileError: uiOutcome?.compileError ?? false
      },
      {
        name: 'api_test',
        required: plan.routing.some((item) => item.layer === 'api'),
        executed: apiResult !== null,
        ok: apiResult?.ok ?? true,
        tests: (apiResult?.pass ?? 0) + (apiResult?.fail ?? 0),
        pass: apiResult?.pass ?? 0,
        fail: apiResult?.fail ?? 0,
        compileError: false
      }
    ]
    const coverage = unitOutcome?.coverage ?? null
    const gate = await pluginRuntime.execute<'quality_gate', QualityGateInput, QualityGateOutput>(
      'quality_gate',
      pluginContext,
      { plan, checks, coverageTarget: task.input.coverageTarget ?? 60, coverage, metrics }
    )
    runEvents.append('quality-gate/decided', { passed: gate.passed, reasons: gate.reasons, checks: gate.checks })
    const report = {
      ...result.report,
      passed: totalPass,
      failed: totalFail,
      coverage,
      metrics: { ...metrics, knowledgeRate },
      gate,
      knowledge: knowledgeMeta,
      lanes,
      cases: plan.meta,
      routing: plan.routing,
      api: apiResult
    }
    await emitStage(task.taskId, 'ANALYZING')
    await emit(task.taskId, {
      level: gate.passed ? 'success' : 'warning',
      message: `质量门禁：${gate.reason}；四率=编译${Math.round(metrics.compileRate * 100)}% 执行${Math.round(metrics.execRate * 100)}% 断言${Math.round(metrics.assertRate * 100)}% 有效${Math.round(metrics.effectiveRate * 100)}%`
    })
    runEvents.append('run/result-ready', { gatePassed: gate.passed, passed: totalPass, failed: totalFail })
    await eventUpload
    if (eventUploadFailure !== undefined) throw new Error('中央运行事件上送失败', { cause: eventUploadFailure })
    await uploadArtifacts(task, result)
    await request(`/api/worker/tasks/${task.taskId}/complete`, { method: 'POST', body: JSON.stringify({ result: { ...result, report, lanes, gate } }) }, workerHeaders())
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
