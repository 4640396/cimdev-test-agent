import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { TaskInput } from '../../../../contracts/src/contracts.js'
import type { AgentAdapter, AgentEvent, AgentRunResult } from './types.js'

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    lanes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['unit', 'regression', 'ui'] },
          status: { type: 'string', enum: ['passed', 'failed'] },
          summary: { type: 'string' }
        },
        required: ['type', 'status', 'summary'],
        additionalProperties: false
      }
    },
    report: {
      type: 'object',
      properties: {
        passed: { type: 'integer', minimum: 0 },
        failed: { type: 'integer', minimum: 0 },
        coverage: { anyOf: [{ type: 'number', minimum: 0, maximum: 100 }, { type: 'null' }] }
      },
      required: ['passed', 'failed', 'coverage'],
      additionalProperties: false
    },
    artifacts: { type: 'array', items: { type: 'string' } }
  },
  required: ['lanes', 'report', 'artifacts'],
  additionalProperties: false
} as const

function buildPrompt(input: TaskInput, outputDirectory: string): string {
  return [
    '你是 CIMDEV Test Agent 的测试执行代理。必须在当前项目内完成真实测试，不得虚构结果。',
    `系统：${input.systemName}`,
    `版本：${input.version || '未识别'}`,
    `测试类型：${input.testTypes.join(', ')}`,
    `测试产物目录：${outputDirectory}`,
    '',
    '执行要求：',
    '1. 识别项目技术栈、模块、现有测试框架和可用构建命令。',
    '2. 仅为选中的测试类型生成或补强必要测试；尽量不修改生产代码。',
    '3. 必须调用项目真实工具执行测试，例如 go test、Maven、Gradle、npm、Vitest 或 Playwright。',
    '4. 单元测试必须编译、执行并包含有业务意义的断言；仅判空断言不能视为有效用例。',
    '5. 回归测试必须基于真实核心场景或已有回归基线；没有可执行条件时标记失败并说明原因。',
    '6. UI 测试必须真实启动或连接应用并执行浏览器操作；成功执行时保存截图，否则标记失败。',
    '7. passed、failed 和 coverage 只能来自真实测试工具输出；没有覆盖率数据时返回 null。',
    '8. 将测试计划、原始日志和综合报告保存到指定产物目录。',
    '9. artifacts 只返回当前项目内确实存在的相对路径。',
    '10. 最终严格按输出 Schema 返回，不要把计划或推测写成测试结果。'
  ].join('\n')
}

function messageFromEvent(value: unknown): AgentEvent | null {
  if (!value || typeof value !== 'object') return null
  const event = value as Record<string, unknown>
  if (event.type === 'error') {
    return { level: 'error', message: String(event.message ?? 'Codex CLI 返回错误') }
  }
  const item = event.item as Record<string, unknown> | undefined
  if (!item) return null
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return { level: 'info', message: item.text }
  }
  if (item.type === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '项目测试命令'
    const status = typeof item.status === 'string' ? item.status : 'running'
    return { level: status === 'failed' ? 'error' : 'info', message: `Codex ${status}: ${command}` }
  }
  if (item.type === 'file_change') return { level: 'info', message: 'Codex 已更新测试文件' }
  return null
}

function validateResult(value: unknown, projectPath: string): AgentRunResult {
  if (!value || typeof value !== 'object') throw new Error('Codex CLI 未返回结构化测试结果')
  const result = value as AgentRunResult
  if (!Array.isArray(result.lanes) || !result.report || !Array.isArray(result.artifacts)) {
    throw new Error('Codex CLI 测试结果结构不完整')
  }
  for (const artifact of result.artifacts) {
    const absolute = resolve(projectPath, artifact)
    const root = resolve(projectPath)
    if (!(absolute === root || absolute.startsWith(`${root}\\`)) || !existsSync(absolute)) {
      throw new Error(`Codex CLI 返回了不存在或越界的产物：${artifact}`)
    }
  }
  return result
}

export function resolveCodexExecutable(): string | null {
  if (process.env.CODEX_CLI_EXECUTABLE && existsSync(process.env.CODEX_CLI_EXECUTABLE)) {
    return process.env.CODEX_CLI_EXECUTABLE
  }
  if (!process.env.APPDATA) return null
  const command = join(process.env.APPDATA, 'npm', 'codex.cmd')
  return existsSync(command) ? command : null
}

export class CodexCliAdapter implements AgentAdapter {
  readonly name = 'Codex CLI'

  constructor(private readonly executable: string) {}

  run(input: TaskInput, emit: (event: AgentEvent) => void, signal?: AbortSignal): Promise<AgentRunResult> {
    return new Promise((resolveRun, reject) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputDirectory = join(input.projectPath, '.test-agent', 'results', stamp)
      mkdirSync(outputDirectory, { recursive: true })
      const schemaPath = join(outputDirectory, 'result-schema.json')
      const resultPath = join(outputDirectory, 'codex-result.json')
      const eventsPath = join(outputDirectory, 'codex-events.jsonl')
      writeFileSync(schemaPath, JSON.stringify(RESULT_SCHEMA, null, 2), 'utf8')

      const args = [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'workspace-write',
        '--output-schema', schemaPath,
        '--output-last-message', resultPath,
        buildPrompt(input, relative(input.projectPath, outputDirectory))
      ]
      const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : this.executable
      const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', this.executable, ...args] : args
      const child = spawn(command, commandArgs, {
        cwd: input.projectPath,
        env: { ...process.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const eventLines: string[] = []
      let stdoutBuffer = ''
      let stderrBuffer = ''
      let settled = false
      const finishError = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const timer = setTimeout(() => {
        child.kill()
        finishError(new Error('Codex CLI 执行超过 30 分钟，任务已终止'))
      }, Number(process.env.CODEX_CLI_TIMEOUT_MS ?? 30 * 60 * 1000))
      const abort = (): void => {
        child.kill()
        finishError(new Error('任务已取消'))
      }
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })

      const consumeLine = (line: string): void => {
        if (!line.trim()) return
        eventLines.push(line)
        try {
          const message = messageFromEvent(JSON.parse(line))
          if (message) emit(message)
        } catch {
          emit({ level: 'warning', message: `Codex 输出了非 JSON 事件：${line.slice(0, 300)}` })
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        lines.forEach(consumeLine)
      })
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk
        const lines = stderrBuffer.split(/\r?\n/)
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) emit({ level: 'warning', message: line })
      })
      child.on('error', finishError)
      child.on('exit', (code) => {
        signal?.removeEventListener('abort', abort)
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer)
        if (stderrBuffer.trim()) emit({ level: 'warning', message: stderrBuffer.trim() })
        writeFileSync(eventsPath, `${eventLines.join('\n')}\n`, 'utf8')
        if (code !== 0) return reject(new Error(`Codex CLI 执行失败，退出码 ${code ?? 'unknown'}`))
        try {
          const result = validateResult(JSON.parse(readFileSync(resultPath, 'utf8')), input.projectPath)
          const ownArtifacts = [relative(input.projectPath, resultPath), relative(input.projectPath, eventsPath)]
          result.artifacts = [...new Set([...result.artifacts, ...ownArtifacts])]
          emit({ level: 'success', message: 'Codex CLI 已返回经过真实执行的结构化测试结果' })
          resolveRun(result)
        } catch (error) {
          reject(error)
        }
      })
    })
  }
}
