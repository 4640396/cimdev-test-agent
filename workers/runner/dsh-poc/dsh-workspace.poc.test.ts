import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@cimdev/harness/cordis'
import Storage from '@cimdev/harness/dsh-storage'
import { DomainFacility } from '@cimdev/harness/dsh-storage-domain'
import { JsonStorageBackend } from '@cimdev/harness/dsh-storage-json'
import SessionStore from '@cimdev/harness/dsh-session'
import JsonlSessionPersistence from '@cimdev/harness/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@cimdev/harness/dsh-workspace'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('DSH vendored workspace PoC', () => {
  it('boots the storage domain and registers a realpath workspace', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-storage-'))
    const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-sessions-'))
    const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-ws-project-'))
    dirs.push(storageRoot, sessionRoot, projectRoot)

    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(storageRoot)
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)

    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    await ctx.plugin(WorkspaceRegistry)

    const workspace = await ctx.workspaceRegistry.create(projectRoot)
    expect(workspace.path).toBe(await realpath(projectRoot))

    await ctx.fiber.dispose()
  })
})
