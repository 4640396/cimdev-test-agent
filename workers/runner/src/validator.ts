import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface NodeTestOutcome {
  ok: boolean
  tests: number
  pass: number
  fail: number
  coverage: number | null
  compileError: boolean
  raw: string
}

export interface QualityMetrics {
  compileRate: number
  execRate: number
  assertRate: number
  effectiveRate: number
}

export interface AssertionCount {
  total: number
  withAssertions: number
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.test-agent', 'out', 'dist', '.test-agent-worker', 'legacy'])
const ASSERTION_PATTERN = /\b(assert|expect|should|deepStrictEqual|strictEqual|equal)\b/

function matchNumber(lines: string[], pattern: RegExp): number {
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return Number(match[1])
  }
  return 0
}

/** 独立重跑 node 单元测试（真实执行，不信任 Agent 返回的数字）。 */
export function runNodeUnitTests(projectPath: string): NodeTestOutcome {
  const result = spawnSync('node', ['--test', '--experimental-test-coverage'], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = raw.split(/\r?\n/)
  const tests = matchNumber(lines, /\btests\s+(\d+)/)
  const pass = matchNumber(lines, /\bpass\s+(\d+)/)
  const fail = matchNumber(lines, /\bfail\s+(\d+)/)
  const coverageIndex = lines.findIndex((line) => /all files/.test(line))
  let coverage: number | null = null
  if (coverageIndex >= 0) {
    const columns = lines[coverageIndex].split('|').map((item) => item.trim()).filter((item) => item.length > 0)
    if (columns.length >= 2) {
      const parsed = Number.parseFloat(columns[1])
      if (Number.isFinite(parsed)) coverage = parsed
    }
  }
  const compileError = result.status !== 0 && /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(raw)
  return { ok: result.status === 0, tests, pass, fail, coverage, compileError, raw }
}

/** 统计测试文件数与“含断言”的文件数（MVP 静态抽检，后续可换变异测试）。 */
export function countAssertionFiles(projectPath: string): AssertionCount {
  const files: string[] = []
  const collect = (dir: string, depth: number): void => {
    if (depth > 5) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (!SKIP_DIRS.has(basename(full))) collect(full, depth + 1)
      } else if (/\.test\.(js|mjs|cjs|ts)$/.test(entry)) {
        files.push(full)
      }
    }
  }
  collect(projectPath, 0)
  let withAssertions = 0
  for (const file of files) {
    try {
      if (ASSERTION_PATTERN.test(readFileSync(file, 'utf8'))) withAssertions += 1
    } catch {
      // 不可读文件跳过
    }
  }
  return { total: files.length, withAssertions }
}

/** 计算编译通过率 / 执行完成率 / 断言有效率 / 有效用例占比。 */
export function computeMetrics(outcome: NodeTestOutcome, assertions: AssertionCount): QualityMetrics {
  const compileRate = outcome.compileError ? 0 : outcome.ok ? 1 : 0
  const executed = outcome.pass + outcome.fail
  const execRate = outcome.tests > 0 ? executed / outcome.tests : 0
  const assertRate = assertions.total > 0 ? assertions.withAssertions / assertions.total : 0
  const effectiveRate = Math.round(execRate * assertRate * 1000) / 1000
  return { compileRate, execRate, assertRate, effectiveRate }
}
