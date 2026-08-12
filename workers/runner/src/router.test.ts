import { describe, expect, it } from 'vitest'
import { decideLayer, routeCases, scoreValue, type TestCase } from './router.js'

function caseOf(overrides: Partial<TestCase>): TestCase {
  return { id: 'c1', title: 't', scenario: 's', steps: [], expected: 'ok', priority: 'medium', layer: 'unit', ...overrides }
}

describe('router', () => {
  it('按价值打分', () => {
    expect(scoreValue('high')).toBe(3)
    expect(scoreValue('medium')).toBe(2)
    expect(scoreValue('low')).toBe(1)
  })

  it('执行层优先用标注，未标注时按关键词推导', () => {
    expect(decideLayer(caseOf({ layer: 'api' }))).toBe('api')
    expect(decideLayer(caseOf({ layer: 'unit', scenario: '调用接口 /api/x 并校验返回' }))).toBe('unit')
    expect(decideLayer(caseOf({ layer: undefined, scenario: '打开登录页面并点击登录按钮' }))).toBe('ui')
    expect(decideLayer(caseOf({ layer: undefined, steps: ['请求 /api/alarm/list', '校验响应'] }))).toBe('api')
    expect(decideLayer(caseOf({ layer: undefined }))).toBe('unit')
  })

  it('按能力生成执行计划，缺能力时标记跳过', () => {
    const cases: TestCase[] = [
      caseOf({ id: 'api-1', layer: 'api' }),
      caseOf({ id: 'ui-1', layer: 'ui' }),
      caseOf({ id: 'unit-1', layer: 'unit' })
    ]
    const plan = routeCases(cases, ['java', 'playwright'])
    expect(plan.find((item) => item.caseId === 'api-1')?.runner).toBe('api-executor')
    expect(plan.find((item) => item.caseId === 'ui-1')?.runner).toBe('playwright')
    expect(plan.find((item) => item.caseId === 'unit-1')?.runner).toBe('maven')
    expect(plan.every((item) => !item.skipped)).toBe(true)

    const without = routeCases(cases, [])
    expect(without.find((item) => item.caseId === 'ui-1')?.skipped).toBe(true)
    expect(without.find((item) => item.caseId === 'unit-1')?.skipped).toBe(true)
    expect(without.find((item) => item.caseId === 'api-1')?.skipped).toBe(false)
  })
})
