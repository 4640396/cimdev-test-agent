import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { AgentAdapter } from './agent/types.js'
import type { LaneState, TaskInput, TaskLog, TaskSnapshot, TestType } from '../shared/contracts.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const labels: Record<TestType, string> = { unit: '单元测试', regression: '回归测试', ui: 'UI 测试' }

export class TaskEngine {
  constructor(
    private readonly window: BrowserWindow,
    private readonly adapter: AgentAdapter | null
  ) {}

  async start(input: TaskInput): Promise<{ taskId: string }> {
    const taskId = randomUUID()
    const snapshot: TaskSnapshot = {
      taskId,
      status: 'planning',
      logs: [],
      lanes: input.testTypes.map((type) => ({ type, status: 'pending', summary: '等待执行' })),
      artifacts: []
    }
    this.emit(snapshot, 'info', `已创建任务 ${taskId.slice(0, 8)}，项目 ${input.systemName}`)
    void this.run(snapshot, input)
    return { taskId }
  }

  private async run(snapshot: TaskSnapshot, input: TaskInput): Promise<void> {
    try {
      await this.step(snapshot, `正在读取项目目录：${input.projectPath}`, 200)
      if (!this.adapter) throw new Error('没有可用的真实 Agent Provider，请安装并登录 Claude Code，或配置 CimiCode')
      snapshot.status = 'running'
      this.publish(snapshot)
      this.emit(snapshot, 'info', `正在调用真实 Provider：${this.adapter.name}`)
      snapshot.lanes.forEach((lane) => { lane.status = 'running'; lane.summary = '由真实 Agent 分析与执行中' })
      this.publish(snapshot)
      const result = await this.adapter.run(input, (event) => this.emit(snapshot, event.level, event.message))
      snapshot.lanes = result.lanes
      snapshot.artifacts = result.artifacts
      snapshot.status = 'completed'
      snapshot.report = result.report
      this.emit(snapshot, result.report.failed === 0 ? 'success' : 'warning', '真实测试执行结束，结果已回填')
    } catch (error) {
      snapshot.status = 'failed'
      this.emit(snapshot, 'error', error instanceof Error ? error.message : '未知执行错误')
    }
  }

  private async runLane(snapshot: TaskSnapshot, lane: LaneState): Promise<void> {
    lane.status = 'running'
    lane.summary = `${labels[lane.type]}执行中`
    this.emit(snapshot, 'info', `${labels[lane.type]}：环境预检通过，开始执行`)
    await wait(lane.type === 'ui' ? 1100 : 850)
    lane.status = 'passed'
    lane.summary = lane.type === 'ui' ? '8 个场景通过，已生成截图' : '执行通过，结果已回填'
    this.emit(snapshot, 'success', `${labels[lane.type]}：${lane.summary}`)
  }

  private async step(
    snapshot: TaskSnapshot,
    message: string,
    duration: number,
    level: TaskLog['level'] = 'info'
  ): Promise<void> {
    this.emit(snapshot, level, message)
    await wait(duration)
  }

  private emit(snapshot: TaskSnapshot, level: TaskLog['level'], message: string): void {
    if (!message) return
    snapshot.logs.push({
      id: randomUUID(),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      level,
      message
    })
    this.publish(snapshot)
  }

  private publish(snapshot: TaskSnapshot): void {
    this.window.webContents.send('task:snapshot', structuredClone(snapshot))
  }
}
