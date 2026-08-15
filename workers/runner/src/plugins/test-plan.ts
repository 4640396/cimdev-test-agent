import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { RoutingDecision, TestCase } from '../router.js'
import { decideLayer, routeCases } from '../router.js'
import type { WorkerPlugin } from './runtime.js'

export interface TestPlanInput {
  cases: unknown
}

export interface TestPlanMeta {
  count: number
  byLayer: Record<string, number>
  byPriority: Record<string, number>
}

export interface TestPlanOutput {
  cases: TestCase[]
  meta: TestPlanMeta
  routing: RoutingDecision[]
  artifacts: string[]
  degraded: boolean
  issues: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCase(value: unknown, index: number): { caseItem?: TestCase; issue?: string } {
  if (!isRecord(value)) return { issue: `cases[${index}] 不是对象` }
  const { id, title, scenario, steps, expected, priority, layer, source } = value
  if (typeof id !== 'string' || id.trim() === '') return { issue: `cases[${index}].id 缺失` }
  if (typeof title !== 'string' || title.trim() === '') return { issue: `cases[${index}].title 缺失` }
  if (typeof scenario !== 'string' || scenario.trim() === '') return { issue: `cases[${index}].scenario 缺失` }
  if (!Array.isArray(steps) || steps.some((step) => typeof step !== 'string')) return { issue: `cases[${index}].steps 必须是字符串数组` }
  if (typeof expected !== 'string' || expected.trim() === '') return { issue: `cases[${index}].expected 缺失` }
  if (priority !== 'low' && priority !== 'medium' && priority !== 'high') return { issue: `cases[${index}].priority 非法` }
  if (layer !== undefined && layer !== 'api' && layer !== 'ui' && layer !== 'unit') return { issue: `cases[${index}].layer 非法` }
  if (source !== undefined && typeof source !== 'string') return { issue: `cases[${index}].source 非法` }
  return {
    caseItem: {
      id: id.trim(),
      title: title.trim(),
      scenario: scenario.trim(),
      steps,
      expected: expected.trim(),
      priority,
      ...(layer ? { layer } : {}),
      ...(source ? { source } : {})
    }
  }
}

export const testPlanPlugin: WorkerPlugin<'test_plan', TestPlanInput, TestPlanOutput> = {
  name: 'test_plan',
  execute(context, input) {
    const issues: string[] = []
    const cases: TestCase[] = []
    const ids = new Set<string>()
    if (!Array.isArray(input.cases)) {
      issues.push('Agent 未返回结构化 cases 数组')
    } else {
      input.cases.forEach((value, index) => {
        const parsed = parseCase(value, index)
        if (parsed.issue) {
          issues.push(parsed.issue)
          return
        }
        const caseItem = parsed.caseItem!
        if (ids.has(caseItem.id)) {
          issues.push(`用例 id 重复：${caseItem.id}`)
          return
        }
        ids.add(caseItem.id)
        cases.push(caseItem)
      })
    }
    if (cases.length === 0) issues.push('没有可执行的结构化测试用例')

    const routing = routeCases(cases, [...context.capabilities])
    const byLayer: Record<string, number> = {}
    const byPriority: Record<string, number> = {}
    for (const caseItem of cases) {
      const layer = decideLayer(caseItem)
      byLayer[layer] = (byLayer[layer] ?? 0) + 1
      byPriority[caseItem.priority] = (byPriority[caseItem.priority] ?? 0) + 1
    }

    const artifacts: string[] = []
    if (cases.length > 0) {
      const casesDir = join(context.projectPath, '.test-agent', 'cases')
      mkdirSync(casesDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const casesPath = join(casesDir, `cases-${stamp}.json`)
      const routingPath = join(casesDir, `routing-${stamp}.json`)
      writeFileSync(casesPath, JSON.stringify(cases, null, 2), 'utf8')
      writeFileSync(routingPath, JSON.stringify(routing, null, 2), 'utf8')
      artifacts.push(relative(context.projectPath, casesPath), relative(context.projectPath, routingPath))
    }

    return {
      cases,
      meta: { count: cases.length, byLayer, byPriority },
      routing,
      artifacts,
      degraded: issues.length > 0,
      issues
    }
  }
}
