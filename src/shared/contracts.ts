export type TestType = 'unit' | 'regression' | 'ui'
export type TaskStatus = 'idle' | 'planning' | 'running' | 'completed' | 'failed'
export type LaneStatus = 'pending' | 'running' | 'passed' | 'failed'

export interface TaskInput {
  projectPath: string
  systemName: string
  version: string
  testTypes: TestType[]
}

export interface TaskLog {
  id: string
  time: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export interface LaneState {
  type: TestType
  status: LaneStatus
  summary: string
}

export interface TaskSnapshot {
  taskId: string
  status: TaskStatus
  logs: TaskLog[]
  lanes: LaneState[]
  artifacts: string[]
  report?: {
    passed: number
    failed: number
    coverage: number
  }
}

export interface DesktopApi {
  selectProject(): Promise<string | null>
  startTask(input: TaskInput): Promise<{ taskId: string }>
  subscribeTask(listener: (snapshot: TaskSnapshot) => void): () => void
}
