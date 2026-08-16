<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { FailedCaseRecord, HistoryRecord, LocalHostStatus, RoutingRecord, RuntimeStatus, TaskInput, TaskSnapshot, TestCaseRecord, TestType } from '../../../../../contracts/src/contracts'
import type { HostMessage, RunResultMessage } from '../../../../../contracts/src/local-host-protocol'
import { emptyLanes, laneLabels, progressOf } from './task-state'

type View = 'home' | 'plan' | 'run' | 'report' | 'history' | 'settings'

const form = reactive<TaskInput>({ projectPath: '', systemName: '', version: '', testTypes: ['unit'], coverageTarget: 80 })
const snapshot = ref<TaskSnapshot | null>(null)
const error = ref('')
const starting = ref(false)
const runtime = ref<RuntimeStatus>({ mode: 'unavailable', provider: null, message: '正在读取本机 Host 状态…' })
const knowledgeRoots = ref<string[]>([])
const localStatus = ref<LocalHostStatus>({ running: false })
const localLogs = ref<TaskSnapshot['logs']>([])
const localTaskId = ref('')
const history = ref<HistoryRecord[]>([])
const view = ref<View>('home')

let detectTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeRoots: (() => void) | undefined
let unsubscribeLocal: (() => void) | undefined
let unsubscribeMenuNav: (() => void) | undefined
let unsubscribeMenuCommand: (() => void) | undefined

const lanes = computed(() => snapshot.value?.lanes ?? emptyLanes(form.testTypes))
const progress = computed(() => progressOf(snapshot.value))
const taskActive = computed(() => snapshot.value?.status === 'queued' || snapshot.value?.status === 'planning' || snapshot.value?.status === 'running')
const canStart = computed(() => Boolean(localStatus.value.running && form.projectPath && form.systemName && form.testTypes.length && !starting.value && !taskActive.value))
const report = computed(() => snapshot.value?.report)
const durationText = computed(() => report.value?.durationMs !== undefined ? `${Math.round(report.value.durationMs / 1000)}s` : '--')
const effectivePercent = computed(() => Math.round((report.value?.metrics?.effectiveRate ?? 0) * 100))
const qualityScore = computed(() => {
  const coverage = report.value?.coverage
  const coverageScore = coverage === null || coverage === undefined ? 0 : coverage
  return Math.round((coverageScore + effectivePercent.value) / 2)
})
const overview = computed(() => report.value ?? history.value[0]?.snapshot.report)
const overviewQuality = computed(() => {
  const item = overview.value
  if (!item) return '--'
  const coverage = item.coverage === null || item.coverage === undefined ? 0 : item.coverage
  const effective = Math.round((item.metrics?.effectiveRate ?? 0) * 100)
  return Math.round((coverage + effective) / 2)
})
const artifactItems = computed(() => (snapshot.value?.artifacts ?? []).map((artifact) => {
  const normalized = artifact.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return { name: parts[parts.length - 1] ?? artifact, path: normalized }
}))
const prComment = computed(() => {
  const r = report.value
  if (!r) return ''
  const coverage = r.coverage === null || r.coverage === undefined ? 'N/A' : `${r.coverage}%`
  const branch = r.branchCoverage === null || r.branchCoverage === undefined ? '' : `，分支覆盖率 ${r.branchCoverage}%`
  const lines = [
    '## CIMDEV 测试结果',
    `- 通过 ${r.passed} / 失败 ${r.failed}，覆盖率 ${coverage}${branch}`,
    `- 质量门禁：${r.gate?.passed ? '通过' : '未通过'}`,
    r.summary ? `- 结论：${r.summary}` : ''
  ].filter(Boolean)
  if (r.riskPoints?.length) {
    lines.push('- 风险点：')
    for (const risk of r.riskPoints) {
      lines.push(`  - [${risk.severity}] ${risk.file}：${risk.message}${risk.suggestion ? ` 建议：${risk.suggestion}` : ''}`)
    }
  } else {
    lines.push('- 风险点：无')
  }
  return lines.join('\n')
})

async function selectProject(): Promise<void> {
  error.value = ''
  try {
    const selection = await window.testAgent.selectProject()
    if (!selection) return
    form.projectPath = selection.path
    form.systemName = selection.detectedSystem
    form.version = selection.detectedVersion
    if (selection.detectedTestTypes?.length) form.testTypes = [...selection.detectedTestTypes]
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '目录选择失败'
  }
}

