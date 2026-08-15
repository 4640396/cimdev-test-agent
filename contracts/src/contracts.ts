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
  /**
   * Execution target invariant: endpoint tasks are device-bound and must never
   * be re-dispatched to another terminal; shared tasks are re-acquirable and
   * must never carry developer-local absolute paths.
   */
  executionTarget?: 'endpoint' | 'shared'
  deviceId?: string
  workspaceId?: string
  sourceSnapshot?: {
    gitHead?: string
    dirty?: boolean
    digest?: string
  }
  sourceRef?: string
}

export interface ProjectSelection {
  path: string
  detectedSystem: string
  detectedVersion: string
  detectedTestTypes?: TestType[]
}

export interface RuntimeStatus {
  mode: 'unavailable' | 'real'
  provider: 'local-go' | 'claude-code' | 'codex-cli' | 'cimicode' | 'local-host' | null
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

export interface TestCaseRecord {
  id: string
  title: string
  scenario: string
  steps: string[]
  expected: string
  priority: 'low' | 'medium' | 'high'
  layer?: 'api' | 'ui' | 'unit'
  source?: string
}

export interface RoutingRecord {
  caseId: string
  layer: 'api' | 'ui' | 'unit'
  runner: string | null
  valueScore: number
  reason: string
  skipped: boolean
}

export interface FailedCaseRecord {
  name: string
  layer: string
  error: string
  suggestion?: string
  screenshot?: string
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
    durationMs?: number
    summary?: string
    cases?: TestCaseRecord[]
    casesMeta?: {
      count: number
      byLayer: Record<string, number>
      byPriority: Record<string, number>
    }
    routing?: RoutingRecord[]
    failedCases?: FailedCaseRecord[]
    screenshots?: string[]
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

export interface ExportResult {
  saved: boolean
  path?: string
  error?: string
}

export interface CopyResult {
  copied: boolean
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
  detectProject(path: string): Promise<ProjectSelection | null>
  getKnowledgeRoots(): Promise<string[]>
  onKnowledgeRootsChanged(listener: (roots: string[]) => void): () => void
  getRuntimeStatus(): Promise<RuntimeStatus>
  startTask(input: TaskInput): Promise<{ taskId: string }>
  getTask(taskId: string): Promise<TaskSnapshot | null>
  cancelTask(taskId: string): Promise<TaskSnapshot | null>
  retryTask(taskId: string): Promise<{ taskId: string } | null>
  subscribeTask(listener: (snapshot: TaskSnapshot) => void): () => void
  exportReport(format: 'markdown' | 'html' | 'json', snapshot: TaskSnapshot): Promise<ExportResult>
  copyReportSummary(snapshot: TaskSnapshot): Promise<CopyResult>
}

export interface LocalHostStatus {
  running: boolean
  protocolVersion?: number
  hostVersion?: string
  capabilities?: string[]
  activeRuns?: number
  error?: string
}

export interface LocalHostStartResult {
  taskId: string
}

export interface LocalHostCancelResult {
  cancelled: boolean
}

export interface LocalHostApi {
  getStatus(): Promise<LocalHostStatus>
  start(input: TaskInput, executionId?: string): Promise<LocalHostStartResult>
  cancel(executionId: string): Promise<LocalHostCancelResult>
  subscribe(listener: (message: unknown) => void): () => void
}
