<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { TaskInput, TaskSnapshot, TestType } from '../../shared/contracts'
import { emptyLanes, laneLabels, progressOf } from './task-state'

const form = reactive<TaskInput>({
  projectPath: '',
  systemName: 'CIMDEV-01',
  version: 'release/2.6',
  testTypes: ['unit', 'regression', 'ui']
})
const snapshot = ref<TaskSnapshot | null>(null)
const error = ref('')
const starting = ref(false)
let unsubscribe: (() => void) | undefined

const lanes = computed(() => snapshot.value?.lanes ?? emptyLanes(form.testTypes))
const progress = computed(() => progressOf(snapshot.value))
const canStart = computed(() => Boolean(form.projectPath && form.systemName && form.testTypes.length && !starting.value))

async function selectProject(): Promise<void> {
  const path = await window.testAgent.selectProject()
  if (path) form.projectPath = path
}

function toggleType(type: TestType): void {
  const index = form.testTypes.indexOf(type)
  if (index >= 0) form.testTypes.splice(index, 1)
  else form.testTypes.push(type)
}

async function startTask(): Promise<void> {
  error.value = ''
  starting.value = true
  try {
    await window.testAgent.startTask({ ...form, testTypes: [...form.testTypes] })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '任务启动失败'
  } finally {
    starting.value = false
  }
}

onMounted(() => {
  unsubscribe = window.testAgent.subscribeTask((next) => (snapshot.value = next))
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><span class="logo">≡</span><strong>CIMDEV Test Agent · QA Pipeline</strong></div>
      <button class="dark-button" :disabled="!canStart" @click="startTask">▶ {{ starting ? '启动中' : '发起任务' }}</button>
    </header>

    <section class="hero-grid">
      <article class="panel input-panel">
        <h2>① 测试任务输入</h2>
        <label>系统 / 版本</label>
        <div class="two-columns">
          <input v-model="form.systemName" aria-label="系统名称" />
          <input v-model="form.version" aria-label="版本" />
        </div>
        <label>项目目录</label>
        <div class="project-picker">
          <input v-model="form.projectPath" aria-label="项目目录" placeholder="输入或选择本地项目目录" />
          <button @click="selectProject">选择</button>
        </div>
        <div class="checks">
          <button v-for="type in (['unit','regression','ui'] as TestType[])" :key="type" :class="{ selected: form.testTypes.includes(type) }" @click="toggleType(type)">{{ laneLabels[type] }}</button>
        </div>
        <p v-if="error" class="error">{{ error }}</p>
      </article>

      <article class="console-panel">
        <div class="console-title"><h2>② Agent 执行日志</h2><span><i></i><i></i><i></i></span></div>
        <div class="console-lines">
          <p v-if="!snapshot">等待发起任务。初版默认使用安全模拟模式。</p>
          <p v-for="log in snapshot?.logs" :key="log.id" :class="log.level"><b>[{{ log.time }}]</b> {{ log.message }}</p>
        </div>
      </article>
    </section>

    <div class="section-title"><h2>自动化测试执行流水线</h2><div class="progress"><span :style="{ width: `${progress}%` }"></span></div><em>{{ progress }}%</em></div>

    <section class="pipeline">
      <article class="panel plan-card">
        <h2>③ 测试计划</h2>
        <button class="primary" :disabled="!canStart" @click="startTask">生成与确认</button>
        <label>输出制品</label>
        <div v-for="artifact in (snapshot?.artifacts.length ? snapshot.artifacts : ['test-plan.json','test-cases.md','knowledge-ref.json'])" :key="artifact" class="artifact">{{ artifact }}<span>↓</span></div>
      </article>

      <article class="dispatch-card">
        <span>④</span><h2>智能分发</h2>
        <p>按照测试类型、技术栈和执行环境分配任务</p>
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
        <div class="report-number"><strong>{{ snapshot?.report?.coverage ?? '--' }}{{ snapshot?.report ? '%' : '' }}</strong><span>覆盖率</span></div>
        <button class="report-button" :disabled="!snapshot?.report">查看报告</button>
      </article>
    </section>

    <footer>初版原型 · CimiCode真实调用默认关闭 · 设置受控环境变量后启用</footer>
  </main>
</template>
