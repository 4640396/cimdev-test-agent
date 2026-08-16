import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { TestCase } from './router.js'

export interface NodeTestOutcome {
  ok: boolean
  tests: number
  pass: number
  fail: number
  coverage: number | null
  compileError: boolean
  raw: string
  screenshots?: string[]
  branchCoverage?: number | null
  failedCases?: Array<{ name: string; layer: string; error: string }>
  riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
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

export interface MavenTestOutcome {
  ok: boolean
  tests: number
  pass: number
  fail: number
  coverage: number | null
  compileError: boolean
  raw: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  outputTruncated: boolean
}

export interface MavenCommandSpec {
  command: string
  args: string[]
  cwd: string
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.test-agent', 'out', 'dist', '.test-agent-worker', 'legacy', 'target'])
const ASSERTION_PATTERN = /\b(assert\w*|expect|should|deepStrictEqual|strictEqual|equal|verify)\b/i
const SENSITIVE_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i

/** Preserve toolchain environment while removing credentials owned by the Worker process. */
export function scrubExecutionEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && !SENSITIVE_ENV_NAME.test(name)))
}

function matchNumber(lines: string[], pattern: RegExp): number {
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return Number(match[1])
  }
  return 0
}

interface NodeCoverageTable {
  line: number | null
  branch: number | null
  files: Array<{ file: string; line: number; branch: number }>
}

function parseNodeCoverageTable(raw: string): NodeCoverageTable {
  const files: NodeCoverageTable['files'] = []
  let line: number | null = null
  let branch: number | null = null
  let currentDir = ''
  for (const rawLine of raw.split(/\r?\n/)) {
    const text = rawLine.replace(/^\s*ℹ\s*/, '').trim()
    if (!text.includes('|') || /^-+/.test(text)) continue
    const columns = text.split('|').map((item) => item.trim())
    if (columns.length < 4) continue
    const name = columns[0]
    const linePct = Number.parseFloat(columns[1])
    const branchPct = Number.parseFloat(columns[2])
    if (name.toLowerCase() === 'all files') {
      line = Number.isFinite(linePct) ? linePct : null
      branch = Number.isFinite(branchPct) ? branchPct : null
      continue
    }
    if (!name || name === 'file') continue
    if (!Number.isFinite(linePct) && !Number.isFinite(branchPct)) {
      currentDir = name
      continue
    }
    files.push({ file: currentDir ? `${currentDir}/${name}` : name, line: linePct, branch: branchPct })
  }
  return { line, branch, files }
}

function parseNodeFailures(raw: string): Array<{ name: string; layer: string; error: string }> {
  const failures: Array<{ name: string; layer: string; error: string }> = []
  let current: { name: string; layer: string; error: string } | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*ℹ\s*/, '')
    const failMatch = /^✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?$/.exec(line.trim())
    if (failMatch) {
      if (current) failures.push(current)
      current = { name: failMatch[1].trim(), layer: 'unit', error: '' }
      continue
    }
    if (!current) continue
    if (/^✔\s|^✖\s|^ℹ\s/.test(line.trim()) && !/^\s/.test(rawLine)) {
      failures.push(current)
      current = null
      continue
    }
    if (line.trim() && (/^\s/.test(rawLine) || /Error|Assertion|expected|actual|at /.test(line))) {
      current.error += (current.error ? '\n' : '') + line.trimEnd()
    }
  }
  if (current) failures.push(current)
  return failures
}

function buildNodeRiskPoints(table: NodeCoverageTable, failures: Array<{ name: string; layer: string; error: string }>): Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }> {
  const risks: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }> = []
  for (const file of table.files) {
    if (Number.isFinite(file.branch) && file.branch < 80) {
      risks.push({
        severity: file.branch < 50 ? 'high' : 'medium',
        file: file.file,
        message: `分支覆盖率 ${file.branch}%，存在未覆盖分支。`,
        suggestion: '补充边界与异常分支测试。'
      })
    } else if (Number.isFinite(file.line) && file.line < 80) {
      risks.push({
        severity: 'medium',
        file: file.file,
        message: `行覆盖率 ${file.line}%，存在未覆盖代码。`,
        suggestion: '补充核心逻辑测试。'
      })
    }
  }
  for (const failure of failures) {
    risks.push({ severity: 'high', file: failure.name, message: `测试失败：${failure.error.split('\n')[0] || failure.name}`, suggestion: '修复断言或被测代码。' })
  }
  return risks.slice(0, 10)
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
  const coverageTable = parseNodeCoverageTable(raw)
  const failedCases = parseNodeFailures(raw)
  const compileError = result.status !== 0 && /SyntaxError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(raw)
  return {
    ok: result.status === 0,
    tests,
    pass,
    fail,
    coverage: coverageTable.line,
    compileError,
    raw,
    branchCoverage: coverageTable.branch,
    failedCases,
    riskPoints: buildNodeRiskPoints(coverageTable, failedCases)
  }
}

