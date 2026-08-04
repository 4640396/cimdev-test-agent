import { describe, expect, it } from 'vitest'
import type { ProjectRecord, ScheduleRecord, TaskInput, TaskSnapshot } from '../../shared/contracts.js'
import { Repository } from './repository.js'

describe('Repository', () => {
  it('persists projects, tasks and schedules', () => {
    const repository = new Repository(':memory:')
    const now = new Date().toISOString()
    const project: ProjectRecord = { id: 'p1', name: 'portal', projectPath: 'C:\\works\\portal', defaultVersion: 'main', defaultTestTypes: ['unit'], createdAt: now, updatedAt: now }
    repository.saveProject(project)
    expect(repository.getProject('p1')).toEqual(project)

    const input: TaskInput = { projectPath: project.projectPath, systemName: project.name, version: 'main', testTypes: ['unit'] }
    const snapshot: TaskSnapshot = { taskId: 't1', status: 'queued', logs: [], lanes: [{ type: 'unit', status: 'pending', summary: 'waiting' }], artifacts: [] }
    repository.saveTask('t1', input, snapshot, 'test', now)
    expect(repository.getTask('t1')?.snapshot.status).toBe('queued')

    const schedule: ScheduleRecord = { id: 's1', projectId: 'p1', intervalMinutes: 60, enabled: true, nextRunAt: now, createdAt: now, updatedAt: now }
    repository.saveSchedule(schedule)
    expect(repository.listSchedules()).toEqual([schedule])
    expect(repository.deleteSchedule('s1')).toBe(true)
  })

  it('marks interrupted tasks as failed after restart', () => {
    const repository = new Repository(':memory:')
    const now = new Date().toISOString()
    const input: TaskInput = { projectPath: 'C:\\works\\portal', systemName: 'portal', version: 'main', testTypes: ['unit'] }
    const snapshot: TaskSnapshot = { taskId: 't2', status: 'running', logs: [], lanes: [{ type: 'unit', status: 'running', summary: 'running' }], artifacts: [] }
    repository.saveTask('t2', input, snapshot, 'test', now)
    repository.recoverInterruptedTasks()
    expect(repository.getTask('t2')?.snapshot.status).toBe('failed')
  })
})
