import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestExecutorRegistry, parseTestExecutionConfig, TestExecutorRegistry } from '../executors/index.js'
import { dockerMavenArgs, validateDockerMavenConfig } from '../executors/docker-maven.js'
import { RunEventStore } from '../run-events.js'
import { createWorkerPluginRuntime, parsePluginPolicyConfig } from './index.js'
import { mavenTestPlugin } from './maven-test.js'
import { qualityGatePlugin } from './quality-gate.js'
import { WorkerPluginError, WorkerPluginRuntime, type WorkerPluginContext } from './runtime.js'
import { testPlanPlugin, type TestPlanInput, type TestPlanOutput } from './test-plan.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function context(capabilities: string[] = ['java']): WorkerPluginContext & { messages: string[] } {
  const projectPath = mkdtempSync(join(tmpdir(), 'test-agent-plugin-'))
  roots.push(projectPath)
  const messages: string[] = []
  return {
    projectPath,
    executionId: 'execution-1',
    capabilities,
    executors: createTestExecutorRegistry({ mode: 'local', docker: { image: 'unused', memory: '2g', cpus: '2', pidsLimit: 512 } }),
    events: new RunEventStore(projectPath, 'execution-1'),
    signal: new AbortController().signal,
    emit: (event) => { messages.push(event.message) },
    messages
  }
}

describe('WorkerPluginRuntime', () => {
  it('拒绝重复注册和未知插件，并记录执行生命周期', async () => {
    const runtime = new WorkerPluginRuntime()
    const dispose = runtime.register(testPlanPlugin)
    expect(() => runtime.register(testPlanPlugin)).toThrow('already registered')
    await expect(runtime.execute('missing', context(), {})).rejects.toThrow('Unknown worker plugin')

    const ctx = context()
    const output = await runtime.execute<'test_plan', TestPlanInput, TestPlanOutput>('test_plan', ctx, { cases: [] })
    expect(output.degraded).toBe(true)
    expect(ctx.messages).toEqual(['插件开始：test_plan（尝试 1/1）', '插件完成：test_plan'])
    const audit = ctx.events.replay().map((event) => event.data as { status: string })
    expect(audit.map((event) => event.status)).toEqual(['started', 'succeeded'])

    dispose()
    await expect(runtime.execute('test_plan', ctx, { cases: [] })).rejects.toThrow('Unknown worker plugin')
  })

  it('密封后拒绝注册，并隔离日志监听器异常', async () => {
    const runtime = new WorkerPluginRuntime()
    runtime.register(testPlanPlugin)
    runtime.seal()
    expect(() => runtime.register(qualityGatePlugin)).toThrow('registry is sealed')
    const ctx = context()
    ctx.emit = () => { throw new Error('日志服务离线') }
    await expect(runtime.execute<'test_plan', TestPlanInput, TestPlanOutput>('test_plan', ctx, { cases: [] })).resolves.toMatchObject({ degraded: true })
  })

  it('只重试明确可重试错误，并记录每次尝试', async () => {
    const runtime = new WorkerPluginRuntime()
    let attempts = 0
    runtime.register({
      name: 'infra',
      policy: { maxAttempts: 2, retryDelayMs: 0 },
      execute() {
        attempts += 1
        if (attempts === 1) throw new WorkerPluginError('临时执行器故障', 'INFRA_TEMPORARY', true)
        return 'ok'
      }
    })
    const ctx = context()
    await expect(runtime.execute('infra', ctx, {})).resolves.toBe('ok')
    const records = readFileSync(join(ctx.projectPath, runtime.auditArtifact(ctx)), 'utf8')
    expect(records).toContain('"status":"retrying"')
    expect(attempts).toBe(2)
  })

  it('超时后等待插件响应取消，并输出结构化错误', async () => {
    const runtime = new WorkerPluginRuntime()
    runtime.register({
      name: 'slow',
      policy: { timeoutMs: 10 },
      execute(ctx) {
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
        })
      }
    })
    const ctx = context()
    await expect(runtime.execute('slow', ctx, {})).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' })
    expect(readFileSync(join(ctx.projectPath, runtime.auditArtifact(ctx)), 'utf8')).toContain('"status":"timed_out"')
  })

  it('外部策略配置启动即校验，未知插件和非法预算直接失败', () => {
    expect(parsePluginPolicyConfig('{"maven_test":{"timeoutMs":90000}}')).toEqual({ maven_test: { timeoutMs: 90000 } })
    expect(() => parsePluginPolicyConfig('[]')).toThrow('must be an object')
    expect(() => createWorkerPluginRuntime({ unknown: { timeoutMs: 1 } })).toThrow('Unknown plugin policy')
    expect(() => createWorkerPluginRuntime({ maven_test: { timeoutMs: 0 } })).toThrow('timeoutMs must be positive')
  })
})

describe('TestExecutorRegistry', () => {
  it('Provider 可替换、注册可撤销且 capability 默认拒绝', async () => {
    const registry = new TestExecutorRegistry()
    const dispose = registry.register({ name: 'maven', requiredCapabilities: ['java'], execute: async () => 'remote-result' })
    expect(() => registry.resolve('maven', [])).toThrow('requires capabilities: java')
    await expect(registry.resolve<string>('maven', ['java']).execute({ projectPath: '.', signal: new AbortController().signal })).resolves.toBe('remote-result')
    dispose()
    expect(() => registry.resolve('maven', ['java'])).toThrow('Unknown test executor')
  })
})

