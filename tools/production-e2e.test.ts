import { describe, expect, it } from 'vitest'
import { delimiter } from 'node:path'
// @ts-expect-error Deployment CLI intentionally has no generated declaration file.
import { validateE2eEnvironment } from './production-e2e.mjs'

describe('production E2E safety', () => {
  it('requires an endpoint, absolute project path and admin credential', () => {
    expect(validateE2eEnvironment({})).toEqual(expect.arrayContaining([
      expect.stringContaining('SERVER_URL'),
      expect.stringContaining('PROJECT_PATH'),
      expect.stringContaining('admin')
    ]))
  })

  it('accepts an explicit test target and role set', () => {
    expect(validateE2eEnvironment({
      TEST_AGENT_SERVER_URL: 'http://127.0.0.1:18088',
      TEST_AGENT_E2E_PROJECT_PATHS: [process.cwd(), `${process.cwd()}-copy`].join(delimiter),
      TEST_AGENT_ROLE_TOKENS: 'admin=admin-token;operator=operator-token;viewer=viewer-token;worker=worker-token'
    })).toEqual([])
  })

  it('rejects unsupported execution modes', () => {
    expect(validateE2eEnvironment({
      TEST_AGENT_EXECUTION_MODE: 'remote',
      TEST_AGENT_SERVER_URL: 'http://127.0.0.1:18088',
      TEST_AGENT_E2E_PROJECT_PATHS: [process.cwd(), `${process.cwd()}-copy`].join(delimiter),
      TEST_AGENT_ROLE_TOKENS: 'admin=admin-token'
    })).toEqual(expect.arrayContaining([expect.stringContaining('local or docker')]))
  })

  it('requires two distinct isolated workspaces', () => {
    expect(validateE2eEnvironment({
      TEST_AGENT_SERVER_URL: 'http://127.0.0.1:18088',
      TEST_AGENT_E2E_PROJECT_PATHS: process.cwd(),
      TEST_AGENT_ROLE_TOKENS: 'admin=admin-token'
    })).toEqual(expect.arrayContaining([expect.stringContaining('exactly two')]))
  })
})
