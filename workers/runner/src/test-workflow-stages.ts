import type { AgentEvent, AgentFeedback, AgentRunResult } from './agent/types.js'
import { buildKnowledgeContext, collectKnowledgeRefs, resolveKnowledgeRoots } from './knowledge.js'
import type { VerificationCheck } from './plugins/index.js'
import type { MavenTestInput, MavenTestOutput } from './plugins/maven-test.js'
import type { QualityGateInput, QualityGateOutput } from './plugins/quality-gate.js'
import type { TestPlanInput, TestPlanOutput } from './plugins/test-plan.js'
import type { WorkerPluginContext } from './plugins/runtime.js'
import { computeMetrics, countAssertionFiles, loadOpenApiCases, runApiCases, runNodeUnitTests, runPlaywrightUiTests } from './validator.js'
import type { ApiCaseOutcome, NodeTestOutcome } from './validator.js'
import type { TimelineRecord } from '../../../contracts/src/contracts.js'
import type { TestKernelKnowledgeMeta, TestKernelReport, TestKernelSessionContext } from './test-kernel.js'

type Outcome = MavenTestOutput | NodeTestOutcome

export interface GeneratingStageResult {
  adapterResult: AgentRunResult
  plan: TestPlanOutput
  knowledge: ReturnType<typeof collectKnowledgeRefs>
  knowledgeMeta: TestKernelKnowledgeMeta
  executionCapabilities: readonly string[]
  pluginContext: WorkerPluginContext
}

export interface ValidatingStageResult {
  apiResult: ApiCaseOutcome | null
  mavenOutcome: MavenTestOutput
  unitOutcome: Outcome | null
  uiOutcome: NodeTestOutcome | null
  regressionOutcome: Outcome | null
  uniqueOutcomes: Outcome[]
  baseOutcome: Outcome
  assertions: ReturnType<typeof countAssertionFiles>
  metrics: ReturnType<typeof computeMetrics>
  knowledgeRate: number
  totalPass: number
  totalFail: number
  lanes: AgentRunResult['lanes']
  checks: VerificationCheck[]
}

export interface AnalyzingStageResult {
  report: TestKernelReport
  gate: QualityGateOutput
  lanes: AgentRunResult['lanes']
}

export async function runGeneratingStage(context: TestKernelSessionContext, emit: (event: AgentEvent) => void | Promise<void>, feedback?: AgentFeedback): Promise<GeneratingStageResult> {
  const { input, projectPath, capabilities, provider, pluginRuntime, executors, runEvents, signal } = context
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
  runEvents.append('agent/started', { provider: provider.name })
  const adapterResult = await provider.run(
    input,
    (event) => { void Promise.resolve(emit(event)).catch(console.error) },
    signal,
    { knowledge: buildKnowledgeContext(knowledge), feedback }
  )
  runEvents.append('agent/completed', { provider: provider.name, lanes: adapterResult.lanes.length, artifacts: adapterResult.artifacts.length })
  const executionCapabilities = input.requiredCapabilities && input.requiredCapabilities.length > 0
    ? input.requiredCapabilities
    : capabilities
  const pluginContext: WorkerPluginContext = {
    projectPath,
    executionId: context.executionId,
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
  return { adapterResult, plan, knowledge, knowledgeMeta, executionCapabilities, pluginContext }
}

export async function runValidatingStage(
  context: TestKernelSessionContext,
  generated: GeneratingStageResult,
  emit: (event: AgentEvent) => void | Promise<void>
): Promise<ValidatingStageResult> {
  const { input, projectPath } = context
  const { adapterResult, plan, knowledge, executionCapabilities, pluginContext } = generated
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
  const mavenOutcome = await context.pluginRuntime.execute<'maven_test', MavenTestInput, MavenTestOutput>(
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
      required: input.testTypes.includes('api') || plan.routing.some((item) => item.layer === 'api'),
      executed: apiResult !== null,
      ok: apiResult?.ok ?? true,
      tests: (apiResult?.pass ?? 0) + (apiResult?.fail ?? 0),
      pass: apiResult?.pass ?? 0,
      fail: apiResult?.fail ?? 0,
      compileError: false
    }
  ]
  return {
    apiResult,
    mavenOutcome,
    unitOutcome,
    uiOutcome,
    regressionOutcome,
    uniqueOutcomes,
    baseOutcome,
    assertions,
    metrics,
    knowledgeRate,
    totalPass,
    totalFail,
    lanes,
    checks
  }
}

export async function runAnalyzingStage(
  context: TestKernelSessionContext,
  generated: GeneratingStageResult,
  validated: ValidatingStageResult,
  startedAt: number,
  timeline: TimelineRecord[]
): Promise<AnalyzingStageResult> {
  const { input } = context
  const { adapterResult, plan, knowledgeMeta, pluginContext } = generated
  const { unitOutcome, uiOutcome, totalPass, totalFail, metrics, knowledgeRate, lanes, checks, apiResult } = validated
  const coverage = unitOutcome?.coverage ?? null
  const gate = await context.pluginRuntime.execute<'quality_gate', QualityGateInput, QualityGateOutput>(
    'quality_gate',
    pluginContext,
    { plan, checks, coverageTarget: input.coverageTarget ?? 60, coverage, metrics }
  )
  context.runEvents.append('quality-gate/decided', { passed: gate.passed, reasons: gate.reasons, checks: gate.checks })
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
  return { report, gate, lanes }
}