/** 解析 surefire 报告的 Tests run / Failures / Errors 汇总行。 */
export function parseSurefireSummary(content: string): { tests: number; fail: number } | null {
  const match = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(content)
  if (!match) return null
  const run = Number(match[1])
  const failures = Number(match[2])
  const errors = Number(match[3])
  return { tests: run, fail: failures + errors }
}

/** 独立重跑 Maven 单元测试，从 surefire 报告解析结果（覆盖率未配置时为 null）。 */
export async function runMavenUnitTests(projectPath: string, signal?: AbortSignal): Promise<MavenTestOutcome> {
  return runMavenCommand(projectPath, mavenCommandSpec(projectPath), signal)
}

export function mavenCommandSpec(projectPath: string, platform: NodeJS.Platform = process.platform): MavenCommandSpec {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'mvn.cmd test'], cwd: projectPath }
    : { command: 'mvn', args: ['test'], cwd: projectPath }
}

/** Execute one Maven command and normalize process, Surefire and cancellation outcomes. */
export async function runMavenCommand(projectPath: string, spec: MavenCommandSpec, signal?: AbortSignal): Promise<MavenTestOutcome> {
  signal?.throwIfAborted()
  const MAX_OUTPUT = 1_000_000
  let raw = ''
  let outputTruncated = false
  const append = (chunk: Buffer): void => {
    raw += chunk.toString('utf8')
    if (raw.length > MAX_OUTPUT) {
      raw = raw.slice(-MAX_OUTPUT)
      outputTruncated = true
    }
  }
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: scrubExecutionEnvironment(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  let aborted = false
  const abort = (): void => {
    aborted = true
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => { child.kill('SIGKILL') })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const settled = await new Promise<{ exitCode: number | null; exitSignal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    child.once('error', (spawnError) => resolve({ exitCode: null, exitSignal: null, spawnError }))
    child.once('close', (exitCode, exitSignal) => resolve({ exitCode, exitSignal }))
  }).finally(() => signal?.removeEventListener('abort', abort))
  if (settled.spawnError) throw settled.spawnError
  let tests = 0
  let pass = 0
  let fail = 0
  const reportDir = join(projectPath, 'target', 'surefire-reports')
  try {
    for (const file of readdirSync(reportDir)) {
      if (!file.endsWith('.txt')) continue
      const content = readFileSync(join(reportDir, file), 'utf8')
      const summary = parseSurefireSummary(content)
      if (!summary) continue
      tests += summary.tests
      fail += summary.fail
      pass += summary.tests - summary.fail
    }
  } catch {
    // 无 surefire 报告（无测试或构建失败）
  }
  const compileError = settled.exitCode !== 0 && /BUILD FAILURE/.test(raw)
  return {
    ok: settled.exitCode === 0 && !aborted,
    tests,
    pass,
    fail,
    coverage: null,
    compileError,
    raw,
    exitCode: settled.exitCode,
    signal: settled.exitSignal,
    timedOut: signal?.reason instanceof Error && (signal.reason.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(signal.reason.message)),
    aborted,
    outputTruncated
  }
}

export interface ApiCaseOutcome {
  ok: boolean
  pass: number
  fail: number
  skipped: number
  details: Array<{ caseId: string; status: string; reason?: string }>
}

