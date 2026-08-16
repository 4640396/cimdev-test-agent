import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { TestCase } from './router.js'
import { assertInsideProject, sandboxEnvironment } from './sandbox.js'

function spawnSandboxed(
  sandbox: { confine(argv: readonly string[], policy: unknown): { argv: string[] } } | undefined,
  command: string,
  args: string[],
  options: import('node:child_process').SpawnSyncOptions
): import('node:child_process').SpawnSyncReturns<string> {
  const argv = sandbox ? sandbox.confine([command, ...args], { mode: 'workspace-write', workspaceRoot: String(options.cwd ?? process.cwd()) }).argv : [command, ...args]
  return spawnSync(argv[0] ?? command, argv.slice(1), options) as import('node:child_process').SpawnSyncReturns<string>
}

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
  uiSteps?: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; durationMs?: number; screenshot?: string; error?: string }>
  recording?: { video?: string; trace?: string }
}

export interface UiRunOptions {
  entryUrl?: string
  env?: Record<string, string>
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

function packageTestScript(projectPath: string): string | null {
  const packagePath = join(projectPath, 'package.json')
  if (!existsSync(packagePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> }
    return parsed.scripts?.test?.trim() || null
  } catch {
    return null
  }
}

function parseVitestStats(raw: string): { tests: number; pass: number; fail: number } {
  const passMatch = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(raw)
  const failMatch = /Tests\s+(\d+)\s+failed/.exec(raw)
  const pass = passMatch ? Number(passMatch[1]) : 0
  const total = passMatch ? Number(passMatch[2]) : 0
  const fail = failMatch ? Number(failMatch[1]) : 0
  return { tests: total || pass + fail, pass, fail }
}

/** 独立重跑 node 单元测试（真实执行，不信任 Agent 返回的数字）。 */
export function runNodeUnitTests(projectPath: string, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): NodeTestOutcome {
  assertInsideProject(projectPath, projectPath)
  const script = packageTestScript(projectPath)
  const result = script
    ? spawnSandboxed(sandbox, process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm test'] : ['test'], {
        cwd: projectPath,
        encoding: 'utf8',
        timeout: 180_000,
        windowsHide: true,
        env: sandboxEnvironment()
      })
    : spawnSandboxed(sandbox, 'node', ['--test', '--experimental-test-coverage'], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: sandboxEnvironment()
    })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (script) {
    const stats = parseVitestStats(raw)
    return {
      ok: result.status === 0 && stats.fail === 0,
      tests: stats.tests,
      pass: stats.pass,
      fail: stats.fail,
      coverage: null,
      compileError: result.status !== 0 && /Cannot find module|SyntaxError|ERR_MODULE_NOT_FOUND|TypeError/.test(raw),
      raw,
      branchCoverage: null,
      failedCases: [],
      riskPoints: []
    }
  }
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
export async function runMavenUnitTests(projectPath: string, signal?: AbortSignal, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): Promise<MavenTestOutcome> {
  return runMavenCommand(projectPath, mavenCommandSpec(projectPath), signal, sandbox)
}

export function mavenCommandSpec(projectPath: string, platform: NodeJS.Platform = process.platform): MavenCommandSpec {
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'mvn.cmd test'], cwd: projectPath }
    : { command: 'mvn', args: ['test'], cwd: projectPath }
}

