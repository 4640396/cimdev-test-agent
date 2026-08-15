import { describe, expect, it } from 'vitest'
// The production checker is intentionally dependency-free JavaScript so it can run on a deployment host.
// @ts-expect-error No declaration file is needed for the CLI module.
import { executionProfile, parseRoleTokens, validateProductionSecrets } from './production-readiness.mjs'

describe('production readiness policy', () => {
  it('parses all role assignments and multiple tokens', () => {
    const roles = parseRoleTokens('admin=a|b;operator=c;viewer=d;worker=e')
    expect(roles.get('admin')).toEqual(['a', 'b'])
    expect(roles.get('worker')).toEqual(['e'])
  })

  it('rejects missing, weak, placeholder and shared production secrets', () => {
    expect(validateProductionSecrets({})).not.toEqual([])
    expect(validateProductionSecrets({
      MYSQL_ROOT_PASSWORD: 'change-me',
      TEST_AGENT_MYSQL_PASSWORD: 'replace-with-password',
      TEST_AGENT_ROLE_TOKENS: 'admin=short;operator=short;viewer=short;worker=short'
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('placeholder'),
      expect.stringContaining('unique'),
      expect.stringContaining('24')
    ]))
  })

  it('accepts distinct long credentials for every role', () => {
    expect(validateProductionSecrets({
      MYSQL_ROOT_PASSWORD: 'root-012345678901234567890123',
      TEST_AGENT_MYSQL_PASSWORD: 'mysql-01234567890123456789012',
      TEST_AGENT_ROLE_TOKENS: [
        'admin=admin-01234567890123456789012',
        'operator=operator-01234567890123456789',
        'viewer=viewer-0123456789012345678901',
        'worker=worker-0123456789012345678901'
      ].join(';')
    })).toEqual([])
  })

  it('does not require a database root credential for local execution', () => {
    expect(validateProductionSecrets({
      TEST_AGENT_MYSQL_PASSWORD: 'mysql-01234567890123456789012',
      TEST_AGENT_ROLE_TOKENS: [
        'admin=admin-01234567890123456789012',
        'operator=operator-01234567890123456789',
        'viewer=viewer-0123456789012345678901',
        'worker=worker-0123456789012345678901'
      ].join(';')
    }, { requireRoot: false })).toEqual([])
  })

  it('maps execution modes to worker capabilities', () => {
    expect(executionProfile({})).toEqual({ mode: 'local', capabilities: ['java'] })
    expect(executionProfile({ TEST_AGENT_EXECUTION_MODE: 'docker' })).toEqual({ mode: 'docker', capabilities: ['java', 'docker'] })
    expect(() => executionProfile({ TEST_AGENT_EXECUTION_MODE: 'remote' })).toThrow(/local or docker/)
  })
})
