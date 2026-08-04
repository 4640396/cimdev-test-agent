import { spawn } from 'node:child_process'
import type { TaskInput } from '../../../../contracts/src/contracts.js'
import type { AgentAdapter, AgentEvent, AgentRunResult } from '../agent/types.js'

export class ProcessCimiCodeAdapter implements AgentAdapter {
  readonly name = 'CimiCode'
  constructor(
    private readonly executable: string,
    private readonly baseArgs: string[] = []
  ) {}

  run(input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, this.baseArgs, {
        cwd: input.projectPath,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })

      const prompt = [
        '执行测试 Agent 任务。',
        `系统：${input.systemName}`,
        `版本：${input.version}`,
        `测试类型：${input.testTypes.join(', ')}`,
        '生成测试计划，调用真实测试工具，并输出结构化结果。'
      ].join('\n')

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => emit({ level: 'info', message: chunk.trim() }))
      child.stderr.on('data', (chunk: string) => emit({ level: 'warning', message: chunk.trim() }))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) reject(new Error('CimiCode 尚未定义结构化测试结果协议，不能作为真实执行结果'))
        else reject(new Error(`CimiCode exited with code ${code ?? 'unknown'}`))
      })
      child.stdin.end(prompt)
    })
  }
}

export function createCimiCodeAdapter(): AgentAdapter | null {
  if (process.env.CIMICODE_ENABLE_REAL !== 'true') return null
  const executable = process.env.CIMICODE_EXECUTABLE
  if (!executable) throw new Error('CIMICODE_EXECUTABLE is required when real mode is enabled')
  const args = process.env.CIMICODE_ARGS_JSON
    ? (JSON.parse(process.env.CIMICODE_ARGS_JSON) as string[])
    : []
  return new ProcessCimiCodeAdapter(executable, args)
}