describe('Docker Maven Provider', () => {
  it('构建默认断网、去能力、只读和资源受限的命令', () => {
    const config = { image: 'maven:3.9.11-eclipse-temurin-17', memory: '2g', cpus: '2', pidsLimit: 512 }
    const args = dockerMavenArgs('C:\\work\\project', config)
    expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--cap-drop', 'ALL', '--read-only', '--pids-limit', '512', '--memory', '2g']))
    expect(args).toContain(config.image)
  })

  it('mounts a prewarmed Maven repository read-only and runs offline', () => {
    const repositoryPath = mkdtempSync(join(tmpdir(), 'test-agent-maven-repo-'))
    roots.push(repositoryPath)
    const args = dockerMavenArgs(process.cwd(), { image: 'maven:3.9.11-eclipse-temurin-17', memory: '2g', cpus: '2', pidsLimit: 512, repositoryPath })
    expect(args).toEqual(expect.arrayContaining(['--offline', '-Dmaven.repo.local=/maven-repo']))
    expect(args.some((value) => value.includes('target=/maven-repo,readonly'))).toBe(true)
  })

  it('启动配置拒绝未知模式和危险资源值', () => {
    expect(() => parseTestExecutionConfig({ TEST_AGENT_EXECUTION_MODE: 'host' })).toThrow('local or docker')
    expect(() => validateDockerMavenConfig({ image: 'maven;whoami', memory: '2g', cpus: '2', pidsLimit: 512 })).toThrow('unsupported characters')
    expect(() => validateDockerMavenConfig({ image: 'maven:3', memory: 'unlimited', cpus: '2', pidsLimit: 512 })).toThrow('Docker size')
    expect(() => validateDockerMavenConfig({ image: 'maven:3', memory: '2g', cpus: '2', pidsLimit: 512, repositoryPath: 'relative/repo' })).toThrow('absolute')
  })
})

describe('RunEventStore', () => {
  it('追加、回放并隔离订阅者异常', () => {
    const ctx = context()
    const store = ctx.events
    store.subscribe(() => { throw new Error('observer failure') })
    store.append('run/start', { provider: 'test' })
    store.append('run/end', { status: 'completed' })
    expect(store.replay().map((event) => [event.sequence, event.type])).toEqual([[1, 'run/start'], [2, 'run/end']])
  })
})

describe('test_plan plugin', () => {
  it('校验、去重、分流并保存结构化计划', async () => {
    const ctx = context(['java', 'playwright'])
    const output = await testPlanPlugin.execute(ctx, {
      cases: [
        { id: 'u1', title: '服务测试', scenario: '核心逻辑', steps: ['调用方法'], expected: '成功', priority: 'high', layer: 'unit', source: 'rules.md' },
        { id: 'ui1', title: '登录', scenario: '打开登录页面', steps: ['点击登录'], expected: '显示首页', priority: 'medium' },
        { id: 'u1', title: '重复', scenario: '重复', steps: [], expected: '忽略', priority: 'low' },
        { id: '', title: '非法', scenario: '非法', steps: [], expected: '忽略', priority: 'low' }
      ]
    })

    expect(output.meta.count).toBe(2)
    expect(output.routing.map((item) => item.runner)).toEqual(['maven', 'playwright'])
    expect(output.issues).toEqual(['用例 id 重复：u1', 'cases[3].id 缺失'])
    expect(output.artifacts).toHaveLength(2)
    expect(output.artifacts.every((artifact) => existsSync(join(ctx.projectPath, artifact)))).toBe(true)
  })
})

describe('maven_test plugin', () => {
  it('非必需时不执行，缺少 Java capability 时拒绝', async () => {
    await expect(mavenTestPlugin.execute(context([]), { required: false })).resolves.toMatchObject({ executed: false, artifact: null, ok: true })
    await expect(mavenTestPlugin.execute(context([]), { required: true })).rejects.toThrow('capabilities: java')
  })
})

describe('quality_gate plugin', () => {
  const metrics = { compileRate: 1, execRate: 1, assertRate: 1, effectiveRate: 1 }
  const plan = {
    cases: [{ id: 'u1', title: 't', scenario: 's', steps: [], expected: 'ok', priority: 'high' as const }],
    meta: { count: 1, byLayer: { unit: 1 }, byPriority: { high: 1 } },
    routing: [],
    artifacts: [],
    degraded: false,
    issues: []
  }

  it('真实测试通过时放行，覆盖率缺失只披露', async () => {
    const output = await qualityGatePlugin.execute(context(), {
      plan,
      checks: [{ name: 'maven_test', required: true, executed: true, ok: true, tests: 2, pass: 2, fail: 0, compileError: false }],
      coverageTarget: 60,
      coverage: null,
      metrics
    })
    expect(output).toMatchObject({ passed: true, reason: expect.stringContaining('不单独阻断') })
  })

  it('零测试、失败、编译错误和覆盖率不足均不可绕过', async () => {
    const output = await qualityGatePlugin.execute(context(), {
      plan,
      checks: [{ name: 'maven_test', required: true, executed: true, ok: false, tests: 0, pass: 0, fail: 1, compileError: true }],
      coverageTarget: 80,
      coverage: 50,
      metrics
    })
    expect(output.passed).toBe(false)
    expect(output.reasons).toEqual(expect.arrayContaining([
      'maven_test 存在编译错误',
      'maven_test 有 1 个测试失败',
      'maven_test 未发现可执行测试',
      '覆盖率 50% 未达到目标 80%'
    ]))
  })
})