/** Execute one Maven command and normalize process, Surefire and cancellation outcomes. */
export async function runMavenCommand(projectPath: string, spec: MavenCommandSpec, signal?: AbortSignal, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): Promise<MavenTestOutcome> {
  signal?.throwIfAborted()
  assertInsideProject(projectPath, spec.cwd)
  const command = sandbox
    ? sandbox.confine([spec.command, ...spec.args], { mode: 'workspace-write', workspaceRoot: projectPath }).argv
    : [spec.command, ...spec.args]
  const commandName = command[0] ?? spec.command
  const commandArgs = command.slice(1)
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
  const child = spawn(commandName, commandArgs, { cwd: spec.cwd, env: scrubExecutionEnvironment(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
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
  details: Array<{ caseId: string; method: string; path: string; status: string; statusCode?: number; durationMs?: number; reason?: string }>
}

function findApiTarget(caseItem: TestCase): { method: string; path: string } | null {
  const candidates = [caseItem.scenario, ...caseItem.steps].join('\n')
  const match = candidates.match(/["']?(\/[a-zA-Z0-9_\-/{}]+)["']?/)
  if (!match) return null
  const text = `${caseItem.title} ${candidates}`.toLowerCase()
  const method = text.includes('post') || text.includes('创建') || text.includes('新增') || text.includes('提交')
    ? 'POST'
    : text.includes('put') || text.includes('更新') || text.includes('修改')
      ? 'PUT'
      : text.includes('delete') || text.includes('删除')
        ? 'DELETE'
        : 'GET'
  return { method, path: match[1] }
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
export async function runApiCases(cases: TestCase[], baseUrl: string, headers: Record<string, string> = {}): Promise<ApiCaseOutcome> {
  let pass = 0
  let fail = 0
  let skipped = 0
  const details: ApiCaseOutcome['details'] = []
  const root = baseUrl.replace(/\/$/, '')
  for (const caseItem of cases) {
    const target = findApiTarget(caseItem)
    if (!target) {
      skipped += 1
      details.push({ caseId: caseItem.id, method: 'GET', path: '', status: 'skipped', reason: '未从用例提取到接口路径' })
      continue
    }
    const startedAt = Date.now()
    try {
      const response = await fetch(`${root}${target.path}`, {
        method: target.method,
        headers: { ...headers, ...(target.method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: target.method === 'GET' ? undefined : '{}',
        signal: AbortSignal.timeout(10_000)
      })
      await response.text()
      if (assertExpected(response.status, caseItem.expected)) {
        pass += 1
        details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'passed', statusCode: response.status, durationMs: Date.now() - startedAt })
      } else {
        fail += 1
        details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'failed', statusCode: response.status, durationMs: Date.now() - startedAt, reason: `expected=${caseItem.expected} got=${response.status}` })
      }
    } catch (error) {
      fail += 1
      details.push({ caseId: caseItem.id, method: target.method, path: target.path, status: 'failed', durationMs: Date.now() - startedAt, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { ok: fail === 0, pass, fail, skipped, details }
}

interface OpenApiSpec {
  paths?: Record<string, Record<string, { summary?: string; operationId?: string }>>
}

export async function loadOpenApiCases(openApiUrl: string): Promise<TestCase[]> {
  const parsed: OpenApiSpec = /^https?:\/\//i.test(openApiUrl)
    ? await fetch(openApiUrl, { signal: AbortSignal.timeout(15_000) }).then((response) => {
        if (!response.ok) throw new Error(`OpenAPI 文档请求失败：${response.status}`)
        return response.json() as Promise<OpenApiSpec>
      })
    : JSON.parse(readFileSync(openApiUrl, 'utf8')) as OpenApiSpec
  const cases: TestCase[] = []
  for (const [path, pathItem] of Object.entries(parsed.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      const operation = pathItem?.[method]
      if (!operation) continue
      const upper = method.toUpperCase()
      const title = operation.summary || `${upper} ${path}`
      cases.push({
        id: `${method}-${cases.length + 1}`,
        title,
        scenario: `${upper} ${path}`,
        steps: [`请求 ${upper} ${path}`, '校验响应状态码'],
        expected: '200 成功',
        priority: method === 'get' ? 'high' : 'medium',
        layer: 'api',
        source: openApiUrl
      })
    }
  }
  return cases
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

function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

type PlaywrightStepStatus = 'passed' | 'failed' | 'skipped'

interface PlaywrightAttachment {
  name?: string
  path?: string
  contentType?: string
}

interface PlaywrightStep {
  title?: string
  status?: PlaywrightStepStatus | 'timedOut' | 'interrupted'
  duration?: number
  error?: { message?: string }
}

interface PlaywrightTestResult {
  status?: PlaywrightStepStatus | 'timedOut' | 'interrupted'
  duration?: number
  error?: { message?: string }
  steps?: PlaywrightStep[]
  attachments?: PlaywrightAttachment[]
}

interface PlaywrightTest {
  title?: string
  results?: PlaywrightTestResult[]
}

interface PlaywrightSpec {
  title?: string
  tests?: PlaywrightTest[]
}

interface PlaywrightSuite {
  specs?: PlaywrightSpec[]
}

interface ParsedPlaywrightStep {
  name: string
  status: PlaywrightStepStatus
  durationMs: number
  error?: string
  screenshot?: string
}

interface ParsedPlaywrightTest {
  title: string
  status: PlaywrightStepStatus
  durationMs: number
  error?: string
  steps: ParsedPlaywrightStep[]
  screenshots: string[]
  video?: string
  trace?: string
}

interface ParsedPlaywrightReport {
  stats: { tests: number; pass: number; fail: number; flaky: number; skipped: number }
  tests: ParsedPlaywrightTest[]
}

function normalizePlaywrightStatus(status: string | undefined): PlaywrightStepStatus {
  if (status === 'passed' || status === 'failed' || status === 'skipped') return status
  return 'failed'
}

function firstAttachmentPath(attachments: PlaywrightAttachment[] | undefined, predicate: (attachment: PlaywrightAttachment) => boolean): string | undefined {
  return (attachments ?? []).find(predicate)?.path
}

function imageAttachmentPaths(attachments: PlaywrightAttachment[] | undefined): string[] {
  return (attachments ?? []).filter((attachment) => attachment.contentType?.startsWith('image/') && attachment.path).map((attachment) => attachment.path as string)
}

export function parsePlaywrightReport(stdout: string): ParsedPlaywrightReport {
  const empty = { stats: { tests: 0, pass: 0, fail: 0, flaky: 0, skipped: 0 }, tests: [] as ParsedPlaywrightTest[] }
  const jsonText = firstJsonObject(stdout)
  if (!jsonText) return empty
  try {
    const parsed = JSON.parse(jsonText) as { stats?: Record<string, unknown>; suites?: PlaywrightSuite[]; tests?: PlaywrightTest[] }
    const stats = parsed.stats ?? {}
    const testEntries = (parsed.suites ?? []).flatMap((suite) => (suite.specs ?? []).flatMap((spec) => (spec.tests ?? []).map((test) => ({ specTitle: spec.title, test }))))
    const tests = testEntries.map(({ specTitle, test }) => {
      const result = test.results?.[0]
      const status = normalizePlaywrightStatus(result?.status)
      const screenshots = imageAttachmentPaths(result?.attachments)
      const steps = (result?.steps ?? []).map((step) => {
        const stepStatus = step.status ? normalizePlaywrightStatus(step.status) : 'passed'
        const status = step.error?.message ? 'failed' : stepStatus
        return {
          name: step.title ?? '未命名步骤',
          status,
          durationMs: Number(step.duration ?? 0),
          ...(step.error?.message ? { error: step.error.message } : {}),
          ...(status === 'failed' && screenshots.length > 0 ? { screenshot: screenshots[0] } : {})
        }
      })
      return {
        title: specTitle ?? test.title ?? '未命名测试',
        status,
        durationMs: Number(result?.duration ?? 0),
        ...(result?.error?.message ? { error: result.error.message } : {}),
        steps,
        screenshots,
        video: firstAttachmentPath(result?.attachments, (attachment) => attachment.name === 'video'),
        trace: firstAttachmentPath(result?.attachments, (attachment) => attachment.name === 'trace')
      }
    })
    return {
      stats: {
        tests: Number(stats.expected ?? 0) + Number(stats.unexpected ?? 0) + Number(stats.flaky ?? 0) + Number(stats.skipped ?? 0),
        pass: Number(stats.expected ?? 0),
        fail: Number(stats.unexpected ?? 0),
        flaky: Number(stats.flaky ?? 0),
        skipped: Number(stats.skipped ?? 0)
      },
      tests
    }
  } catch {
    return empty
  }
}

function relativeToProject(projectPath: string, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined
  const absolute = isAbsolute(filePath) ? filePath : join(projectPath, filePath)
  return relative(projectPath, absolute).replace(/\\/g, '/')
}

function runProjectPlaywright(projectPath: string, cli: string, options: UiRunOptions, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): NodeTestOutcome {
  const projectCli = join(projectPath, 'node_modules', '@playwright', 'test', 'cli.js')
  const resolvedCli = existsSync(projectCli) ? projectCli : cli
  const entryUrl = options.entryUrl?.trim() ? options.entryUrl : undefined
  const runEnv: NodeJS.ProcessEnv = { ...sandboxEnvironment(process.env), ...(options.env ?? {}) }
  if (entryUrl) runEnv.TEST_AGENT_UI_ENTRY_URL = entryUrl
  const result = spawnSandboxed(sandbox, 'node', [resolvedCli, 'test', '--reporter=json', '--trace=on'], {
    cwd: projectPath,
    encoding: 'utf8',
    timeout: 300_000,
    windowsHide: true,
    env: runEnv
  })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const report = parsePlaywrightReport(result.stdout ?? '')
  const uiSteps = report.tests.flatMap((test) => {
    if (test.steps.length > 0) return test.steps
    return [{
      name: test.title,
      status: test.status,
      durationMs: test.durationMs,
      ...(test.error ? { error: test.error } : {}),
      ...(test.status === 'failed' && test.screenshots.length > 0 ? { screenshot: relativeToProject(projectPath, test.screenshots[0]) } : {})
    }]
  }).map((step) => ({
    name: step.name,
    status: step.status,
    durationMs: step.durationMs,
    ...(step.error ? { error: step.error } : {}),
    ...(step.screenshot ? { screenshot: relativeToProject(projectPath, step.screenshot) } : {})
  }))
  const screenshots = [...new Set(report.tests.flatMap((test) => test.screenshots).map((path) => relativeToProject(projectPath, path)))].filter((path): path is string => Boolean(path))
  const video = report.tests.map((test) => test.video).find((path) => Boolean(path))
  const trace = report.tests.map((test) => test.trace).find((path) => Boolean(path))
  const genericOutcome = runGenericPlaywrightSmoke(projectPath, cli, options)
  return {
    ok: result.status === 0,
    ...report.stats,
    coverage: null,
    compileError: false,
    raw,
    screenshots: [...new Set([...screenshots, ...(genericOutcome.screenshots ?? [])])],
    uiSteps: genericOutcome.uiSteps?.length ? genericOutcome.uiSteps : uiSteps,
    recording: {
      video: genericOutcome.recording?.video ?? relativeToProject(projectPath, video),
      trace: genericOutcome.recording?.trace ?? relativeToProject(projectPath, trace)
    }
  }
}

function runGenericPlaywrightSmoke(projectPath: string, cli: string, options: UiRunOptions, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): NodeTestOutcome {
  const stamp = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scaffoldRoot = join(process.cwd(), '.test-agent-pw', stamp)
  const screenshotDir = join(projectPath, '.test-agent', 'screenshots', stamp)
  const outputDir = join(projectPath, '.test-agent', 'ui-output', stamp)
  const entryUrl = options.entryUrl?.trim() ? options.entryUrl : undefined
  const baseUrl = entryUrl ?? 'http://127.0.0.1:5199'
  const webServerBlock = entryUrl
    ? ''
    : `  webServer: {
    command: 'cmd /c "cd /d ' + project + ' && npm run dev -- --host 127.0.0.1 --port 5199"',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 180000
  },
`
  mkdirSync(join(scaffoldRoot, 'tests'), { recursive: true })
  mkdirSync(screenshotDir, { recursive: true })
  writeFileSync(join(scaffoldRoot, 'package.json'), '{"type":"module"}', 'utf8')
  writeFileSync(join(scaffoldRoot, 'pw.config.js'), `
const project = ${JSON.stringify(projectPath)}
export default {
  testDir: './tests',
  outputDir: ${JSON.stringify(outputDir)},
  timeout: 120000,
  fullyParallel: false,
  use: { baseURL: ${JSON.stringify(baseUrl)}, channel: 'msedge', headless: true, trace: 'on', video: 'on' },
  screenshot: 'only-on-failure',
${webServerBlock}  reporter: [['json']]
}
`, 'utf8')
  writeFileSync(join(scaffoldRoot, 'tests', 'smoke.spec.js'), `
import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
const shotDir = process.env.TEST_AGENT_SCREENSHOT_DIR
const steps = []
function record(name, file) {
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true })
    steps.push({ name, file })
    writeFileSync(shotDir + '/steps.json', JSON.stringify(steps, null, 2), 'utf8')
  }
}
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== 'passed' && shotDir) {
    await page.screenshot({ path: shotDir + '/99-failure.png', fullPage: true }).catch(() => {})
  }
})
test('frontend loads, fills and clicks', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('body')).not.toBeEmpty()
  const homeTitle = (await page.title()) || '未命名页面'
  await test.step('打开首页：' + homeTitle, async () => {
    record('打开首页：' + homeTitle, '01-home.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/01-home.png', fullPage: true })
  })
  const inputs = page.locator('input:not([type="hidden"]), textarea, select')
  const inputCount = Math.min(await inputs.count(), 5)
  await test.step('填写表单：' + inputCount + ' 个字段', async () => {
    if (inputCount > 0) {
      for (let i = 0; i < inputCount; i += 1) {
        const el = inputs.nth(i)
        const type = ((await el.getAttribute('type')) ?? '').toLowerCase()
        const tag = await el.evaluate((node) => node.tagName.toLowerCase())
        if (tag === 'select') {
          await el.selectOption({ index: 0 }).catch(() => {})
        } else if (type === 'checkbox' || type === 'radio') {
          await el.check().catch(() => {})
        } else {
          await el.fill(type === 'email' ? 'demo@example.com' : type === 'password' ? 'Test1234!' : 'demo value').catch(() => {})
        }
      }
    }
    record('填写表单：' + inputCount + ' 个字段', '02-form.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/02-form.png', fullPage: true })
  })
  const primary = page.locator('button[type="submit"], input[type="submit"], button:has-text("登录"), button:has-text("提交"), button:has-text("确定")')
  const target = (await primary.count()) > 0 ? primary.first() : page.locator('a[href], button, [role="button"]').first()
  const targetText = ((await target.textContent()) || '').trim() || '主要按钮'
  await test.step('点击按钮：' + targetText, async () => {
    await target.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(900)
    record('点击按钮：' + targetText, '03-after-click.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/03-after-click.png', fullPage: true })
  })
  await test.step('检查页面反馈', async () => {
    await expect(page.locator('body')).not.toBeEmpty()
    record('检查页面反馈', '04-result.png')
    if (shotDir) await page.screenshot({ path: shotDir + '/04-result.png', fullPage: true })
  })
})
`, 'utf8')
  try {
    const runEnv: NodeJS.ProcessEnv = { ...sandboxEnvironment(process.env), ...(options.env ?? {}), TEST_AGENT_SCREENSHOT_DIR: screenshotDir }
    if (entryUrl) runEnv.TEST_AGENT_UI_ENTRY_URL = entryUrl
    const result = spawnSandboxed(sandbox, 'node', [cli, 'test', '--config', join(scaffoldRoot, 'pw.config.js')], {
      cwd: scaffoldRoot,
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      env: runEnv
    })
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const report = parsePlaywrightReport(result.stdout ?? '')
    const manualScreenshots = existsSync(screenshotDir)
      ? readdirSync(screenshotDir).filter((name) => /\.(png|jpg|jpeg)$/i.test(name)).sort().map((name) => relative(projectPath, join(screenshotDir, name)))
      : []
    const attachmentScreenshots = report.tests.flatMap((test) => test.screenshots).map((path) => relativeToProject(projectPath, path)).filter((path): path is string => Boolean(path))
    const stepScreenshots = new Map<string, string>()
    const stepManifestPath = join(screenshotDir, 'steps.json')
    if (existsSync(stepManifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(stepManifestPath, 'utf8')) as Array<{ name: string; file: string }>
        for (const item of manifest) stepScreenshots.set(item.name, relative(projectPath, join(screenshotDir, item.file)))
      } catch {
        // 忽略步骤清单解析失败，不影响执行结果
      }
    }
    const screenshots = [...new Set([...manualScreenshots, ...attachmentScreenshots])]
    const failureShot = manualScreenshots.find((path) => path.includes('failure'))
    const uiSteps = report.tests.flatMap((test) => {
      if (test.steps.length > 0) {
        return test.steps.map((step) => {
          const stepShot = stepScreenshots.get(step.name)
          const resolvedShot = step.status === 'failed'
            ? attachmentScreenshots[0] ?? failureShot
            : stepShot
          return {
            name: step.name,
            status: step.status,
            durationMs: step.durationMs,
            ...(step.error ? { error: step.error } : {}),
            ...(resolvedShot ? { screenshot: resolvedShot } : {})
          }
        })
      }
      const failedShot = attachmentScreenshots[0] ?? failureShot
      return [{
        name: test.title,
        status: test.status,
        durationMs: test.durationMs,
        ...(test.error ? { error: test.error } : {}),
        ...(test.status === 'failed' && failedShot ? { screenshot: failedShot } : {})
      }]
    })
    const video = report.tests.map((test) => test.video).find((path) => Boolean(path))
    const trace = report.tests.map((test) => test.trace).find((path) => Boolean(path))
    return {
      ok: result.status === 0,
      ...report.stats,
      coverage: null,
      compileError: false,
      raw,
      screenshots,
      uiSteps,
      recording: { video: relativeToProject(projectPath, video), trace: relativeToProject(projectPath, trace) }
    }
  } finally {
    try {
      rmSync(scaffoldRoot, { recursive: true, force: true })
    } catch {
      // cleanup failure ignored
    }
  }
}

/** Independent Playwright UI verification: prefer the project's own config/tests, fall back to a generic smoke. */
export function runPlaywrightUiTests(projectPath: string, options: UiRunOptions = {}, sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }): NodeTestOutcome {
  assertInsideProject(projectPath, projectPath)
  const cli = resolveBundledPlaywrightCli()
  const config = findPlaywrightConfig(projectPath)
  return config ? runProjectPlaywright(projectPath, cli, options, sandbox) : runGenericPlaywrightSmoke(projectPath, cli, options, sandbox)
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
