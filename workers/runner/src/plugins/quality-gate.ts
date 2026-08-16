import type { QualityMetrics } from '../validator.js'
import type { TestPlanOutput } from './test-plan.js'
import type { WorkerPlugin } from './runtime.js'

export interface VerificationCheck {
  name: string
  required: boolean
  executed: boolean
  ok: boolean
  tests: number
  pass: number
  fail: number
  compileError: boolean
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  timedOut?: boolean
  aborted?: boolean
  outputTruncated?: boolean
}

export interface QualityGateInput {
  plan: TestPlanOutput
  checks: VerificationCheck[]
  coverageTarget: number
  coverage: number | null
  metrics: QualityMetrics
}

export interface QualityGateOutput {
  passed: boolean
  coverageTarget: number
  coverage: number | null
  effectiveRate: number
  reason: string
  reasons: string[]
  checks: VerificationCheck[]
}

export const qualityGatePlugin: WorkerPlugin<'quality_gate', QualityGateInput, QualityGateOutput> = {
  name: 'quality_gate',
  execute(_context, input) {
    const reasons: string[] = []
    const advisories: string[] = []
    if (input.plan.meta.count === 0) advisories.push('未生成结构化测试计划')
    if (input.plan.issues.length > 0) advisories.push(...input.plan.issues)

    for (const check of input.checks) {
      if (!check.required) continue
      if (!check.executed) {
        reasons.push(`${check.name} 未执行`)
        continue
      }
      if (check.compileError) reasons.push(`${check.name} 存在编译错误`)
      if (check.timedOut) reasons.push(`${check.name} 执行超时`)
      if (check.aborted) reasons.push(`${check.name} 被取消`)
      if (check.outputTruncated) reasons.push(`${check.name} 输出超过采集上限，日志已截断`)
      if (check.fail > 0) reasons.push(`${check.name} 有 ${check.fail} 个测试失败`)
      if (!check.ok && !check.compileError && check.fail === 0) reasons.push(`${check.name} 执行未成功`)
      if (check.tests === 0) reasons.push(`${check.name} 未发现可执行测试`)
    }

    if (input.coverage !== null && input.coverage < input.coverageTarget) {
      reasons.push(`覆盖率 ${input.coverage}% 未达到目标 ${input.coverageTarget}%`)
    }
    const uniqueReasons = [...new Set(reasons)]
    const uniqueAdvisories = [...new Set(advisories)]
    const coverageNote = input.coverage === null ? '未取得覆盖率数据，覆盖率检查已披露但不单独阻断' : '覆盖率达标'
    const passed = uniqueReasons.length === 0
    return {
      passed,
      coverageTarget: input.coverageTarget,
      coverage: input.coverage,
      effectiveRate: input.metrics.effectiveRate,
      reason: passed ? [coverageNote, ...uniqueAdvisories].join('；') : uniqueReasons.join('；'),
      reasons: uniqueReasons,
      checks: input.checks
    }
  }
}
