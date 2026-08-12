export type CasePriority = 'low' | 'medium' | 'high'
export type CaseLayer = 'api' | 'ui' | 'unit'

export interface TestCase {
  id: string
  title: string
  scenario: string
  steps: string[]
  expected: string
  priority: CasePriority
  layer?: CaseLayer
  source?: string
}

export interface RoutingDecision {
  caseId: string
  layer: CaseLayer
  runner: string | null
  valueScore: number
  reason: string
  skipped: boolean
}

const UI_KEYWORDS = ['点击', '输入', '打开', '页面', '浏览器', '渲染', '跳转', '截图', '登录', '按钮', '显示', '选择', 'hover', 'click', 'input']
const API_KEYWORDS = ['请求', '接口', 'api', '返回', '响应', '状态码', '调用', 'http', 'get', 'post', 'put', 'delete']

export function scoreValue(priority: CasePriority): number {
  if (priority === 'high') return 3
  if (priority === 'medium') return 2
  return 1
}

/** 执行层判定：优先用用例标注；未标注时按关键词推导（UI 交互 > API 调用 > 纯逻辑）。 */
export function decideLayer(caseItem: TestCase): CaseLayer {
  if (caseItem.layer === 'api' || caseItem.layer === 'ui' || caseItem.layer === 'unit') return caseItem.layer
  const text = `${caseItem.title} ${caseItem.scenario} ${caseItem.steps.join(' ')} ${caseItem.expected}`.toLowerCase()
  if (UI_KEYWORDS.some((keyword) => text.includes(keyword))) return 'ui'
  if (API_KEYWORDS.some((keyword) => text.includes(keyword))) return 'api'
  return 'unit'
}

export function routeCases(cases: TestCase[], capabilities: string[]): RoutingDecision[] {
  return cases.map((caseItem) => {
    const layer = decideLayer(caseItem)
    const valueScore = scoreValue(caseItem.priority)
    const runner = layer === 'ui'
      ? (capabilities.includes('playwright') ? 'playwright' : null)
      : layer === 'api'
        ? 'api-executor'
        : capabilities.includes('java')
          ? 'maven'
          : capabilities.includes('node')
            ? 'node-test'
            : null
    return {
      caseId: caseItem.id,
      layer,
      runner,
      valueScore,
      reason: `value=${valueScore} layer=${layer} runner=${runner ?? 'unavailable'}`,
      skipped: runner === null
    }
  })
}
