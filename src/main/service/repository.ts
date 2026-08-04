import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { ProjectRecord, ScheduleRecord, TaskInput, TaskSnapshot } from '../../shared/contracts.js'

interface TaskRow { input_json: string; snapshot_json: string; trigger_type: string; created_at: string }
interface ProjectRow { id: string; name: string; project_path: string; default_version: string; default_test_types: string; created_at: string; updated_at: string }
interface ScheduleRow { id: string; project_id: string; interval_minutes: number; enabled: number; next_run_at: string; created_at: string; updated_at: string }

export class Repository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL UNIQUE,
        default_version TEXT NOT NULL, default_test_types TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, input_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        trigger_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL, next_run_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
  }

  saveTask(id: string, input: TaskInput, snapshot: TaskSnapshot, triggerType: string, createdAt: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO tasks (id,input_json,snapshot_json,trigger_type,created_at,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(id, JSON.stringify(input), JSON.stringify(snapshot), triggerType, createdAt, now)
  }

  getTask(id: string): { input: TaskInput; snapshot: TaskSnapshot; triggerType: string; createdAt: string } | null {
    const row = this.db.prepare('SELECT input_json,snapshot_json,trigger_type,created_at FROM tasks WHERE id=?').get(id) as unknown as TaskRow | undefined
    return row ? { input: JSON.parse(row.input_json), snapshot: JSON.parse(row.snapshot_json), triggerType: row.trigger_type, createdAt: row.created_at } : null
  }

  listTasks(limit = 100): TaskSnapshot[] {
    const rows = this.db.prepare('SELECT snapshot_json FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Array<{ snapshot_json: string }>
    return rows.map((row) => JSON.parse(row.snapshot_json) as TaskSnapshot)
  }

  recoverInterruptedTasks(): void {
    for (const task of this.listTasks(1000)) {
      if (!['queued', 'planning', 'running'].includes(task.status)) continue
      const saved = this.getTask(task.taskId)
      if (!saved) continue
      task.status = 'failed'
      task.logs.push({ id: randomUUID(), time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), level: 'error', message: '服务重启，原执行进程已中断' })
      this.saveTask(task.taskId, saved.input, task, saved.triggerType, saved.createdAt)
    }
  }

  saveProject(project: ProjectRecord): void {
    this.db.prepare(`INSERT INTO projects VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,project_path=excluded.project_path,default_version=excluded.default_version,
      default_test_types=excluded.default_test_types,updated_at=excluded.updated_at`)
      .run(project.id, project.name, project.projectPath, project.defaultVersion, JSON.stringify(project.defaultTestTypes), project.createdAt, project.updatedAt)
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as ProjectRow[]
    return rows.map((row) => ({ id: row.id, name: row.name, projectPath: row.project_path, defaultVersion: row.default_version, defaultTestTypes: JSON.parse(row.default_test_types), createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  getProject(id: string): ProjectRecord | null { return this.listProjects().find((project) => project.id === id) ?? null }

  saveSchedule(schedule: ScheduleRecord): void {
    this.db.prepare(`INSERT INTO schedules VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      project_id=excluded.project_id,interval_minutes=excluded.interval_minutes,enabled=excluded.enabled,
      next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`)
      .run(schedule.id, schedule.projectId, schedule.intervalMinutes, schedule.enabled ? 1 : 0, schedule.nextRunAt, schedule.createdAt, schedule.updatedAt)
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as unknown as ScheduleRow[]
    return rows.map((row) => ({ id: row.id, projectId: row.project_id, intervalMinutes: row.interval_minutes, enabled: Boolean(row.enabled), nextRunAt: row.next_run_at, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  deleteSchedule(id: string): boolean { return Number(this.db.prepare('DELETE FROM schedules WHERE id=?').run(id).changes) > 0 }
}