function findApiTarget(caseItem: TestCase): string | null {
  const candidates = [caseItem.scenario, ...caseItem.steps].join('\n')
  const match = candidates.match(/["']?(\/[a-zA-Z0-9_\-/{}]+)["']?/)
  return match ? match[1] : null
}

function assertExpected(status: number, expected: string): boolean {
  const text = expected.toLowerCase()
  if (text.includes('404')) return status === 404
  if (text.includes('401')) return status === 401
  if (text.includes('400')) return status === 400
  if (text.includes('200') || text.includes('成功') || text.includes('通过')) return status >= 200 && status < 300
  return status >= 200 && status < 300
}

/** 基础 API 执行器：从用例提取接口路径，发起 HTTP 请求并按 expected 断言。 */
export async function runApiCases(cases: TestCase[], baseUrl: string): Promise<ApiCaseOutcome> {
  let pass = 0
  let fail = 0
  let skipped = 0
  const details: ApiCaseOutcome['details'] = []
  const root = baseUrl.replace(/\/$/, '')
  for (const caseItem of cases) {
    const target = findApiTarget(caseItem)
    if (!target) {
      skipped += 1
      details.push({ caseId: caseItem.id, status: 'skipped', reason: '未从用例提取到接口路径' })
      continue
    }
    try {
      const response = await fetch(`${root}${target}`, { signal: AbortSignal.timeout(10_000) })
      await response.text()
      if (assertExpected(response.status, caseItem.expected)) {
        pass += 1
        details.push({ caseId: caseItem.id, status: 'passed' })
      } else {
        fail += 1
        details.push({ caseId: caseItem.id, status: 'failed', reason: `expected=${caseItem.expected} got=${response.status}` })
      }
    } catch (error) {
      fail += 1
      details.push({ caseId: caseItem.id, status: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: fail === 0, pass, fail, skipped, details }
}

/** 解析 Test Agent 内置的 Playwright CLI 路径（Worker 预置能力，被测项目无需安装）。 */
export function resolveBundledPlaywrightCli(): string {
  const fromEnv = process.env.TEST_AGENT_PLAYWRIGHT_CLI
  if (fromEnv) return fromEnv
  return join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js')
}

function findPlaywrightConfig(projectPath: string): string | undefined {
  const names = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
  for (const name of names) {
    const path = join(projectPath, name)
    if (existsSync(path)) return path
  }
  return undefined
}

function parsePlaywrightStats(raw: string): { tests: number; pass: number; fail: number } {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return { tests: 0, pass: 0, fail: 0 }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { stats?: { expected?: number; unexpected?: number; flaky?: number } }
    return {
      tests: Number(parsed.stats?.expected ?? 0) + Number(parsed.stats?.unexpected ?? 0) + Number(parsed.stats?.flaky ?? 0),
      pass: Number(parsed.stats?.expected ?? 0),
      fail: Number(parsed.stats?.unexpected ?? 0)
    }
  } catch {
    return { tests: 0, pass: 0, fail: 0 }
  }
}

function runProjectPlaywright(projectPath: string, cli: string): NodeTestOutcome {
  const projectCli = join(projectPath, 'node_modules', '@playwright', 'test', 'cli.js')
  const resolvedCli = existsSync(projectCli) ? projectCli : cli
  const result = spawnSync('node', [resolvedCli, 'test', '--reporter=json'], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true
  })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const stats = parsePlaywrightStats(raw)
  return { ok: result.status === 0, ...stats, coverage: null, compileError: false, raw }
}

function runGenericPlaywrightSmoke(projectPath: string, cli: string): NodeTestOutcome {
  const stamp = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scaffoldRoot = join(process.cwd(), '.test-agent-pw', stamp)
  const screenshotDir = join(projectPath, '.test-agent', 'screenshots', stamp)
  mkdirSync(join(scaffoldRoot, 'tests'), { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(join(scaffoldRoot, 'package.json'), '{"type":"module"}', 'utf8')
  writeFileSync(join(scaffoldRoot, 'pw.config.js'), `
const project = ${JSON.stringify(projectPath)}
export default {
  testDir: './tests',
  timeout: 120000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:5199', channel: 'msedge', headless: true },
  webServer: {
    command: 'cmd /c "cd /d ' + project + ' && npm run dev -- --host 127.0.0.1 --port 5199"',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 180000
  },
  reporter: [['json']]
}
`, 'utf8')
  writeFileSync(join(scaffoldRoot, 'tests', 'smoke.spec.js'), `
import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
const shotDir = process.env.TEST_AGENT_SCREENSHOT_DIR
test('frontend loads, clicks and screenshots', async ({ page }) => {
  if (shotDir) mkdirSync(shotDir, { recursive: true })
  await page.goto('/')
  await expect(page.locator('body')).not.toBeEmpty()
  if (shotDir) await page.screenshot({ path: shotDir + '/01-home.png', fullPage: true })
  const clickable = page.locator('a[href], button, [role="button"]')
  if (await clickable.count() > 0) {
    await clickable.first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)
    if (shotDir) await page.screenshot({ path: shotDir + '/02-after-click.png', fullPage: true })
  }
})
`, 'utf8')
  try {
    const result = spawnSync('node', [cli, 'test', '--config', join(scaffoldRoot, 'pw.config.js')], {
      cwd: scaffoldRoot,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      env: { ...process.env, TEST_AGENT_SCREENSHOT_DIR: screenshotDir }
    })
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const stats = parsePlaywrightStats(raw)
    const screenshots = existsSync(screenshotDir)
      ? readdirSync(screenshotDir).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).sort().map((name) => relative(projectPath, join(screenshotDir, name)))
      : []
    return { ok: result.status === 0, ...stats, coverage: null, compileError: false, raw, screenshots }
  } finally {
    try {
      rmSync(scaffoldRoot, { recursive: true, force: true })
    } catch {
      // cleanup failure ignored
    }
  }
}

/** Independent Playwright UI verification: prefer the project's own config/tests, fall back to a generic smoke. */
export function runPlaywrightUiTests(projectPath: string): NodeTestOutcome {
  const cli = resolveBundledPlaywrightCli()
  const config = findPlaywrightConfig(projectPath)
  return config ? runProjectPlaywright(projectPath, cli) : runGenericPlaywrightSmoke(projectPath, cli)
}

/** 统计测试文件数与“含断言”的文件数（MVP 静态抽检，后续可换变异测试）。 */
export function countAssertionFiles(projectPath: string): AssertionCount {
  const files: string[] = []
  const collect = (dir: string, depth: number): void => {
    if (depth > 30) return
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
      } else if (/(\.(test|spec)\.(js|mjs|cjs|ts)|(Test|Tests|IT)\.java)$/.test(entry)) {
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
