<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { FailedCaseRecord, LocalHostStatus, RoutingRecord, RuntimeStatus, TaskInput, TaskSnapshot, TestCaseRecord, TestType } from '../../../../../contracts/src/contracts'
import type { HostMessage, RunResultMessage } from '../../../../../contracts/src/local-host-protocol'
import { emptyLanes, laneLabels, progressOf } from './task-state'

type View = 'home' | 'plan' | 'run' | 'report'

const form = reactive<TaskInput>({
  projectPath: '',
  systemName: '',
  version: '',
  testTypes: ['unit']
})
const snapshot = ref<TaskSnapshot | null>(null)
const error = ref('')
const starting = ref(false)
const runtime = ref<RuntimeStatus>({ mode: 'unavailable', provider: null, message: '正在读取本机 Host 状态…' })
const knowledgeRoots = ref<string[]>([])
const localStatus = ref<LocalHostStatus>({ running: false })
const localLogs = ref<TaskSnapshot['logs']>([])
const localTaskId = ref('')
const view = ref<View>('home')

let detectTimer: ReturnType<typeof setTimeout> | undefined
let unsubscribeRoots: (() => void) | undefined
let unsubscribeLocal: (() => void) | undefined

const lanes = computed(() => snapshot.value?.lanes ?? emptyLanes(form.testTypes))
const progress = computed(() => progressOf(snapshot.value))
const taskActive = computed(() => snapshot.value?.status === 'queued' || snapshot.value?.status === 'planning' || snapshot.value?.status === 'running')
const canStart = computed(() => Boolean(localStatus.value.running && form.projectPath && form.systemName && form.testTypes.length && !starting.value && !taskActive.value))
const report = computed(() => snapshot.value?.report)

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
    durationMs?: number
    summary?: string
    cases?: { count: number; byLayer: Record<string, number>; byPriority: Record<string, number> }
    routing?: RoutingRecord[]
    failedCases?: FailedCaseRecord[]
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
        ...(typeof item.source === 'string' ? { source: item.source } : {})
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
        durationMs: runReport.durationMs,
        summary: runReport.summary,
        cases: mapCases(outcome.adapterResult?.cases ?? []),
        casesMeta: runReport.cases,
        routing: runReport.routing,
        failedCases: runReport.failedCases ?? [],
        screenshots: runReport.screenshots ?? [],
        metrics,
        gate: gate
          ? {
              coverageTarget: gate.coverageTarget ?? 0,
              coverage: gate.coverage ?? null,
              effectiveRate: gate.effectiveRate ?? 0,
              passed: gate.passed ?? false,
              reason: gate.reason ?? ''
            }
          : undefined,
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
      localStatus.value = {
        running: message.ok,
        protocolVersion: message.protocolVersion,
        hostVersion: message.hostVersion,
        capabilities: message.capabilities,
        error: message.error
      }
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
      break
    case 'run-error':
      pushLocalLog('error', `任务失败：${message.error}`)
      snapshot.value = {
        taskId: message.executionId,
        status: message.cancelled ? 'cancelled' : 'failed',
        logs: [...localLogs.value],
        lanes: snapshot.value?.lanes ?? emptyLanes(form.testTypes),
        artifacts: snapshot.value?.artifacts ?? []
      }
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
  starting.value = true
  localLogs.value = []
  try {
    const result = await window.testAgentLocal.start({
      ...form,
      testTypes: [...form.testTypes],
      knowledgeRoots: knowledgeRoots.value.length > 0 ? [...knowledgeRoots.value] : undefined
    })
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

function shotUrl(shot: string): string {
  const base = form.projectPath.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = shot.replace(/\\/g, '/').replace(/^\//, '')
  return `file:///${base}/${rel}`
}

onMounted(() => {
  void window.testAgent.getKnowledgeRoots().then((roots) => (knowledgeRoots.value = roots))
  unsubscribeRoots = window.testAgent.onKnowledgeRootsChanged((roots) => (knowledgeRoots.value = roots))
  unsubscribeLocal = window.testAgentLocal.subscribe(handleLocalMessage)
  void refreshRuntime()
})
onBeforeUnmount(() => { unsubscribeRoots?.(); unsubscribeLocal?.() })
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="logo">◆</span><strong>CIMDEV Test Agent · QA Pipeline</strong><small class="mode-badge" :class="runtime.mode">{{ runtime.mode === 'real' ? '本机 Host' : '未就绪' }}</small></div>
      <button v-if="taskActive" class="dark-button" @click="cancelTask">■ 取消任务</button>
      <button v-else class="dark-button" :disabled="!canStart" @click="startTask">▶ {{ starting ? '启动中…' : '发起真实测试' }}</button>
    </header>

    <!-- 首页：保持现有布局 -->
    <template v-if="view === 'home'">
      <section class="hero-grid">
        <article class="panel input-panel">
          <h2>① 测试任务输入</h2>
          <label>系统 / 版本</label>
          <div class="two-columns">
            <input v-model="form.systemName" aria-label="系统名称" placeholder="选择目录后自动识别" />
            <input v-model="form.version" aria-label="版本" placeholder="Git 分支或手动填写" />
          </div>
          <label>项目目录</label>
          <div class="project-picker">
            <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
            <button @click="selectProject">选择</button>
          </div>
          <div class="checks">
            <button v-for="type in (['unit','regression','ui'] as TestType[])" :key="type" :class="{ selected: form.testTypes.includes(type) }" type="button">{{ laneLabels[type] }}</button>
          </div>
          <p class="auto-hint">已根据项目类型自动识别测试类型，无需手动勾选。</p>
          <label>知识库目录</label>
          <div class="knowledge-picker">
            <span class="knowledge-roots">{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置（默认可读项目 /knowledge）' }}</span>
            <span class="hint">左上角菜单「配置 → 知识库目录」可设置</span>
          </div>
          <p v-if="error" class="error">{{ error }}</p>
        </article>

        <article class="console-panel">
          <div class="console-title"><h2>② Agent 执行日志</h2><span><i></i><i></i><i></i></span></div>
          <div class="console-lines">
            <p v-if="!localLogs.length">{{ runtime.message }}</p>
            <p v-for="log in localLogs" :key="log.id" :class="log.level"><b>[{{ log.time }}]</b> {{ log.message }}</p>
          </div>
        </article>
      </section>

      <div class="section-title"><h2>自动化测试执行流水线</h2><div class="progress"><span :style="{ width: `${progress}%` }"></span></div><em>{{ progress }}%</em></div>

      <section class="pipeline">
        <article class="panel plan-card clickable" @click="go('plan')">
          <span class="goto">查看详情 ›</span>
          <h2>① 测试计划</h2>
          <button class="primary" :disabled="!canStart" @click.stop="startTask">生成与确认</button>
          <label>真实输出制品</label>
          <div v-if="!snapshot?.artifacts.length" class="artifact">任务执行后显示真实文件</div>
          <div v-for="artifact in snapshot?.artifacts" :key="artifact" class="artifact">{{ artifact }}<span>↗</span></div>
        </article>

        <article class="dispatch-card clickable" @click="go('run')">
          <span class="goto">查看详情 ›</span>
          <span>②</span>
          <h2>本机执行</h2>
          <p>任务直接交给本机 Host 中的 TestKernel，不走 Java 中央队列</p>
        </article>

        <div class="lanes">
          <article v-for="lane in lanes" :key="lane.type" class="panel lane-card" :class="lane.status">
            <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : 'UI' }}</span><h2>{{ laneLabels[lane.type] }}</h2><b>{{ lane.status }}</b></div>
            <p>{{ lane.summary }}</p>
            <div class="lane-detail">{{ lane.type === 'unit' ? '生成 · 编译 · 断言 · 覆盖率' : lane.type === 'regression' ? '基线 · 核心场景 · 差异验证' : '页面操作 · 状态断言 · 截图' }}</div>
          </article>
        </div>

        <article class="panel report-card clickable" @click="go('report')">
          <span class="goto">查看详情 ›</span>
          <h2>③ 综合测试报告</h2>
          <p>汇总三类测试执行结果</p>
          <div class="report-number"><strong>{{ report?.passed ?? '--' }}</strong><span>通过</span></div>
          <div class="report-number"><strong>{{ report?.failed ?? '--' }}</strong><span>失败</span></div>
          <div class="report-number"><strong>{{ report ? (report.coverage === null ? 'N/A' : `${report.coverage}%`) : '--' }}</strong><span>覆盖率</span></div>
          <button class="report-button" :disabled="!report">查看报告</button>
        </article>
      </section>

      <footer>{{ runtime.message }}</footer>
    </template>

    <!-- 测试计划详情 -->
    <div v-else-if="view === 'plan'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">测试计划</h1>
      <p class="detail-sub">{{ report?.casesMeta ? `${report.casesMeta.count} 条用例 · 按层 ${JSON.stringify(report.casesMeta.byLayer)} · 按价值 ${JSON.stringify(report.casesMeta.byPriority)}` : '暂无计划数据' }}</p>
      <table class="detail-table">
        <thead><tr><th>用例</th><th>层级</th><th>优先级</th><th>场景</th><th>预期</th><th>来源</th></tr></thead>
        <tbody>
          <tr v-if="!report?.cases?.length"><td colspan="6">暂无结构化用例。</td></tr>
          <tr v-for="item in report?.cases" :key="item.id">
            <td>{{ item.title }}</td><td>{{ item.layer ?? '-' }}</td><td>{{ item.priority }}</td><td>{{ item.scenario }}</td><td>{{ item.expected }}</td><td>{{ item.source ?? '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 执行过程详情 -->
    <div v-else-if="view === 'run'" class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">执行过程</h1>
      <p class="detail-sub">{{ form.systemName }} · 任务 ID {{ localTaskId || '--' }}</p>
      <div class="console-panel" style="min-height:340px">
        <div class="console-title"><h2>Agent 执行日志</h2></div>
        <div class="console-lines" style="height:300px">
          <p v-if="!localLogs.length">{{ runtime.message }}</p>
          <p v-for="log in localLogs" :key="log.id" :class="log.level"><b>[{{ log.time }}]</b> {{ log.message }}</p>
        </div>
      </div>
    </div>

    <!-- 测试报告详情 -->
    <div v-else class="detail-view">
      <button class="back" @click="go('home')">‹ 返回首页</button>
      <h1 class="detail-title">测试报告</h1>
      <p class="detail-sub">{{ form.systemName }} · 耗时 {{ report?.durationMs !== undefined ? `${Math.round(report.durationMs / 1000)}s` : '--' }}</p>

      <div class="verdict" :class="report?.gate?.passed ? 'pass' : 'warn'">
        {{ report?.gate?.passed ? '✓ 质量门禁通过' : '⚠ 需人工关注' }}
      </div>

      <div class="metrics-grid">
        <div class="panel metric-card"><div class="num" :style="report ? { color: '#16a34a' } : {}">{{ report?.passed ?? '--' }}</div><div class="lbl">通过</div></div>
        <div class="panel metric-card"><div class="num">{{ report?.failed ?? '--' }}</div><div class="lbl">失败</div></div>
        <div class="panel metric-card"><div class="num">{{ report ? (report.coverage === null ? 'N/A' : `${report.coverage}%`) : '--' }}</div><div class="lbl">覆盖率</div></div>
        <div class="panel metric-card"><div class="num" :style="report?.gate?.passed ? { color: '#16a34a' } : {}">{{ report?.gate ? (report.gate.passed ? '通过' : '未通过') : '--' }}</div><div class="lbl">质量门禁</div></div>
      </div>

      <div v-if="report?.summary" class="panel summary-card">{{ report.summary }}</div>

      <div class="section-title"><h2>测试泳道</h2></div>
      <div class="lanes detail-lanes">
        <article v-for="lane in lanes" :key="lane.type" class="panel lane-card" :class="lane.status">
          <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : 'UI' }}</span><h2>{{ laneLabels[lane.type] }}</h2><b>{{ lane.status }}</b></div>
          <p>{{ lane.summary }}</p>
        </article>
      </div>

      <div class="section-title"><h2>失败用例</h2></div>
      <table class="detail-table">
        <thead><tr><th>用例</th><th>层级</th><th>错误摘要</th><th>根因建议</th><th>截图</th></tr></thead>
        <tbody>
          <tr v-if="!report?.failedCases?.length"><td colspan="5">本次运行没有失败用例。</td></tr>
          <tr v-for="item in report?.failedCases" :key="item.name">
            <td>{{ item.name }}</td><td>{{ item.layer }}</td><td>{{ item.error }}</td><td>{{ item.suggestion ?? '-' }}</td><td>{{ item.screenshot ?? '-' }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="report?.screenshots?.length" class="section-title"><h2>UI 截图</h2></div>
      <div v-if="report?.screenshots?.length" class="shot-grid">
        <figure v-for="shot in report.screenshots" :key="shot" class="shot-item">
          <img :src="shotUrl(shot)" :alt="shot" />
          <figcaption>{{ shot }}</figcaption>
        </figure>
      </div>

      <div class="section-title"><h2>知识库引用</h2></div>
      <div class="panel" style="padding:14px">
        <span v-if="report?.knowledge?.degraded" class="hint">知识库降级：{{ report.knowledge.reason }}</span>
        <span v-else class="hint">命中 {{ report?.knowledge?.refs.length ?? 0 }} 条{{ report?.knowledge?.refs.length ? `：${report.knowledge.refs.map((ref) => ref.source).join(', ')}` : '' }}</span>
      </div>

      <div class="export-bar">
        <button class="primary" :disabled="!report" @click="exportReport('markdown')">导出 Markdown</button>
        <button class="dark-button" :disabled="!report" @click="exportReport('html')">导出 HTML</button>
        <button class="secondary-button" :disabled="!report" @click="copySummary">复制摘要</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.clickable { cursor: pointer; position: relative; }
.goto { position: absolute; right: 14px; top: 14px; font-size: 12px; color: #7668e8; font-weight: 700; }
.auto-hint { color: #77839a; font-size: 12px; margin: 8px 0 0; }
.knowledge-picker { min-height: 50px; padding: 10px 12px; border: 1px dashed #aeb9ce; border-radius: 10px; background: #fafbfe; color: #27334c; }
.knowledge-roots { display: block; font-size: 13px; }
.hint { color: #77839a; font-size: 12px; }
.detail-view { max-width: 1180px; margin: 0 auto; padding: 8px 0 40px; }
.back { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #d8deeb; background: #fff; color: #17223b; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-bottom: 14px; }
.detail-title { font-size: 24px; font-weight: 800; margin: 0 0 6px; }
.detail-sub { color: #77839a; margin: 0 0 20px; }
.detail-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e4e8f0; border-radius: 12px; overflow: hidden; }
.detail-table th, .detail-table td { text-align: left; padding: 11px 12px; border-bottom: 1px solid #e4e8f0; font-size: 13px; }
.detail-table th { background: #f8fafc; color: #69758b; font-weight: 600; }
.verdict { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-radius: 12px; font-weight: 700; }
.verdict.pass { background: #eafaf0; color: #16a34a; }
.verdict.warn { background: #fff7e6; color: #d97706; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 18px; }
.metric-card { padding: 16px; }
.metric-card .num { font-size: 28px; font-weight: 800; }
.metric-card .lbl { color: #77839a; font-size: 13px; }
.summary-card { padding: 14px; margin-top: 14px; color: #45536d; }
.detail-lanes { display: grid; grid-template-rows: repeat(3, 1fr); gap: 14px; }
.shot-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.shot-item { margin: 0; }
.shot-item img { width: 100%; border: 1px solid #e4e8f0; border-radius: 10px; background: #f8fafc; }
.shot-item figcaption { color: #77839a; font-size: 12px; margin-top: 6px; word-break: break-all; }
.export-bar { display: flex; gap: 10px; margin-top: 24px; flex-wrap: wrap; }
.secondary-button { border: 1px solid #d8deeb; background: #fff; color: #17223b; padding: 12px 16px; border-radius: 9px; cursor: pointer; font-weight: 700; }
</style>
