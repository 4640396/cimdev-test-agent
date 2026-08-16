import type { TaskInput, TestType } from '../../../../contracts/src/contracts.js'

export interface AgentEvent {
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  stage?: string
}

export interface AgentLaneResult {
  type: TestType
  status: 'passed' | 'failed'
  summary: string
}

export interface AgentRunResult {
  lanes: AgentLaneResult[]
  report: { passed: number; failed: number; coverage: number | null }
  artifacts: string[]
  cases?: unknown[]
  riskPoints?: unknown[]
  fixes?: unknown[]
}

export interface AgentFeedback {
  gatePassed: boolean
  gateReason?: string
  failedCases?: Array<{ name: string; layer: string; error: string }>
}

export interface AgentAdapter {
  readonly name: string
  run(input: TaskInput, emit: (event: AgentEvent) => void, signal?: AbortSignal, context?: { knowledge?: string; feedback?: AgentFeedback }): Promise<AgentRunResult>
}
