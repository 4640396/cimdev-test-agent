import type { AgentAdapter, AgentEvent, AgentRunResult } from './agent/types.js'
import { buildKnowledgeContext, collectKnowledgeRefs, resolveKnowledgeRoots } from './knowledge.js'
import type { TestExecutorRegistry } from './executors/runtime.js'
import type { VerificationCheck } from './plugins/index.js'
import type { WorkerPluginRuntime } from './plugins/runtime.js'
import type { MavenTestInput, MavenTestOutput } from './plugins/maven-test.js'
import type { QualityGateInput, QualityGateOutput } from './plugins/quality-gate.js'
import type { TestPlanInput, TestPlanOutput } from './plugins/test-plan.js'
import { computeMetrics, countAssertionFiles, loadOpenApiCases, runApiCases, runNodeUnitTests, runPlaywrightUiTests } from './validator.js'
import type { ApiCaseOutcome, NodeTestOutcome } from './validator.js'
import type { TaskInput, TimelineRecord, UiRecording, UiStepRecord } from '../../../contracts/src/contracts.js'
import type { RunEventStore } from './run-events.js'

export interface TestKernelKnowledgeMeta {
  refs: Array<{ source: string; version: string | null; type: string }>
  degraded: boolean
  reason?: string
}

export interface TestKernelReport {
  passed: number
  failed: number
  coverage: number | null
  durationMs: number
  summary: string
  screenshots?: string[]
  branchCoverage?: number | null
  failedCases?: Array<{ name: string; layer: string; error: string; suggestion?: string }>
  uiSteps?: UiStepRecord[]
  timeline?: TimelineRecord[]
  recording?: UiRecording
  riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
  fixes?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; title: string; summary: string; beforeCode?: string; afterCode?: string }>
  metrics: {
    compileRate: number
    execRate: number
    assertRate: number
    effectiveRate: number
    knowledgeRate: number
  }
  gate: QualityGateOutput
  knowledge: TestKernelKnowledgeMeta
  lanes: AgentRunResult['lanes']
  cases: TestPlanOutput['meta']
  routing: TestPlanOutput['routing']
  api: ApiCaseOutcome | null
}

export interface TestKernelOutcome {
  adapterResult: AgentRunResult
  report: TestKernelReport
  lanes: AgentRunResult['lanes']
  gate: QualityGateOutput
}

export interface TestKernelSessionContext {
  executionId: string
  projectPath: string
  input: TaskInput
  capabilities: readonly string[]
  provider: AgentAdapter
  pluginRuntime: WorkerPluginRuntime
  executors: TestExecutorRegistry
  runEvents: RunEventStore
  sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }
  signal: AbortSignal
  emit(event: AgentEvent): void | Promise<void>
}

type Outcome = MavenTestOutput | NodeTestOutcome

