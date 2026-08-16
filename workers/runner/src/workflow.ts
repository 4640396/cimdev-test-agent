export type WorkflowStageStatus = 'pending' | 'running' | 'passed' | 'failed'

export interface WorkflowStageResult {
  name: string
  status: WorkflowStageStatus
  durationMs: number
  error?: Error
}

export interface WorkflowStage {
  name: string
  run(): void | Promise<void>
}

export async function runWorkflow(stages: WorkflowStage[]): Promise<WorkflowStageResult[]> {
  const results: WorkflowStageResult[] = []
  for (const stage of stages) {
    const startedAt = Date.now()
    let error: Error | undefined
    try {
      await stage.run()
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause))
      results.push({ name: stage.name, status: 'failed', durationMs: Date.now() - startedAt, error })
      break
    }
    results.push({ name: stage.name, status: 'passed', durationMs: Date.now() - startedAt })
  }
  return results
}
