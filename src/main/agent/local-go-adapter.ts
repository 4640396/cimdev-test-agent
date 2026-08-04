import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TaskInput } from '../../shared/contracts.js'
import type { AgentAdapter, AgentEvent, AgentRunResult } from './types.js'

interface GoEvent {
  Action?: string
  Package?: string
  Test?: string
  Output?: string
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function run(executable: string, args: string[], cwd: string, emit: (event: AgentEvent) => void): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      const errorText = stderr.join('').trim()
      if (errorText) emit({ level: 'warning', message: errorText })
      resolve({ code: code ?? 1, stdout: stdout.join(''), stderr: stderr.join('') })
    })
  })
}

function findGo(projectPath: string): string | null {
  const candidates = [
    join(projectPath, '.preview-toolchain', 'go', 'bin', 'go.exe'),
    join(projectPath, '.toolchain', 'go', 'bin', 'go.exe')
  ]
  return candidates.find(existsSync) ?? null
}

export class LocalGoAdapter implements AgentAdapter {
  readonly name = 'Local Go Runner'

  async run(input: TaskInput, emit: (event: AgentEvent) => void): Promise<AgentRunResult> {
    if (input.testTypes.length !== 1 || input.testTypes[0] !== 'unit') {
      throw new Error('本地 Go Runner 当前仅支持单元测试，请只选择“单元测试”')
    }
    const go = findGo(input.projectPath)
    if (!go) throw new Error('未找到项目本地 Go 工具链')
    const modules = ['portal', 'gateway'].filter((name) => existsSync(join(input.projectPath, name, 'go.mod')))
    if (modules.length === 0) throw new Error('未发现 portal 或 gateway Go module')

    let passed = 0
    let failed = 0
    const rawLogs: string[] = []
    for (const module of modules) {
      emit({ level: 'info', message: `执行真实测试：${module} / go test -json -cover ./...` })
      const result = await run(go, ['test', '-json', '-cover', './...'], join(input.projectPath, module), emit)
      rawLogs.push(`===== ${module} =====\n${result.stdout}\n${result.stderr}`)
      for (const line of result.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line) as GoEvent
          if (!event.Test) continue
          if (event.Action === 'pass') passed += 1
          if (event.Action === 'fail') failed += 1
        } catch {
          // go test may include non-JSON tool output; it remains in the raw log.
        }
      }
      if (result.code !== 0 && failed === 0) failed += 1
      emit({ level: result.code === 0 ? 'success' : 'error', message: `${module} 测试${result.code === 0 ? '通过' : '失败'}（退出码 ${result.code}）` })
    }

    const outputDir = join(input.projectPath, '.test-agent', 'results', new Date().toISOString().replace(/[:.]/g, '-'))
    mkdirSync(outputDir, { recursive: true })
    const rawLogPath = join(outputDir, 'go-test.jsonl')
    const reportPath = join(outputDir, 'report.json')
    writeFileSync(rawLogPath, rawLogs.join('\n'), 'utf8')
    const report = { passed, failed, coverage: null as number | null }
    writeFileSync(reportPath, JSON.stringify({ system: input.systemName, version: input.version, modules, report }, null, 2), 'utf8')
    const artifacts = [relative(input.projectPath, rawLogPath), relative(input.projectPath, reportPath)]
    return {
      lanes: [{ type: 'unit', status: failed === 0 ? 'passed' : 'failed', summary: `${passed} 个测试通过，${failed} 个测试失败` }],
      report,
      artifacts
    }
  }
}
