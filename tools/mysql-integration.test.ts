import { describe, expect, it } from 'vitest'
// @ts-expect-error Deployment CLI intentionally has no generated declaration file.
import { databaseName, mysqlMavenCommand, parseEnvFile, validateMysqlIntegrationEnvironment } from './mysql-integration.mjs'

describe('real MySQL integration safety', () => {
  it('extracts the target schema from a JDBC URL', () => {
    expect(databaseName('jdbc:mysql://127.0.0.1:3306/test_agent_it?useUnicode=true')).toBe('test_agent_it')
  })

  it('loads local credentials without treating equals signs as separators', () => {
    expect(parseEnvFile("# local only\nTEST_AGENT_MYSQL_IT_USER='tester'\nTEST_AGENT_MYSQL_IT_PASSWORD=a=b=c\n"))
      .toEqual({ TEST_AGENT_MYSQL_IT_USER: 'tester', TEST_AGENT_MYSQL_IT_PASSWORD: 'a=b=c' })
  })

  it('refuses production, system and ambiguous database targets', () => {
    for (const name of ['mysql', 'cimdev_test_agent', 'unmarked_database']) {
      expect(validateMysqlIntegrationEnvironment({
        TEST_AGENT_MYSQL_IT_URL: `jdbc:mysql://127.0.0.1:3306/${name}`,
        TEST_AGENT_MYSQL_IT_USER: 'tester',
        TEST_AGENT_MYSQL_IT_PASSWORD: 'secret'
      })).not.toEqual([])
    }
  })

  it('accepts an explicitly scoped integration database', () => {
    expect(validateMysqlIntegrationEnvironment({
      TEST_AGENT_MYSQL_IT_URL: 'jdbc:mysql://127.0.0.1:3306/cimdev_test_agent_it',
      TEST_AGENT_MYSQL_IT_USER: 'tester',
      TEST_AGENT_MYSQL_IT_PASSWORD: 'secret'
    })).toEqual([])
  })

  it('uses cmd.exe for Maven batch files on Windows', () => {
    expect(mysqlMavenCommand('win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'mvn.cmd -q -Dtest=ApiIntegrationTest,RuntimeReadinessHealthIndicatorTest test']
    })
  })
})
