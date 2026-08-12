export type TestType = 'unit' | 'regression' | 'ui'
export type TaskStatus = 'idle' | 'queued' | 'planning' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needsReview'
export type LaneStatus = 'pending' | 'running' | 'passed' | 'failed'

export interface TaskInput {
  projectPath: string
  systemName: string
  version: string
  testTypes: TestType[]
  requiredCapabilities?: string[]
  coverageTarget?: number
  knowledgeRoots?: string[]
  targetClasses?: string[]
  apiBaseUrl?: string
}

export interface ProjectSelection {
  path: string
  detectedSystem: string
  detectedVersion: string
}

export interface RuntimeStatus {
  mode: 'unavailable' | 'real'
  provider: 'local-go' | 'claude-code' | 'codex-cli' | 'cimicode' | null
  message: string
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
    coverage: number | null
    metrics?: {
      compileRate: number
      execRate: number
      assertRate: number
      effectiveRate: number
      knowledgeRate?: number
    }
    gate?: {
      coverageTarget: number
      coverage: number | null
      effectiveRate: number
      passed: boolean
      reason: string
    }
    knowledge?: {
      refs: Array<{
        source: string
        version: string | null
        type: string
      }>
      degraded: boolean
      reason?: string
    }
  }
}

export interface ProjectRecord {
  id: string
  name: string
  projectPath: string
  defaultVersion: string
  defaultTestTypes: TestType[]
  createdAt: string
  updatedAt: string
}

export interface ScheduleRecord {
  id: string
  projectId: string
  intervalMinutes: number
  enabled: boolean
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export interface DesktopApi {
  selectProject(): Promise<ProjectSelection | null>
  getKnowledgeRoots(): Promise<string[]>
  onKnowledgeRootsChanged(listener: (roots: string[]) => void): () => void
  getRuntimeStatus(): Promise<RuntimeStatus>
  startTask(input: TaskInput): Promise<{ taskId: string }>
  getTask(taskId: string): Promise<TaskSnapshot | null>
  cancelTask(taskId: string): Promise<TaskSnapshot | null>
  retryTask(taskId: string): Promise<{ taskId: string } | null>
  subscribeTask(listener: (snapshot: TaskSnapshot) => void): () => void
}
