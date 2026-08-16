import type { AgentAdapter, AgentEvent, AgentRunResult } from './agent/types.js'
import type { TaskInput, TimelineRecord, UiRecording, UiStepRecord } from '../../../contracts/src/contracts.js'
import type { TestExecutorRegistry } from './executors/runtime.js'
import type { WorkerPluginRuntime } from './plugins/runtime.js'
import type { QualityGateOutput } from './plugins/quality-gate.js'
import type { TestPlanOutput } from './plugins/test-plan.js'
import type { ApiCaseOutcome } from './validator.js'
import type { RunEventStore } from './run-events.js'

export interface TestKernelKnowledgeMeta {
  refs: Array<{ source: string; version: string | null; type: string }>
  degraded: boolean
  reason?: string
}

export interface TestKernelReport {
  passed: number
  failed: number
  coverage: number | null
  durationMs: number
  summary: string
  screenshots?: string[]
  branchCoverage?: number | null
  failedCases?: Array<{ name: string; layer: string; error: string; suggestion?: string }>
  uiSteps?: UiStepRecord[]
  timeline?: TimelineRecord[]
  recording?: UiRecording
  riskPoints?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; message: string; suggestion?: string }>
  fixes?: Array<{ severity: 'high' | 'medium' | 'low'; file: string; title: string; summary: string; beforeCode?: string; afterCode?: string }>
  metrics: {
    compileRate: number
    execRate: number
    assertRate: number
    effectiveRate: number
    knowledgeRate: number
  }
  gate: QualityGateOutput
  knowledge: TestKernelKnowledgeMeta
  lanes: AgentRunResult['lanes']
  cases: TestPlanOutput['meta']
  routing: TestPlanOutput['routing']
  api: ApiCaseOutcome | null
}

export interface TestKernelOutcome {
  adapterResult: AgentRunResult
  report: TestKernelReport
  lanes: AgentRunResult['lanes']
  gate: QualityGateOutput
}

export interface TestKernelSessionContext {
  executionId: string
  projectPath: string
  input: TaskInput
  capabilities: readonly string[]
  provider: AgentAdapter
  pluginRuntime: WorkerPluginRuntime
  executors: TestExecutorRegistry
  runEvents: RunEventStore
  sandbox?: { confine(argv: readonly string[], policy: unknown): { argv: string[] } }
  signal: AbortSignal
  emit(event: AgentEvent): void | Promise<void>
}

export { runTestWorkflow as runTestKernel } from './test-workflow.js'
