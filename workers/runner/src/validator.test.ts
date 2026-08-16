import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { computeMetrics, countAssertionFiles, mavenCommandSpec, parsePlaywrightReport, parseSurefireSummary, runApiCases, runMavenCommand, runNodeUnitTests, scrubExecutionEnvironment } from './validator.js'

const projects: string[] = []

it('uses the Windows Maven launcher instead of the extensionless Unix script', () => {
  expect(mavenCommandSpec('C:\\project', 'win32')).toEqual({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'mvn.cmd test'],
    cwd: 'C:\\project'
  })
})

it('parses Playwright JSON reporter into UI steps and recording artifacts', () => {
  const report = JSON.stringify({
    stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0 },
    suites: [{
      specs: [{
        title: 'login flow',
        tests: [{
          results: [{
            status: 'failed',
            duration: 1200,
            error: { message: 'login button not found' },
            steps: [
              { title: '打开登录页', duration: 200 },
              { title: '点击登录按钮', duration: 300, status: 'failed', error: { message: 'login button not found' } }
            ],
            attachments: [
              { name: 'screenshot', contentType: 'image/png', path: 'C:\\works\\app\\failure.png' },
              { name: 'video', contentType: 'video/webm', path: 'C:\\works\\app\\video.webm' },
              { name: 'trace', contentType: 'application/zip', path: 'C:\\works\\app\\trace.zip' }
            ]
          }]
        }]
      }]
    }]
  })
  const parsed = parsePlaywrightReport(report)
  expect(parsed.stats).toMatchObject({ tests: 2, pass: 1, fail: 1 })
  expect(parsed.tests[0]).toMatchObject({ title: 'login flow', status: 'failed', video: 'C:\\works\\app\\video.webm', trace: 'C:\\works\\app\\trace.zip' })
  expect(parsed.tests[0].steps).toEqual([
    expect.objectContaining({ name: '打开登录页', status: 'passed', durationMs: 200 }),
    expect.objectContaining({ name: '点击登录按钮', status: 'failed', error: 'login button not found', screenshot: 'C:\\works\\app\\failure.png' })
  ])
})

function makeProject(files: Record<string, string>): string {
  const root = join(tmpdir(), `cimdev-validator-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  projects.push(root)
  return root
}

afterAll(() => {
  for (const project of projects) {
    try {
      rmSync(project, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
})

describe('validator', () => {
  it('执行环境保留工具链变量但移除凭据', () => {
    expect(scrubExecutionEnvironment({ PATH: 'bin', JAVA_HOME: 'jdk', TEST_AGENT_API_TOKEN: 'secret', DB_PASSWORD: 'secret', AWS_ACCESS_KEY_ID: 'secret' }))
      .toEqual({ PATH: 'bin', JAVA_HOME: 'jdk' })
  })

  it('超时会终止受管根进程及其子进程树', { timeout: 15_000 }, async () => {
    const fixture = join(process.cwd(), 'workers', 'runner', 'src', 'fixtures', 'slow-process.cjs')
    const outcome = await runMavenCommand(process.cwd(), { command: process.execPath, args: [fixture], cwd: process.cwd() }, AbortSignal.timeout(500))
    expect(outcome).toMatchObject({ ok: false, aborted: true, timedOut: true })
    const childPid = Number(/CHILD_PID=(\d+)/.exec(outcome.raw)?.[1])
    expect(childPid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(childPid, 0)).toThrow()
  })
  it('独立重跑 node 测试并解析通过数、失败数与覆盖率', () => {
    const root = makeProject({
      'package.json': '{"name":"v","type":"module"}',
      'src/math.js': 'export const add = (a, b) => a + b\nexport const unused = () => 42\n',
      'test/math.test.js': "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/math.js'\ntest('add', () => assert.equal(add(1, 2), 3))\n"
    })
    const outcome = runNodeUnitTests(root)
    expect(outcome.ok).toBe(true)
    expect(outcome.tests).toBeGreaterThanOrEqual(1)
    expect(outcome.pass).toBeGreaterThanOrEqual(1)
    expect(outcome.fail).toBe(0)
    expect(outcome.coverage).not.toBeNull()
  })

  it('编译错误被识别为 compileError', () => {
    const root = makeProject({
      'package.json': '{"name":"v","type":"module"}',
      'test/bad.test.js': "import test from 'node:test'\ntest('bad', () => { this is not valid js })\n"
    })
    const outcome = runNodeUnitTests(root)
    expect(outcome.compileError).toBe(true)
  })

  it('四率按执行与断言文件计算', () => {
    const metrics = computeMetrics({ ok: true, tests: 10, pass: 9, fail: 1, coverage: 80, compileError: false, raw: '' }, { total: 2, withAssertions: 2 })
    expect(metrics.compileRate).toBe(1)
    expect(metrics.execRate).toBe(1)
    expect(metrics.assertRate).toBe(1)
    expect(metrics.effectiveRate).toBe(1)
    const metrics2 = computeMetrics({ ok: true, tests: 10, pass: 9, fail: 1, coverage: 80, compileError: false, raw: '' }, { total: 2, withAssertions: 1 })
    expect(metrics2.effectiveRate).toBe(0.5)
  })

  it('countAssertionFiles 统计含断言的测试文件', () => {
    const root = makeProject({
      'test/with.test.js': "import assert from 'node:assert'\ntest('x', () => assert.equal(1, 1))\n",
      'test/no.test.js': "import test from 'node:test'\ntest('x', () => {})\n",
      'e2e/smoke.spec.js': "import { test, expect } from '@playwright/test'\ntest('loads', async ({ page }) => { await expect(page).toBeTruthy() })\n"
    })
    const count = countAssertionFiles(root)
    expect(count.total).toBe(3)
    expect(count.withAssertions).toBe(2)
  })

  it('countAssertionFiles 识别 Java 断言方法', () => {
    const root = makeProject({
      'src/test/java/com/demo/FooTest.java': "class FooTest { @Test void t() { assertEquals(1, 1); assertTrue(true); } }\n",
      'src/test/java/com/demo/NoAssertTest.java': "class NoAssertTest { @Test void t() { System.out.println(\"ok\"); } }\n"
    })
    const count = countAssertionFiles(root)
    expect(count.total).toBe(2)
    expect(count.withAssertions).toBe(1)
  })

  it('解析 surefire 汇总行', () => {
    const summary = parseSurefireSummary('Tests run: 3, Failures: 1, Errors: 0, Skipped: 1, Time elapsed: 0.5 sec')
    expect(summary).toEqual({ tests: 3, fail: 1 })
    expect(parseSurefireSummary('no summary')).toBeNull()
  })

  it('runApiCases 按用例执行 HTTP 断言', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const outcome = await runApiCases([
        { id: 'a', title: 't', scenario: 'GET /hello', steps: ['请求 /hello'], expected: '200 成功', priority: 'high', layer: 'api' },
        { id: 'b', title: 't', scenario: 'GET /missing', steps: ['请求 /missing'], expected: '200 成功', priority: 'medium', layer: 'api' }
      ], `http://127.0.0.1:${port}`)
      expect(outcome.pass).toBe(1)
      expect(outcome.fail).toBe(1)
      expect(outcome.skipped).toBe(0)
    } finally {
      server.close()
    }
  })
})
