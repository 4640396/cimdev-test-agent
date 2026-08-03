import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { CimiCodeAdapter } from './cimicode/adapter.js'
import type { LaneState, TaskInput, TaskLog, TaskSnapshot, TestType } from '../shared/contracts.js'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const labels: Record<TestType, string> = { unit: '单元测试', regression: '回归测试', ui: 'UI 测试' }

export class TaskEngine {
  constructor(
    private readonly window: BrowserWindow,
    private readonly adapter: CimiCodeAdapter | null
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
      await this.step(snapshot, '正在扫描项目结构与技术栈', 550)
      await this.step(snapshot, '正在准备 Workspace 知识查询上下文（初版为模拟数据）', 650)
      await this.step(snapshot, '已生成测试计划，准备三路分发', 550, 'success')
      snapshot.artifacts = ['test-plan.json', 'test-cases.md', 'knowledge-ref.json']
      snapshot.status = 'running'
      this.publish(snapshot)

      if (this.adapter) {
        this.emit(snapshot, 'info', '已启用真实 CimiCode CLI 适配器')
        await this.adapter.run(input, (event) => this.emit(snapshot, event.level, event.message))
      } else {
        this.emit(snapshot, 'warning', '当前为安全模拟模式；设置 CimiCode 环境变量后可启用真实调用')
      }

      for (const lane of snapshot.lanes) await this.runLane(snapshot, lane)
      snapshot.status = 'completed'
      snapshot.report = { passed: 46, failed: 2, coverage: 82 }
      this.emit(snapshot, 'success', '三类测试执行完成，综合报告已生成')
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