async function detectProject(path: string): Promise<void> {
  if (!path.trim()) return
  error.value = ''
  try {
    const selection = await window.testAgent.detectProject(path)
    if (!selection) return
    form.systemName = selection.detectedSystem
    form.version = selection.detectedVersion
    if (selection.detectedTestTypes?.length) form.testTypes = [...selection.detectedTestTypes]
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '目录识别失败'
  }
}

watch(() => form.projectPath, (path) => {
  if (detectTimer) clearTimeout(detectTimer)
  detectTimer = setTimeout(() => { void detectProject(path) }, 350)
})

function go(next: View): void {
  view.value = next
}

function pushLocalLog(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  localLogs.value.push({ id: `${Date.now()}-${localLogs.value.length}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message })
  if (localLogs.value.length > 300) localLogs.value.splice(0, localLogs.value.length - 300)
}

interface LocalRunOutcome {
  adapterResult?: { artifacts?: string[]; cases?: unknown[] }
  report?: {
    passed?: number
    failed?: number
    coverage?: number | null
    branchCoverage?: number | null
    durationMs?: number
    summary?: string
    cases?: { count: number; byLayer: Record<string, number>; byPriority: Record<string, number> }
    routing?: RoutingRecord[]
    failedCases?: FailedCaseRecord[]
    riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
    screenshots?: string[]
    metrics?: NonNullable<TaskSnapshot['report']>['metrics']
    gate?: { passed?: boolean; coverageTarget?: number; coverage?: number | null; effectiveRate?: number; reason?: string }
    knowledge?: NonNullable<TaskSnapshot['report']>['knowledge']
  }
  lanes?: Array<{ type: TestType; status: 'passed' | 'failed'; summary: string }>
}

function mapCases(value: unknown[]): TestCaseRecord[] {
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const priority = (item.priority === 'low' || item.priority === 'medium' || item.priority === 'high' ? item.priority : 'medium') as 'low' | 'medium' | 'high'
      const layer = (item.layer === 'api' || item.layer === 'ui' || item.layer === 'unit' ? item.layer : undefined) as 'api' | 'ui' | 'unit' | undefined
      return {
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        scenario: String(item.scenario ?? ''),
        steps: Array.isArray(item.steps) ? item.steps.map((step) => String(step)) : [],
        expected: String(item.expected ?? ''),
        priority,
        ...(layer ? { layer } : {}),
        ...(typeof item.source === 'string' ? { source: item.source } : {}),
        ...(typeof item.target === 'string' ? { target: item.target } : {}),
        ...(typeof item.assertions === 'number' ? { assertions: item.assertions } : {}),
        ...(typeof item.coverageDelta === 'string' ? { coverageDelta: item.coverageDelta } : {})
      }
    })
}

function applyRunResult(message: RunResultMessage): void {
  const outcome = message.outcome as LocalRunOutcome
  const runReport = outcome.report
  const metrics = runReport?.metrics
  const gate = runReport?.gate
  const report: TaskSnapshot['report'] | undefined = runReport
    ? {
        passed: runReport.passed ?? 0,
        failed: runReport.failed ?? 0,
        coverage: runReport.coverage ?? null,
        branchCoverage: runReport.branchCoverage,
        durationMs: runReport.durationMs,
        summary: runReport.summary,
        cases: mapCases(outcome.adapterResult?.cases ?? []),
        casesMeta: runReport.cases,
        routing: runReport.routing,
        failedCases: runReport.failedCases ?? [],
        riskPoints: runReport.riskPoints ?? [],
        screenshots: runReport.screenshots ?? [],
        metrics,
        gate: gate ? { coverageTarget: gate.coverageTarget ?? 0, coverage: gate.coverage ?? null, effectiveRate: gate.effectiveRate ?? 0, passed: gate.passed ?? false, reason: gate.reason ?? '' } : undefined,
        knowledge: runReport.knowledge
      }
    : undefined
  snapshot.value = {
    taskId: message.executionId,
    status: gate?.passed === false ? 'needsReview' : 'completed',
    logs: [...localLogs.value],
    lanes: (outcome.lanes ?? []).map((lane) => ({ type: lane.type, status: lane.status, summary: lane.summary })),
    artifacts: outcome.adapterResult?.artifacts ?? [],
    report
  }
}

function handleLocalMessage(raw: unknown): void {
  const message = raw as HostMessage
  switch (message.kind) {
    case 'handshake':
      localStatus.value = { running: message.ok, protocolVersion: message.protocolVersion, hostVersion: message.hostVersion, capabilities: message.capabilities, error: message.error }
      runtime.value = message.ok
        ? { mode: 'real', provider: 'local-host', message: `本机 Host 在线 v${message.hostVersion ?? '?'}` }
        : { mode: 'unavailable', provider: null, message: `本机 Host 握手失败：${message.error ?? ''}` }
      break
    case 'health':
      break
    case 'run-accepted':
      localTaskId.value = message.executionId
      snapshot.value = { taskId: message.executionId, status: 'running', logs: [], lanes: emptyLanes(form.testTypes), artifacts: [] }
      pushLocalLog('info', `任务已接受：${message.executionId}`)
      break
    case 'event':
      pushLocalLog(message.event.level, message.event.message)
      break
    case 'run-event':
      break
    case 'run-result':
      pushLocalLog('success', `任务完成：${message.executionId}`)
      applyRunResult(message)
      void persistCurrentRun()
      break
    case 'run-error':
      pushLocalLog('error', `任务失败：${message.error}`)
      snapshot.value = { taskId: message.executionId, status: message.cancelled ? 'cancelled' : 'failed', logs: [...localLogs.value], lanes: snapshot.value?.lanes ?? emptyLanes(form.testTypes), artifacts: snapshot.value?.artifacts ?? [] }
      break
    case 'cancelled':
      pushLocalLog('warning', `任务已取消：${message.executionId}`)
      if (snapshot.value) snapshot.value = { ...snapshot.value, status: 'cancelled', logs: [...localLogs.value] }
      break
    case 'error':
      pushLocalLog('error', message.message)
      break
  }
}

async function refreshRuntime(): Promise<void> {
  try {
    const status = await window.testAgentLocal.getStatus()
    localStatus.value = status
    runtime.value = status.running
      ? { mode: 'real', provider: 'local-host', message: `本机 Host 在线${status.hostVersion ? ` v${status.hostVersion}` : ''}（能力：${(status.capabilities ?? []).join(', ') || '未报告'}）` }
      : { mode: 'unavailable', provider: null, message: `本机 Host 未就绪${status.error ? '：' + status.error : ''}` }
  } catch (reason) {
    localStatus.value = { running: false, error: reason instanceof Error ? reason.message : '本机 Host 检查失败' }
    runtime.value = { mode: 'unavailable', provider: null, message: localStatus.value.error ?? '' }
  }
}

async function startTask(): Promise<void> {
  error.value = ''
  if (!canStart.value) return
  starting.value = true
  localLogs.value = []
  try {
    const result = await window.testAgentLocal.start({ ...form, testTypes: [...form.testTypes], knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined })
    localTaskId.value = result.taskId
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '任务启动失败'
  } finally {
    starting.value = false
  }
}

async function cancelTask(): Promise<void> {
  if (!localTaskId.value || !taskActive.value) return
  await window.testAgentLocal.cancel(localTaskId.value)
}

async function exportReport(format: 'markdown' | 'html' | 'json'): Promise<void> {
  if (!snapshot.value?.report) return
  const result = await window.testAgent.exportReport(format, snapshot.value)
  if (!result.saved) error.value = result.error ?? '导出失败'
}

async function copySummary(): Promise<void> {
  if (!snapshot.value?.report) return
  await window.testAgent.copyReportSummary(snapshot.value)
}

async function copyPrComment(): Promise<void> {
  if (!prComment.value) return
  await window.testAgent.copyText(prComment.value)
}

async function loadHistory(): Promise<void> {
  try {
    history.value = await window.testAgent.getHistory()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取运行历史失败'
  }
}

async function selectKnowledgeRoots(): Promise<void> {
  try {
    knowledgeRoots.value = await window.testAgent.selectKnowledgeRoots()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '选择知识库目录失败'
  }
}

async function persistCurrentRun(): Promise<void> {
  if (!snapshot.value?.report) return
  try {
    await window.testAgent.saveHistory({
      id: snapshot.value.taskId,
      projectName: form.systemName,
      projectPath: form.projectPath,
      version: form.version,
      savedAt: new Date().toISOString(),
      snapshot: snapshot.value
    })
    await loadHistory()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '保存运行历史失败'
  }
}

function openHistory(record: HistoryRecord): void {
  snapshot.value = record.snapshot
  form.projectPath = record.projectPath
  form.systemName = record.projectName
  form.version = record.version
  localLogs.value = [...record.snapshot.logs]
  localTaskId.value = record.snapshot.taskId
  go('report')
}

async function clearHistory(): Promise<void> {
  await window.testAgent.clearHistory()
  history.value = []
}

function shotUrl(shot: string): string {
  const base = form.projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = shot.replace(/\\/g, '/').replace(/^\//, '')
  return `file:///${base}/${rel}`
}

onMounted(() => {
  void window.testAgent.getKnowledgeRoots().then((roots) => (knowledgeRoots.value = roots))
  unsubscribeRoots = window.testAgent.onKnowledgeRootsChanged((roots) => (knowledgeRoots.value = roots))
  unsubscribeLocal = window.testAgentLocal.subscribe(handleLocalMessage)
  unsubscribeMenuNav = window.testAgent.onNavigate((target) => {
    if (target === 'home' || target === 'history' || target === 'settings') go(target)
  })
  unsubscribeMenuCommand = window.testAgent.onCommand((command) => {
    switch (command) {
      case 'start':
        void startTask()
        break
      case 'cancel':
        void cancelTask()
        break
      case 'exportMarkdown':
        void exportReport('markdown')
        break
      case 'exportHtml':
        void exportReport('html')
        break
      case 'copySummary':
        void copySummary()
        break
      case 'selectKnowledgeRoots':
        void selectKnowledgeRoots()
        break
    }
  })
  void refreshRuntime()
  void loadHistory()
})
onBeforeUnmount(() => {
  unsubscribeRoots?.()
  unsubscribeLocal?.()
  unsubscribeMenuNav?.()
  unsubscribeMenuCommand?.()
})
</script>

<template>
  <main class="shell">
    <template v-if="view === 'home'">
      <section class="card hero-card">
        <div class="hero-head">
          <div>
            <h1>测试工作台</h1>
            <p>选择本地项目，Agent 自动读码、生成单元测试、真实执行，并给出覆盖率、风险点与质量结论。</p>
          </div>
          <div class="hero-actions">
            <button v-if="taskActive" class="btn btn-dark" @click="cancelTask">取消任务</button>
            <button v-else class="btn btn-primary" :disabled="!canStart" @click="startTask">{{ starting ? '启动中…' : '发起真实测试' }}</button>
          </div>
        </div>
        <div class="setup-grid">
          <div class="field">
            <label>项目目录</label>
            <div class="project-field">
              <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
              <button class="btn btn-soft" @click="selectProject">选择</button>
            </div>
          </div>
          <div class="field">
            <label>系统</label>
            <input v-model="form.systemName" aria-label="系统名称" placeholder="自动识别" />
          </div>
          <div class="field">
            <label>版本</label>
            <input v-model="form.version" aria-label="版本" placeholder="Git 分支" />
          </div>
        </div>
        <div class="setup-meta">
          <span v-for="type in (['unit','regression','ui'] as TestType[])" :key="type" class="tag selected">{{ laneLabels[type] }}</span>
          <span class="hint">知识库：{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置' }}</span>
          <span v-if="error" class="error">{{ error }}</span>
        </div>
      </section>

      <div class="section-head"><h2>概览</h2><span class="hint">最近运行 {{ history.length }} 次</span></div>
      <div class="stat-grid">
        <div class="card stat"><div class="num green">{{ overview?.passed ?? '--' }}</div><div class="lbl">通过</div></div>
        <div class="card stat"><div class="num" :class="{ red: overview?.failed }">{{ overview?.failed ?? '--' }}</div><div class="lbl">失败</div></div>
        <div class="card stat"><div class="num">{{ overview ? (overview.coverage === null ? 'N/A' : `${overview.coverage}%`) : '--' }}</div><div class="lbl">覆盖率</div></div>
        <div class="card stat"><div class="num" :class="overview?.gate?.passed ? 'green' : overview?.gate ? 'red' : ''">{{ overview?.gate ? (overview.gate.passed ? '通过' : '未通过') : '--' }}</div><div class="lbl">质量门禁</div></div>
        <div class="card stat"><div class="num">{{ overviewQuality }}</div><div class="lbl">质量分</div></div>
        <div class="card stat"><div class="num">{{ history.length }}</div><div class="lbl">运行次数</div></div>
      </div>

      <template v-if="report">
        <div class="section-head"><h2>PR 评论</h2><button class="btn btn-soft" @click="copyPrComment">复制评论</button></div>
        <pre class="pr-comment">{{ prComment }}</pre>
      </template>

      <div class="section-head"><h2>测试流程</h2><span class="hint">{{ progress }}%</span></div>
      <div class="flow3">
        <div class="card flow3-card" @click="go('plan')"><span class="arrow">›</span><div class="step-num">1</div><h3>测试计划</h3><p>{{ report?.casesMeta ? `${report.casesMeta.count} 条结构化用例` : '运行后生成' }}</p></div>
        <div class="card flow3-card" @click="go('run')"><span class="arrow">›</span><div class="step-num">2</div><h3>本机执行</h3><p>真实日志、修复过程与阶段进度</p></div>
        <div class="card flow3-card" @click="go('report')"><span class="arrow">›</span><div class="step-num">3</div><h3>测试报告</h3><p>{{ report ? `${report.passed} 通过 / ${report.failed} 失败` : '运行后生成' }}</p></div>
      </div>

      <div class="section-head"><h2>测试泳道</h2></div>
      <div class="lane-row">
        <article v-for="lane in lanes" :key="lane.type" class="card lane-card">
          <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : 'UI' }}</span><h3>{{ laneLabels[lane.type] }}</h3><span class="chip" :class="lane.status">{{ lane.status }}</span></div>
          <p>{{ lane.summary }}</p>
        </article>
      </div>

      <footer class="footer">{{ runtime.message }}</footer>
    </template>

    <div v-else-if="view === 'plan'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">测试计划</h1>
      <p class="detail-sub">{{ report?.casesMeta ? `${report.casesMeta.count} 条用例 · 按层 ${JSON.stringify(report.casesMeta.byLayer)} · 按价值 ${JSON.stringify(report.casesMeta.byPriority)}` : '暂无计划数据' }}</p>
      <table class="data-table">
        <thead><tr><th>用例</th><th>目标方法</th><th>层级</th><th>优先级</th><th>场景</th><th>预期</th><th>新增覆盖</th><th>断言</th></tr></thead>
        <tbody>
          <tr v-if="!report?.cases?.length"><td colspan="8" class="muted">暂无结构化用例。</td></tr>
          <tr v-for="item in report?.cases" :key="item.id"><td>{{ item.title }}</td><td>{{ item.target ?? '-' }}</td><td>{{ item.layer ?? '-' }}</td><td>{{ item.priority }}</td><td>{{ item.scenario }}</td><td>{{ item.expected }}</td><td>{{ item.coverageDelta ?? '-' }}</td><td>{{ item.assertions ?? '-' }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="view === 'run'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">执行过程</h1>
      <p class="detail-sub">{{ form.systemName }} · 任务 ID {{ localTaskId || '--' }}</p>
      <div class="console-collapse" style="background:#0f172a">
        <summary style="color:#fff">Agent 执行日志</summary>
        <div class="console-lines" style="max-height:480px">
          <p v-if="!localLogs.length">{{ runtime.message }}</p>
          <p v-for="log in localLogs" :key="log.id" :class="log.level"><b>[{{ log.time }}]</b> {{ log.message }}</p>
        </div>
      </div>
    </div>

    <div v-else-if="view === 'report'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <div class="head-row">
        <div><h1 class="detail-title" style="margin:0 0 6px">测试报告</h1><p class="detail-sub" style="margin:0">{{ form.systemName }} · 耗时 {{ durationText }}</p></div>
        <span class="verdict compact" :class="report?.gate?.passed ? 'pass' : 'warn'">{{ report?.gate?.passed ? '✓ 质量门禁通过' : '⚠ 需人工关注' }}</span>
      </div>

      <div class="stat-grid">
        <div class="card stat"><div class="num green">{{ report?.passed ?? '--' }}</div><div class="lbl">通过</div></div>
        <div class="card stat"><div class="num" :class="{ red: report?.failed }">{{ report?.failed ?? '--' }}</div><div class="lbl">失败</div></div>
        <div class="card stat"><div class="num">{{ report ? (report.coverage === null ? 'N/A' : `${report.coverage}%`) : '--' }}</div><div class="lbl">覆盖率</div></div>
        <div class="card stat"><div class="num" :class="report?.gate?.passed ? 'green' : 'red'">{{ report?.gate ? (report.gate.passed ? '通过' : '未通过') : '--' }}</div><div class="lbl">质量门禁</div></div>
        <div class="card stat"><div class="num">{{ durationText }}</div><div class="lbl">耗时</div></div>
        <div class="card stat"><div class="num">{{ report ? qualityScore : '--' }}</div><div class="lbl">质量分</div></div>
      </div>

      <div v-if="report?.summary" class="card panel summary-card">{{ report.summary }}</div>

      <section class="report-section">
        <h2>覆盖率</h2>
        <div class="card panel">
          <div style="display:flex;justify-content:space-between"><span class="muted">覆盖率</span><b>{{ report?.coverage === null || report?.coverage === undefined ? 'N/A' : `${report.coverage}%` }}</b></div>
          <div class="bar"><div :style="{ width: `${report?.coverage ?? 0}%` }"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:12px"><span class="muted">分支覆盖率</span><b>{{ report?.branchCoverage === null || report?.branchCoverage === undefined ? 'N/A' : `${report.branchCoverage}%` }}</b></div>
          <div class="bar amber"><div :style="{ width: `${report?.branchCoverage ?? 0}%` }"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:12px"><span class="muted">有效用例占比</span><b>{{ effectivePercent }}%</b></div>
          <div class="bar amber"><div :style="{ width: `${effectivePercent}%` }"></div></div>
        </div>
      </section>

      <section v-if="report?.riskPoints?.length" class="report-section">
        <h2>风险点</h2>
        <div v-for="risk in report.riskPoints" :key="risk.file" class="card" style="padding:14px;margin-bottom:10px;display:flex;align-items:flex-start;gap:10px">
          <span class="severity" :class="risk.severity">{{ risk.severity === 'high' ? '高' : risk.severity === 'medium' ? '中' : '低' }}</span>
          <span><b>{{ risk.file }}</b><div class="muted">{{ risk.message }}{{ risk.suggestion ? ` · ${risk.suggestion}` : '' }}</div></span>
        </div>
      </section>

      <section class="report-section">
        <h2>测试泳道</h2>
        <div class="lane-row">
          <article v-for="lane in lanes" :key="lane.type" class="card lane-card">
            <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : 'UI' }}</span><h3>{{ laneLabels[lane.type] }}</h3><span class="chip" :class="lane.status">{{ lane.status }}</span></div>
            <p>{{ lane.summary }}</p>
          </article>
        </div>
      </section>

      <section class="report-section">
        <h2>测试计划 / 生成测试</h2>
        <table class="data-table">
          <thead><tr><th>测试用例</th><th>目标方法</th><th>层级</th><th>优先级</th><th>新增覆盖</th><th>断言</th></tr></thead>
          <tbody>
            <tr v-if="!report?.cases?.length"><td colspan="6" class="muted">暂无结构化用例。</td></tr>
            <tr v-for="item in report?.cases" :key="item.id"><td>{{ item.title }}</td><td>{{ item.target ?? '-' }}</td><td>{{ item.layer ?? '-' }}</td><td>{{ item.priority }}</td><td>{{ item.coverageDelta ?? '-' }}</td><td>{{ item.assertions ?? '-' }}</td></tr>
          </tbody>
        </table>
      </section>

      <section class="report-section">
        <h2>失败用例</h2>
        <table class="data-table">
          <thead><tr><th>用例</th><th>层级</th><th>错误摘要</th><th>根因建议</th><th>截图</th></tr></thead>
          <tbody>
            <tr v-if="!report?.failedCases?.length"><td colspan="5" class="muted">本次运行没有失败用例。</td></tr>
            <tr v-for="item in report?.failedCases" :key="item.name"><td>{{ item.name }}</td><td>{{ item.layer }}</td><td>{{ item.error }}</td><td>{{ item.suggestion ?? '-' }}</td><td>{{ item.screenshot ?? '-' }}</td></tr>
          </tbody>
        </table>
      </section>

      <section v-if="report?.screenshots?.length" class="report-section">
        <h2>UI 截图</h2>
        <div class="shot-grid">
          <figure v-for="shot in report.screenshots" :key="shot" class="shot-item"><img :src="shotUrl(shot)" :alt="shot" /><figcaption>{{ shot }}</figcaption></figure>
        </div>
      </section>

      <section class="report-section">
        <h2>测试产物</h2>
        <div v-if="!artifactItems.length" class="muted">暂无制品。</div>
        <div v-else class="artifact-list">
          <div v-for="artifact in artifactItems" :key="artifact.path" class="artifact"><span>📄</span><span><div class="name">{{ artifact.name }}</div><div class="path">{{ artifact.path }}</div></span></div>
        </div>
      </section>

      <section class="report-section">
        <h2>知识库引用</h2>
        <div class="card panel">
          <span v-if="report?.knowledge?.degraded" class="hint">知识库降级：{{ report.knowledge.reason }}</span>
          <span v-else class="hint">命中 {{ report?.knowledge?.refs.length ?? 0 }} 条{{ report?.knowledge?.refs.length ? `：${report.knowledge.refs.map((ref) => ref.source).join(', ')}` : '' }}</span>
        </div>
      </section>

      <div class="export-bar">
        <button class="btn btn-primary" :disabled="!report" @click="exportReport('markdown')">导出 Markdown</button>
        <button class="btn btn-dark" :disabled="!report" @click="exportReport('html')">导出 HTML</button>
        <button class="btn btn-soft" :disabled="!report" @click="copySummary">复制摘要</button>
      </div>
    </div>

    <div v-else-if="view === 'history'" class="detail-view">
      <button class="back" @click="go('home')">← 返回首页</button>
      <div class="head-row">
        <div><h1 class="detail-title">运行历史</h1><p class="detail-sub" style="margin:0">已保存的本地执行记录</p></div>
        <button class="btn btn-soft" :disabled="!history.length" @click="clearHistory">清空历史</button>
      </div>
      <div v-if="!history.length" class="card panel muted">暂无运行历史</div>
      <div v-else class="history-list">
        <article v-for="item in history" :key="item.id" class="card history-card" @click="openHistory(item)">
          <div class="history-head">
            <div>
              <div class="history-title">{{ item.projectName || '未命名项目' }}</div>
              <div class="history-path">{{ item.projectPath }}</div>
            </div>
            <span class="chip" :class="item.snapshot.report?.gate?.passed === false ? 'failed' : 'passed'">{{ item.snapshot.report?.gate?.passed === false ? '需人工关注' : '已完成' }}</span>
          </div>
          <div class="history-stats">
            <span>通过 <b>{{ item.snapshot.report?.passed ?? '--' }}</b></span>
            <span>失败 <b :class="{ red: item.snapshot.report?.failed }">{{ item.snapshot.report?.failed ?? '--' }}</b></span>
            <span>覆盖率 <b>{{ item.snapshot.report?.coverage === null || item.snapshot.report?.coverage === undefined ? 'N/A' : `${item.snapshot.report.coverage}%` }}</b></span>
            <span class="muted">{{ new Date(item.savedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
          </div>
        </article>
      </div>
    </div>

    <div v-else-if="view === 'settings'" class="detail-view">
      <button class="back" @click="go('home')">← 返回首页</button>
      <h1 class="detail-title">配置</h1>
      <p class="detail-sub">本机执行与知识库配置</p>
      <section class="report-section">
        <h2>覆盖率目标</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">质量门禁最低覆盖率（%）</div>
            <input v-model.number="form.coverageTarget" type="number" min="0" max="100" class="settings-input" />
          </div>
          <span class="hint">低于该值时，质量门禁会标记为需人工关注</span>
        </div>
      </section>
      <section class="report-section">
        <h2>知识库目录</h2>
        <div class="card panel settings-row">
          <div>
            <div class="muted">当前知识库</div>
            <div class="root-list">{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置' }}</div>
          </div>
          <button class="btn btn-primary" @click="selectKnowledgeRoots">选择目录</button>
        </div>
      </section>
    </div>
  </main>
  <div class="host-pill" :class="{ off: !localStatus.running }"><span class="dot"></span>{{ localStatus.running ? '本机 Host 在线' : '本机 Host 未就绪' }}</div>
</template>
