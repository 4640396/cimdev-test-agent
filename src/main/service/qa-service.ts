import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProjectRecord, ScheduleRecord, TaskInput, TaskLog, TaskSnapshot } from '../../shared/contracts.js'
import { createAgentAdapter } from '../agent/factory.js'
import type { AgentEvent } from '../agent/types.js'
import { Repository } from './repository.js'

interface QueuedTask { id: string; input: TaskInput; triggerType: string; createdAt: string }

export class QaService {
  private readonly events = new EventEmitter()
  private readonly queue: QueuedTask[] = []
  private readonly controllers = new Map<string, AbortController>()
  private running = 0
  private scheduleTimer?: NodeJS.Timeout

  constructor(private readonly repository: Repository, private readonly concurrency = 1) {
    repository.recoverInterruptedTasks()
  }

  start(): void {
    this.scheduleTimer = setInterval(() => this.runDueSchedules(), 30_000)
    this.scheduleTimer.unref()
    this.runDueSchedules()
  }

  stop(): void {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer)
    for (const controller of this.controllers.values()) controller.abort()
  }

  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void {
    this.events.on('task', listener)
    return () => this.events.off('task', listener)
  }

  subscribeTask(taskId: string, listener: (snapshot: TaskSnapshot) => void): () => void {
    const wrapped = (snapshot: TaskSnapshot): void => { if (snapshot.taskId === taskId) listener(snapshot) }
    return this.subscribe(wrapped)
  }

  createTask(input: TaskInput, triggerType = 'manual'): { taskId: string } {
    this.validateInput(input)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const snapshot: TaskSnapshot = {
      taskId: id,
      status: 'queued',
      logs: [],
      lanes: input.testTypes.map((type) => ({ type, status: 'pending', summary: '等待执行' })),
      artifacts: []
    }
    this.addLog(snapshot, 'info', `任务进入队列，触发方式：${triggerType}`)
    this.repository.saveTask(id, input, snapshot, triggerType, createdAt)
    this.queue.push({ id, input, triggerType, createdAt })
    this.publish(snapshot)
    void this.drain()
    return { taskId: id }
  }

  getTask(id: string): TaskSnapshot | null { return this.repository.getTask(id)?.snapshot ?? null }
  getArtifactPath(id: string, artifact: string): string | null {
    const saved = this.repository.getTask(id)
    if (!saved || !saved.snapshot.artifacts.includes(artifact)) return null
    const root = resolve(saved.input.projectPath)
    const absolute = resolve(root, artifact)
    return absolute.startsWith(`${root}\\`) && existsSync(absolute) ? absolute : null
  }
  listTasks(limit = 100): TaskSnapshot[] { return this.repository.listTasks(Math.min(Math.max(limit, 1), 1000)) }
  getRuntime(): { provider: string | null; concurrency: number; queued: number; running: number } {
    return { provider: createAgentAdapter()?.name ?? null, concurrency: this.concurrency, queued: this.queue.length, running: this.running }
  }

  cancelTask(id: string): TaskSnapshot | null {
    const saved = this.repository.getTask(id)
    if (!saved) return null
    if (['completed', 'failed', 'cancelled'].includes(saved.snapshot.status)) return saved.snapshot
    const queueIndex = this.queue.findIndex((task) => task.id === id)
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
    this.controllers.get(id)?.abort()
    saved.snapshot.status = 'cancelled'
    this.addLog(saved.snapshot, 'warning', '任务已取消')
    this.saveAndPublish(saved.input, saved.snapshot, saved.triggerType, saved.createdAt)
    return saved.snapshot
  }

  retryTask(id: string): { taskId: string } | null {
    const saved = this.repository.getTask(id)
    return saved ? this.createTask(saved.input, `retry:${id}`) : null
  }

  upsertProject(value: Omit<ProjectRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ProjectRecord {
    if (!value.name || !value.projectPath || !existsSync(value.projectPath)) throw new Error('项目名称和有效项目目录不能为空')
    const now = new Date().toISOString()
    const existing = value.id ? this.repository.getProject(value.id) : null
    const project: ProjectRecord = { ...value, id: value.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now }
    this.repository.saveProject(project)
    return project
  }

  listProjects(): ProjectRecord[] { return this.repository.listProjects() }

  createSchedule(projectId: string, intervalMinutes: number, enabled = true): ScheduleRecord {
    if (!this.repository.getProject(projectId)) throw new Error('项目不存在')
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) throw new Error('调度间隔至少为 1 分钟')
    const now = new Date().toISOString()
    const schedule: ScheduleRecord = { id: randomUUID(), projectId, intervalMinutes, enabled, nextRunAt: new Date(Date.now() + intervalMinutes * 60_000).toISOString(), createdAt: now, updatedAt: now }
    this.repository.saveSchedule(schedule)
    return schedule
  }

  listSchedules(): ScheduleRecord[] { return this.repository.listSchedules() }
  updateSchedule(id: string, changes: { intervalMinutes?: number; enabled?: boolean; nextRunAt?: string }): ScheduleRecord | null {
    const schedule = this.repository.listSchedules().find((item) => item.id === id)
    if (!schedule) return null
    if (changes.intervalMinutes !== undefined) {
      if (!Number.isInteger(changes.intervalMinutes) || changes.intervalMinutes < 1) throw new Error('调度间隔至少为 1 分钟')
      schedule.intervalMinutes = changes.intervalMinutes
    }
    if (changes.enabled !== undefined) schedule.enabled = changes.enabled
    schedule.nextRunAt = changes.nextRunAt ?? new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString()
    schedule.updatedAt = new Date().toISOString()
    this.repository.saveSchedule(schedule)
    return schedule
  }
  deleteSchedule(id: string): boolean { return this.repository.deleteSchedule(id) }

  private validateInput(input: TaskInput): void {
    if (!input.projectPath || !existsSync(input.projectPath)) throw new Error('项目目录不存在')
    if (!input.systemName || input.testTypes.length === 0) throw new Error('系统名称和测试类型不能为空')
  }

  private async drain(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      if (!task) return
      this.running += 1
      void this.execute(task).finally(() => { this.running -= 1; void this.drain() })
    }
  }

  private async execute(task: QueuedTask): Promise<void> {
    const saved = this.repository.getTask(task.id)
    if (!saved || saved.snapshot.status === 'cancelled') return
    const snapshot = saved.snapshot
    const adapter = createAgentAdapter()
    const controller = new AbortController()
    this.controllers.set(task.id, controller)
    try {
      if (!adapter) throw new Error('没有可用的真实 Agent Provider')
      snapshot.status = 'planning'
      this.addLog(snapshot, 'info', `使用 Provider：${adapter.name}`)
      snapshot.status = 'running'
      snapshot.lanes.forEach((lane) => { lane.status = 'running'; lane.summary = '真实测试执行中' })
      this.saveAndPublish(task.input, snapshot, task.triggerType, task.createdAt)
      const result = await adapter.run(task.input, (event) => this.handleAgentEvent(task, snapshot, event), controller.signal)
      if (controller.signal.aborted) return
      snapshot.lanes = result.lanes
      snapshot.artifacts = result.artifacts
      snapshot.report = result.report
      snapshot.status = 'completed'
      this.addLog(snapshot, result.report.failed === 0 ? 'success' : 'warning', '真实测试执行结束')
    } catch (error) {
      if (controller.signal.aborted) snapshot.status = 'cancelled'
      else snapshot.status = 'failed'
      this.addLog(snapshot, snapshot.status === 'cancelled' ? 'warning' : 'error', error instanceof Error ? error.message : '未知执行错误')
    } finally {
      this.controllers.delete(task.id)
      this.saveAndPublish(task.input, snapshot, task.triggerType, task.createdAt)
    }
  }

  private handleAgentEvent(task: QueuedTask, snapshot: TaskSnapshot, event: AgentEvent): void {
    this.addLog(snapshot, event.level, event.message)
    this.saveAndPublish(task.input, snapshot, task.triggerType, task.createdAt)
  }

  private addLog(snapshot: TaskSnapshot, level: TaskLog['level'], message: string): void {
    snapshot.logs.push({ id: randomUUID(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level, message })
  }

  private saveAndPublish(input: TaskInput, snapshot: TaskSnapshot, triggerType: string, createdAt: string): void {
    this.repository.saveTask(snapshot.taskId, input, snapshot, triggerType, createdAt)
    this.publish(snapshot)
  }

  private publish(snapshot: TaskSnapshot): void { this.events.emit('task', structuredClone(snapshot)) }

  private runDueSchedules(): void {
    const now = Date.now()
    for (const schedule of this.repository.listSchedules()) {
      if (!schedule.enabled || Date.parse(schedule.nextRunAt) > now) continue
      const project = this.repository.getProject(schedule.projectId)
      if (project) this.createTask({ projectPath: project.projectPath, systemName: project.name, version: project.defaultVersion, testTypes: project.defaultTestTypes }, `schedule:${schedule.id}`)
      schedule.nextRunAt = new Date(now + schedule.intervalMinutes * 60_000).toISOString()
      schedule.updatedAt = new Date().toISOString()
      this.repository.saveSchedule(schedule)
    }
  }
}
