import { mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forbiddenDatabases = new Set(['mysql', 'information_schema', 'performance_schema', 'sys', 'cimdev_test_agent'])

export function databaseName(jdbcUrl) {
  const match = /^jdbc:mysql:\/\/[^/]+\/([^?;]+)(?:[?;]|$)/i.exec(String(jdbcUrl ?? '').trim())
  return match ? decodeURIComponent(match[1]) : null
}

export function validateMysqlIntegrationEnvironment(environment) {
  const issues = []
  const url = environment.TEST_AGENT_MYSQL_IT_URL?.trim()
  const name = databaseName(url)
  if (!url) issues.push('TEST_AGENT_MYSQL_IT_URL is required')
  else if (!name) issues.push('TEST_AGENT_MYSQL_IT_URL must be a jdbc:mysql URL with a database name')
  else if (forbiddenDatabases.has(name.toLowerCase()) || !/(?:_it|_test)(?:_\d+)?$/i.test(name)) {
    issues.push('MySQL integration database must be isolated and end with _it or _test; production and system databases are refused')
  }
  if (!environment.TEST_AGENT_MYSQL_IT_USER?.trim()) issues.push('TEST_AGENT_MYSQL_IT_USER is required')
  if (environment.TEST_AGENT_MYSQL_IT_PASSWORD === undefined) issues.push('TEST_AGENT_MYSQL_IT_PASSWORD must be explicitly provided')
  return issues
}

export function parseEnvFile(content) {
  const parsed = {}
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Invalid environment line: ${rawLine}`)
    const name = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    parsed[name] = value
  }
  return parsed
}

function run(command, args, environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: join(root, 'services', 'control-server'),
      env: environment,
      windowsHide: true,
      stdio: 'inherit',
      shell: false
    })
    child.once('error', reject)
    child.once('close', (code) => resolveRun(code ?? 1))
  })
}

export function mysqlMavenCommand(platform = process.platform) {
  const args = ['-q', '-Dtest=ApiIntegrationTest,RuntimeReadinessHealthIndicatorTest', 'test']
  return platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', `mvn.cmd ${args.join(' ')}`] }
    : { command: 'mvn', args }
}

async function main() {
  const localFile = join(root, '.env.mysql-it')
  const local = await readFile(localFile, 'utf8').then(parseEnvFile).catch((error) => {
    if (error?.code === 'ENOENT') return {}
    throw error
  })
  const configuration = { ...local, ...process.env }
  const issues = validateMysqlIntegrationEnvironment(configuration)
  if (issues.length > 0) throw new Error(issues.join('; '))
  const name = databaseName(configuration.TEST_AGENT_MYSQL_IT_URL)
  const artifactRoot = join(root, '.test-agent', 'mysql-it-artifacts', name)
  await mkdir(artifactRoot, { recursive: true })
  const environment = {
    ...process.env,
    SPRING_DATASOURCE_URL: configuration.TEST_AGENT_MYSQL_IT_URL,
    SPRING_DATASOURCE_USERNAME: configuration.TEST_AGENT_MYSQL_IT_USER,
    SPRING_DATASOURCE_PASSWORD: configuration.TEST_AGENT_MYSQL_IT_PASSWORD,
    TEST_AGENT_STORAGE_ROOT: artifactRoot
  }
  const maven = mysqlMavenCommand()
  const passes = Number(configuration.TEST_AGENT_MYSQL_IT_PASSES ?? 2)
  if (!Number.isInteger(passes) || passes < 1 || passes > 3) throw new Error('TEST_AGENT_MYSQL_IT_PASSES must be an integer from 1 to 3')
  for (let pass = 1; pass <= passes; pass++) {
    process.stdout.write(`RUN real MySQL integration ${pass}/${passes}: ${name}\n`)
    const code = await run(maven.command, maven.args, environment)
    if (code !== 0) throw new Error(`Real MySQL integration pass ${pass}/${passes} failed with exit code ${code}`)
  }
  process.stdout.write(`PASS real MySQL integration (${passes} passes): ${name}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  process.stderr.write(`FAIL real MySQL integration: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