/** Transport-agnostic execution kernel shared by Endpoint Host and Shared Worker. */
export async function runTestKernel(context: TestKernelSessionContext): Promise<TestKernelOutcome> {
  const { executionId, projectPath, input, capabilities, provider, pluginRuntime, executors, runEvents, signal, emit } = context
  const startedAt = Date.now()

  const timeline: TimelineRecord[] = []
  const startTimelineStage = (stage: string, message: string): void => {
    timeline.push({ stage, status: 'running', startedAt: new Date().toISOString(), message })
  }
  const finishTimelineStage = (stage: string, status: 'passed' | 'failed' = 'passed', message?: string): void => {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index]
      if (item.stage === stage && item.status === 'running') {
        item.status = status
        item.durationMs = Date.now() - new Date(item.startedAt).getTime()
        if (message !== undefined) item.message = message
        return
      }
    }
  }

  const stageLabels: Record<string, string> = {
    GENERATING: '生成测试',
    VALIDATING: '独立验证',
    ANALYZING: '质量门禁与分析'
  }
  const emitStage = async (stage: string): Promise<void> => {
    const label = stageLabels[stage] ?? stage
    startTimelineStage(label, `进入阶段：${stage}`)
    await emit({ level: 'info', message: `进入阶段：${stage}`, stage })
  }

  const knowledge = collectKnowledgeRefs(resolveKnowledgeRoots(input, projectPath), input.systemName)
  const knowledgeMeta: TestKernelKnowledgeMeta = {
    refs: knowledge.refs.map((ref) => ({ source: ref.source, version: ref.version, type: ref.type })),
    degraded: knowledge.degraded,
    reason: knowledge.reason
  }
  await emit({
    level: knowledge.degraded ? 'warning' : 'success',
    message: knowledge.degraded
      ? `知识库降级：${knowledge.reason}`
      : `知识库命中 ${knowledge.refs.length} 条：${knowledge.refs.map((ref) => ref.source).join(', ')}`
  })

  await emit({ level: 'info', message: `Worker使用 ${provider.name} 执行真实测试` })
  await emitStage('GENERATING')
  runEvents.append('agent/started', { provider: provider.name })
  const adapterResult = await provider.run(
    input,
    (event) => { void Promise.resolve(emit(event)).catch(console.error) },
    signal,
    { knowledge: buildKnowledgeContext(knowledge) }
  )
  runEvents.append('agent/completed', { provider: provider.name, lanes: adapterResult.lanes.length, artifacts: adapterResult.artifacts.length })

  const executionCapabilities = input.requiredCapabilities && input.requiredCapabilities.length > 0
    ? input.requiredCapabilities
    : capabilities
  const pluginContext = {
    projectPath,
    executionId,
    capabilities: executionCapabilities,
    executors,
    events: runEvents,
    sandbox: context.sandbox,
    signal,
    emit
  }
  const plan = await pluginRuntime.execute<'test_plan', TestPlanInput, TestPlanOutput>(
    'test_plan',
    pluginContext,
    { cases: adapterResult.cases }
  )
  adapterResult.artifacts = [...adapterResult.artifacts, ...plan.artifacts]
  const auditArtifact = pluginRuntime.auditArtifact(pluginContext)
  if (!adapterResult.artifacts.includes(auditArtifact)) adapterResult.artifacts.push(auditArtifact)
  await emit({
    level: plan.degraded ? 'warning' : 'success',
    message: plan.degraded
      ? `测试计划降级：${plan.issues.join('；')}`
      : `测试计划 ${plan.meta.count} 条（按层 ${JSON.stringify(plan.meta.byLayer)}，按价值 ${JSON.stringify(plan.meta.byPriority)}）`
  })

  let apiResult: ApiCaseOutcome | null = null
  {
    let apiCases = plan.routing
      .filter((item) => item.layer === 'api' && !item.skipped)
      .map((item) => plan.cases.find((caseItem) => caseItem.id === item.caseId))
      .filter((caseItem): caseItem is TestPlanOutput['cases'][number] => Boolean(caseItem))
    if (input.testTypes.includes('api') && apiCases.length === 0 && input.openApiUrl) {
      try {
        apiCases = await loadOpenApiCases(input.openApiUrl) as unknown as TestPlanOutput['cases']
        await emit({ level: 'info', message: `从 OpenAPI 文档提取 ${apiCases.length} 个接口用例` })
      } catch (error) {
        await emit({ level: 'warning', message: `OpenAPI 文档解析失败：${error instanceof Error ? error.message : String(error)}` })
      }
    }
    if (apiCases.length > 0) {
      const baseUrl = input.apiBaseUrl
      const outcome: ApiCaseOutcome = baseUrl
        ? await runApiCases(apiCases, baseUrl, input.apiHeaders ?? {})
        : { ok: true, pass: 0, fail: 0, skipped: apiCases.length, details: apiCases.map((caseItem) => ({ caseId: caseItem.id, method: 'GET', path: '', status: 'skipped', reason: '未配置 apiBaseUrl' })) }
      apiResult = outcome
      await emit({
        level: outcome.ok ? 'success' : 'warning',
        message: `API 用例执行：${outcome.pass} 通过 / ${outcome.fail} 失败 / ${outcome.skipped} 跳过`
      })
    }
  }

  const mavenRequired = executionCapabilities.includes('java') && (input.testTypes.includes('unit') || input.testTypes.includes('regression'))
  const mavenOutcome = await pluginRuntime.execute<'maven_test', MavenTestInput, MavenTestOutput>(
    'maven_test',
    pluginContext,
    { required: mavenRequired }
  )
  if (mavenOutcome.artifact && !adapterResult.artifacts.includes(mavenOutcome.artifact)) adapterResult.artifacts.push(mavenOutcome.artifact)
  const unitOutcome = input.testTypes.includes('unit')
    ? executionCapabilities.includes('java')
      ? mavenOutcome
      : executionCapabilities.includes('node')
        ? runNodeUnitTests(projectPath, context.sandbox)
        : null
    : null
  const uiOutcome = input.testTypes.includes('ui') && executionCapabilities.includes('playwright')
    ? runPlaywrightUiTests(projectPath, { entryUrl: input.uiEntryUrl, env: input.environment }, context.sandbox)
    : null
  const regressionTool = executionCapabilities.includes('java') ? 'java' : executionCapabilities.includes('node') ? 'node' : null
  const regressionOutcome = input.testTypes.includes('regression') && regressionTool
    ? (regressionTool === 'java' ? mavenOutcome : (unitOutcome ?? runNodeUnitTests(projectPath, context.sandbox)))
    : null

  finishTimelineStage('生成测试', 'passed', `测试计划 ${plan.meta.count} 条`)
  await emitStage('VALIDATING')
  const uniqueOutcomes = [...new Set([unitOutcome, uiOutcome, regressionOutcome].filter((outcome): outcome is Outcome => outcome !== null))]
  const baseOutcome = uniqueOutcomes[0] ?? {
    ok: apiResult?.ok ?? true,
    tests: (apiResult?.pass ?? 0) + (apiResult?.fail ?? 0),
    pass: apiResult?.pass ?? 0,
    fail: apiResult?.fail ?? 0,
    coverage: null,
    compileError: false,
    raw: ''
  }
  const assertions = countAssertionFiles(projectPath)
  const metrics = computeMetrics(baseOutcome, assertions)
  const knowledgeRate = knowledge.degraded ? 0 : Math.min(1, knowledge.refs.length / Math.max(assertions.total, 1))
  const totalFail = uniqueOutcomes.reduce((sum, outcome) => sum + outcome.fail, 0) + (apiResult?.fail ?? 0)
  const totalPass = uniqueOutcomes.reduce((sum, outcome) => sum + outcome.pass, 0) + (apiResult?.pass ?? 0)
  if (adapterResult.report.passed !== totalPass || adapterResult.report.failed !== totalFail) {
    await emit({
      level: 'warning',
      message: `独立验证与 Agent 报告不一致（Agent ${adapterResult.report.passed}/${adapterResult.report.failed}，独立 ${totalPass}/${totalFail}），以独立验证为准`
    })
  }

  const lanes = adapterResult.lanes.map((lane) => {
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
      required: !executionCapabilities.includes('java') && executionCapabilities.includes('node') && (input.testTypes.includes('unit') || input.testTypes.includes('regression')),
      executed: Boolean((unitOutcome || regressionOutcome) && !executionCapabilities.includes('java')),
      ok: executionCapabilities.includes('java') ? true : (unitOutcome ?? regressionOutcome)?.ok ?? true,
      tests: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.tests ?? 0,
      pass: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.pass ?? 0,
      fail: executionCapabilities.includes('java') ? 0 : (unitOutcome ?? regressionOutcome)?.fail ?? 0,
      compileError: executionCapabilities.includes('java') ? false : (unitOutcome ?? regressionOutcome)?.compileError ?? false
    },
    {
      name: 'playwright_test',
      required: input.testTypes.includes('ui'),
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
    { plan, checks, coverageTarget: input.coverageTarget ?? 60, coverage, metrics }
  )
  runEvents.append('quality-gate/decided', { passed: gate.passed, reasons: gate.reasons, checks: gate.checks })
  const aiRiskPoints = Array.isArray(adapterResult.riskPoints)
    ? adapterResult.riskPoints
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          severity: (item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium') as 'high' | 'medium' | 'low',
          file: String(item.file ?? ''),
          message: String(item.message ?? ''),
          ...(typeof item.suggestion === 'string' ? { suggestion: item.suggestion } : {})
        }))
    : []
  const aiFixes = Array.isArray(adapterResult.fixes)
    ? adapterResult.fixes
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          severity: (item.severity === 'high' || item.severity === 'medium' || item.severity === 'low' ? item.severity : 'medium') as 'high' | 'medium' | 'low',
          file: String(item.file ?? ''),
          title: String(item.title ?? ''),
          summary: String(item.summary ?? ''),
          ...(typeof item.beforeCode === 'string' ? { beforeCode: item.beforeCode } : {}),
          ...(typeof item.afterCode === 'string' ? { afterCode: item.afterCode } : {})
        }))
    : []
  const unitFailedCases = unitOutcome && 'failedCases' in unitOutcome
    ? (unitOutcome.failedCases ?? []).map((item) => ({ name: item.name, layer: item.layer, error: item.error }))
    : []
  const uiFailedCases = (uiOutcome && 'uiSteps' in uiOutcome ? (uiOutcome.uiSteps ?? []) : [])
    .filter((step) => step.status === 'failed')
    .map((step) => ({
      name: step.name,
      layer: 'ui',
      error: step.error ?? 'UI 步骤失败',
      suggestion: step.screenshot ? '失败截图已捕获' : undefined,
      screenshot: step.screenshot
    }))
  const report: TestKernelReport = {
    ...adapterResult.report,
    passed: totalPass,
    failed: totalFail,
    coverage,
    durationMs: Date.now() - startedAt,
    summary: gate.passed
      ? `质量门禁通过：${totalPass} 通过 / ${totalFail} 失败，覆盖率 ${coverage === null ? 'N/A' : `${coverage}%`}`
      : `质量门禁未通过：${gate.reason}`,
    screenshots: uiOutcome?.screenshots ?? [],
    branchCoverage: unitOutcome && 'branchCoverage' in unitOutcome ? unitOutcome.branchCoverage : null,
    failedCases: [...unitFailedCases, ...uiFailedCases],
    uiSteps: uiOutcome && 'uiSteps' in uiOutcome ? (uiOutcome.uiSteps ?? []) : [],
    timeline,
    recording: uiOutcome && 'recording' in uiOutcome ? uiOutcome.recording : undefined,
    riskPoints: aiRiskPoints.length > 0 ? aiRiskPoints : (unitOutcome && 'riskPoints' in unitOutcome ? unitOutcome.riskPoints : []),
    fixes: aiFixes,
    metrics: { ...metrics, knowledgeRate },
    gate,
    knowledge: knowledgeMeta,
    lanes,
    cases: plan.meta,
    routing: plan.routing,
    api: apiResult
  }
  finishTimelineStage('独立验证', 'passed', `通过 ${totalPass} / 失败 ${totalFail}`)
  await emitStage('ANALYZING')
  await emit({
    level: gate.passed ? 'success' : 'warning',
    message: `质量门禁：${gate.reason}；四率=编译${Math.round(metrics.compileRate * 100)}% 执行${Math.round(metrics.execRate * 100)}% 断言${Math.round(metrics.assertRate * 100)}% 有效${Math.round(metrics.effectiveRate * 100)}%`
  })
  finishTimelineStage('质量门禁与分析', 'passed', gate.reason)
  runEvents.append('run/result-ready', { gatePassed: gate.passed, passed: totalPass, failed: totalFail })

  return { adapterResult, report, lanes, gate }
}
