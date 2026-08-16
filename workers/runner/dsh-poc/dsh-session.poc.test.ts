import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@cimdev/harness/cordis'
import SessionStore, { SessionId } from '@cimdev/harness/dsh-session'
import JsonlSessionPersistence from '@cimdev/harness/dsh-session-persistence-jsonl'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('DSH vendored session PoC', () => {
  it('boots Cordis, appends, flushes and loads a JSONL session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-poc-'))
    dirs.push(root)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    const id = SessionId('poc-1')
    const session = ctx.sessions.create(id, { meta: { cwd: root } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await ctx.sessions.flush(session)
    const loaded = await ctx.sessionPersistence.load(id)

    expect(loaded.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end'])
    await ctx.fiber.dispose()
  })

  it('accepts the Test Agent run event types for durable audit storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-poc-run-'))
    dirs.push(root)

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })

    const id = SessionId('run-1')
    const session = ctx.sessions.create(id, { meta: { cwd: root } })
    session.append('run/started', { executionTarget: 'endpoint', workspaceId: root })
    session.append('plugin/execution', { plugin: 'maven_test', status: 'succeeded' })
    session.append('quality-gate/decided', { passed: true })

    await ctx.sessions.flush(session)
    const loaded = await ctx.sessionPersistence.load(id)
    expect(loaded.events.map((event) => event.type)).toEqual(['run/started', 'plugin/execution', 'quality-gate/decided'])
    await ctx.fiber.dispose()
  })
})
