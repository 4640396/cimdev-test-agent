import type { AgentAdapter } from './agent/types.js'
import type { TaskInput } from '../../../contracts/src/contracts.js'
import type { TestExecutorRegistry } from './executors/runtime.js'
import type { WorkerPluginRuntime } from './plugins/runtime.js'
import type { RunEventStore } from './run-events.js'

export interface TestWorkflowContext {
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
  emit(event: { level: 'info' | 'success' | 'warning' | 'error'; message: string; stage?: string }): void | Promise<void>
}

export interface TestWorkflowRun {
  stages: Array<{ name: string; run(context: TestWorkflowContext): void | Promise<void> }>
}

/** DSH 风格的阶段编排：每个阶段是独立节点，按顺序执行。 */
export function defineTestWorkflow(stages: TestWorkflowRun['stages']): TestWorkflowRun {
  return { stages }
}
