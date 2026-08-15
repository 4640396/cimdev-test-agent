<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { LocalHostStatus, RuntimeStatus, TaskInput, TaskSnapshot, TestType } from '../../../../../contracts/src/contracts'
import type { HostMessage, RunResultMessage } from '../../../../../contracts/src/local-host-protocol'
import { emptyLanes, laneLabels, progressOf } from './task-state'

const form = reactive<TaskInput>({
  projectPath: '',
  systemName: '',
  version: '',
  testTypes: ['unit', 'regression', 'ui']
})
const snapshot = ref<TaskSnapshot | null>(null)
const error = ref('')
const starting = ref(false)
const runtime = ref<RuntimeStatus>({ mode: 'unavailable', provider: null, message: '正在读取本机 Host 状态' })
const knowledgeRoots = ref<string[]>([])
const localStatus = ref<LocalHostStatus>({ running: false })
const localLogs = ref<TaskSnapshot['logs']>([])
const localTaskId = ref('')
let unsubscribeRoots: (() => void) | undefined
let unsubscribeLocal: (() => void) | undefined

const lanes = computed(() => snapshot.value?.lanes ?? emptyLanes(form.testTypes))
const progress = computed(() => progressOf(snapshot.value))
const taskActive = computed(() => snapshot.value?.status === 'queued' || snapshot.value?.status === 'planning' || snapshot.value?.status === 'running' || snapshot.value?.status === 'needsReview')
const canStart = computed(() => Boolean(localStatus.value.running && form.projectPath && form.systemName && form.testTypes.length && !starting.value && !taskActive.value))

async function selectProject(): Promise<void> {
  error.value = ''
  try {
    const selection = await window.testAgent.selectProject()
    if (!selection) return
    form.projectPath = selection.path
    form.systemName = selection.detectedSystem
    form.version = selection.detectedVersion
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '目录选择失败'
  }
}

function toggleType(type: TestType): void {
  const index = form.testTypes.indexOf(type)
  if (index >= 0) form.testTypes.splice(index, 1)
  else form.testTypes.push(type)
}

function pushLocalLog(level: 'info' | 'success' | 'warning' | 'error', message: string): void {
  localLogs.value.push({ id: `${Date.now()}-${localLogs.value.length}`, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message })
  if (localLogs.value.length > 300) localLogs.value.splice(0, localLogs.value.length - 300)
}

interface LocalRunOutcome {
  adapterResult?: { artifacts?: string[] }
  report?: {
    passed?: number
    failed?: number
    coverage?: number | null
    metrics?: NonNullable<TaskSnapshot['report']>['metrics']
    gate?: { passed?: boolean }
    knowledge?: NonNullable<TaskSnapshot['report']>['knowledge']
  }
  lanes?: Array<{ type: TestType; status: 'passed' | 'failed'; summary: string }>
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
        metrics,
        gate: gate
          ? {
              coverageTarget: 0,
              coverage: runReport.coverage ?? null,
              effectiveRate: metrics?.effectiveRate ?? 0,
              passed: gate.passed ?? false,
              reason: ''
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
      if (message.event.stage) snapshot.value = snapshot.value ? { ...snapshot.value, status: 'running' } : snapshot.value
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
      <div class="brand"><span class="logo">≡</span><strong>CIMDEV Test Agent · QA Pipeline</strong><small class="mode-badge" :class="runtime.mode">{{ runtime.mode === 'real' ? '本机 Host' : '未就绪' }}</small></div>
      <button v-if="taskActive" class="dark-button" @click="cancelTask">■ 取消任务</button>
      <button v-else class="dark-button" :disabled="!canStart" @click="startTask">▶ {{ starting ? '启动中' : '发起真实测试' }}</button>
    </header>

    <section class="hero-grid">
      <article class="panel input-panel">
        <h2>① 测试任务输入</h2>
        <label>系统 / 版本</label>
        <div class="two-columns">
          <input v-model="form.systemName" aria-label="系统名称" placeholder="选择目录后自动识别" />
          <input v-model="form.version" aria-label="版本" placeholder="Git 分支或手工填写" />
        </div>
        <label>项目目录</label>
        <div class="project-picker">
          <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
          <button @click="selectProject">选择</button>
        </div>
        <div class="checks">
          <button v-for="type in (['unit','regression','ui'] as TestType[])" :key="type" :class="{ selected: form.testTypes.includes(type) }" @click="toggleType(type)">{{ laneLabels[type] }}</button>
        </div>
        <label>知识库目录</label>
        <div class="knowledge-picker">
          <span class="knowledge-roots">{{ knowledgeRoots.length ? knowledgeRoots.join('; ') : '未配置（默认取 项目/knowledge）' }}</span>
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
      <article class="panel plan-card">
        <h2>③ 测试计划</h2>
        <button class="primary" :disabled="!canStart" @click="startTask">生成与确认</button>
        <label>真实输出制品</label>
        <div v-if="!snapshot?.artifacts.length" class="artifact">任务执行后显示真实文件</div>
        <div v-for="artifact in snapshot?.artifacts" :key="artifact" class="artifact">{{ artifact }}<span>↓</span></div>
      </article>

      <article class="dispatch-card">
        <span>④</span><h2>本机执行</h2>
        <p>任务直接交给本机 Host 与 TestKernel，不进入 Java 中央队列</p>
      </article>

      <div class="lanes">
        <article v-for="lane in lanes" :key="lane.type" class="panel lane-card" :class="lane.status">
          <div class="lane-heading"><span class="lane-icon">{{ lane.type === 'unit' ? 'U' : lane.type === 'regression' ? 'R' : 'UI' }}</span><h2>{{ laneLabels[lane.type] }}</h2><b>{{ lane.status }}</b></div>
          <p>{{ lane.summary }}</p>
          <div class="lane-detail">{{ lane.type === 'unit' ? '生成 · 编译 · 断言 · 覆盖率' : lane.type === 'regression' ? '基线 · 核心场景 · 差异验证' : '页面操作 · 状态断言 · 截图' }}</div>
        </article>
      </div>

      <article class="panel report-card">
        <h2>⑤ 综合测试报告</h2>
        <p>汇总三类测试执行结果</p>
        <div class="report-number"><strong>{{ snapshot?.report?.passed ?? '--' }}</strong><span>通过</span></div>
        <div class="report-number"><strong>{{ snapshot?.report?.failed ?? '--' }}</strong><span>失败</span></div>
        <div class="report-number"><strong>{{ snapshot?.report ? (snapshot.report.coverage === null ? 'N/A' : `${snapshot.report.coverage}%`) : '--' }}</strong><span>覆盖率</span></div>
        <button class="report-button" :disabled="!snapshot?.report">查看报告</button>
      </article>
    </section>

    <footer>{{ runtime.message }}</footer>
  </main>
</template>
