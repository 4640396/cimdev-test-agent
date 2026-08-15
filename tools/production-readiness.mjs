import { access, readFile, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const placeholder = /(change[-_ ]?me|replace[-_ ]?with|example|<[^>]+>)/i

export function parseRoleTokens(value) {
  const roles = new Map()
  for (const assignment of String(value ?? '').split(';')) {
    if (!assignment.trim()) continue
    const separator = assignment.indexOf('=')
    if (separator < 1) throw new Error(`Invalid role token assignment: ${assignment}`)
    const role = assignment.slice(0, separator).trim()
    const tokens = assignment.slice(separator + 1).split('|').map((item) => item.trim()).filter(Boolean)
    if (!['admin', 'operator', 'viewer', 'worker'].includes(role) || tokens.length === 0) {
      throw new Error(`Invalid role token assignment: ${assignment}`)
    }
    roles.set(role, tokens)
  }
  return roles
}

export function validateProductionSecrets(environment, { requireRoot = true } = {}) {
  const errors = []
  const required = ['TEST_AGENT_MYSQL_PASSWORD', 'TEST_AGENT_ROLE_TOKENS']
  if (requireRoot) required.unshift('MYSQL_ROOT_PASSWORD')
  for (const name of required) {
    const value = environment[name]?.trim()
    if (!value) errors.push(`${name} is required`)
    else if (placeholder.test(value)) errors.push(`${name} still contains a placeholder`)
  }
  for (const name of requireRoot ? ['MYSQL_ROOT_PASSWORD', 'TEST_AGENT_MYSQL_PASSWORD'] : ['TEST_AGENT_MYSQL_PASSWORD']) {
    const value = environment[name]?.trim() ?? ''
    if (value && value.length < 24) errors.push(`${name} must be at least 24 characters`)
  }
  try {
    const roles = parseRoleTokens(environment.TEST_AGENT_ROLE_TOKENS)
    const allTokens = []
    for (const role of ['admin', 'operator', 'viewer', 'worker']) {
      if (!roles.has(role)) errors.push(`TEST_AGENT_ROLE_TOKENS is missing ${role}`)
      allTokens.push(...(roles.get(role) ?? []))
    }
    if (new Set(allTokens).size !== allTokens.length) errors.push('Role tokens must be unique across roles')
    if (allTokens.some((token) => token.length < 24)) errors.push('Every role token must be at least 24 characters')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return errors
}

export function executionProfile(environment) {
  const mode = (environment.TEST_AGENT_EXECUTION_MODE ?? 'local').trim().toLowerCase()
  if (!['local', 'docker'].includes(mode)) throw new Error('TEST_AGENT_EXECUTION_MODE must be local or docker')
  return {
    mode,
    capabilities: mode === 'docker' ? ['java', 'docker'] : ['java']
  }
}

function command(name, args) {
  return new Promise((resolveCommand) => {
    const child = spawn(name, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => resolveCommand({ ok: false, detail: error.message }))
    child.once('close', (code) => resolveCommand({ ok: code === 0, detail: code === 0 ? 'ok' : stderr.trim() || `exit ${code}` }))
  })
}

async function checkFile(relative, contains) {
  const path = join(root, relative)
  try {
    await access(path, constants.R_OK)
    const content = contains ? await readFile(path, 'utf8') : ''
    return { ok: !contains || contains.every((value) => content.includes(value)), detail: relative }
  } catch (error) {
    return { ok: false, detail: `${relative}: ${error instanceof Error ? error.message : error}` }
  }
}

export async function staticChecks() {
  const jars = await readdir(join(root, 'services/control-server/target')).catch(() => [])
  const serverJar = jars.find((name) => /^test-agent-server-.+\.jar$/.test(name) && !name.endsWith('.jar.original'))
  return [
    ['server jar', serverJar
      ? await checkFile(`services/control-server/target/${serverJar}`)
      : { ok: false, detail: 'services/control-server/target/test-agent-server-*.jar' }],
    ['worker bundle', await checkFile('out/main/worker-cli.js')],
    ['migrations', await checkFile('services/control-server/src/main/resources/db/migration/V5__completion_idempotency.sql')],
    ['container isolation', await checkFile('deploy/docker-compose.yml', ['read_only: true', 'cap_drop:', 'no-new-privileges:true', 'TEST_AGENT_ROLE_TOKENS'])],
    ['non-root server', await checkFile('deploy/Dockerfile.server', ['USER testagent'])],
    ['readiness gate', await checkFile('services/control-server/src/main/resources/application.yml', ['runtimeReadiness', 'readinessState'])]
  ]
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

export async function productionChecks(environment) {
  const checks = []
  let profile
  try {
    profile = executionProfile(environment)
    checks.push(['execution profile', { ok: true, detail: profile.mode }])
  } catch (error) {
    checks.push(['execution profile', { ok: false, detail: error instanceof Error ? error.message : String(error) }])
    profile = { mode: 'local', capabilities: ['java'] }
  }
  const secretErrors = validateProductionSecrets(environment, { requireRoot: profile.mode === 'docker' })
  checks.push(['production secrets', { ok: secretErrors.length === 0, detail: secretErrors.join('; ') || 'configured' }])

  if (profile.mode === 'docker') {
    const repository = environment.TEST_AGENT_MAVEN_REPOSITORY?.trim()
    let repositoryResult = { ok: false, detail: 'TEST_AGENT_MAVEN_REPOSITORY is required' }
    if (repository && isAbsolute(repository)) {
      try {
        await access(repository, constants.R_OK)
        repositoryResult = { ok: true, detail: 'configured and readable' }
      } catch (error) {
        repositoryResult = { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    } else if (repository) repositoryResult = { ok: false, detail: 'TEST_AGENT_MAVEN_REPOSITORY must be absolute' }
    checks.push(['offline Maven repository', repositoryResult])
    checks.push(['docker engine', await command('docker', ['version'])])
    checks.push(['compose model', await command('docker', ['compose', '--env-file', 'deploy/.env', '-f', 'deploy/docker-compose.yml', 'config', '--quiet'])])
  } else {
    const roots = String(environment.TEST_AGENT_ALLOWED_PROJECT_ROOTS ?? '').split(delimiter).map((item) => item.trim()).filter(Boolean)
    let rootsResult = { ok: roots.length > 0, detail: roots.length > 0 ? `${roots.length} configured root(s)` : 'TEST_AGENT_ALLOWED_PROJECT_ROOTS is required for local production execution' }
    for (const projectRoot of roots) {
      if (!isAbsolute(projectRoot)) {
        rootsResult = { ok: false, detail: `Project root must be absolute: ${projectRoot}` }
        break
      }
      try {
        await access(projectRoot, constants.R_OK)
      } catch (error) {
        rootsResult = { ok: false, detail: `${projectRoot}: ${error instanceof Error ? error.message : String(error)}` }
        break
      }
    }
    checks.push(['local project allowlist', rootsResult])
  }

  const server = (environment.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:18088').replace(/\/$/, '')
  try {
    const readiness = await fetchJson(`${server}/actuator/health/readiness`)
    checks.push(['control readiness', { ok: readiness.ok && readiness.body.status === 'UP', detail: `HTTP ${readiness.status} ${readiness.body.status ?? ''}`.trim() }])
  } catch (error) {
    checks.push(['control readiness', { ok: false, detail: error instanceof Error ? error.message : String(error) }])
  }

  try {
    const roles = parseRoleTokens(environment.TEST_AGENT_ROLE_TOKENS)
    const admin = roles.get('admin')?.[0]
    const runtime = await fetchJson(`${server}/api/runtime`, { headers: { authorization: `Bearer ${admin}` } })
    const workers = Array.isArray(runtime.body.workers) ? runtime.body.workers : []
    const eligible = workers.some((worker) => worker.status === 'ONLINE' && Array.isArray(worker.capabilities)
      && profile.capabilities.every((capability) => worker.capabilities.includes(capability)))
    checks.push(['execution worker online', { ok: runtime.ok && eligible, detail: `${workers.length} registered worker(s); requires ${profile.capabilities.join('+')}` }])
  } catch (error) {
    checks.push(['execution worker online', { ok: false, detail: error instanceof Error ? error.message : String(error) }])
  }
  return checks
}

function print(checks) {
  for (const [name, result] of checks) process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${name}: ${result.detail}\n`)
  return checks.every(([, result]) => result.ok)
}

async function main() {
  const mode = process.argv.includes('--production') ? 'production' : 'static'
  const checks = [...await staticChecks()]
  if (mode === 'production') checks.push(...await productionChecks(process.env))
  process.exitCode = print(checks) ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
