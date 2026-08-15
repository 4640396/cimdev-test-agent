import { delimiter, isAbsolute } from 'node:path'
import { executionProfile, parseRoleTokens } from './production-readiness.mjs'

const terminal = new Set(['COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'])

async function jsonRequest(server, path, token, init = {}) {
  const response = await fetch(`${server}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000)
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}

export function validateE2eEnvironment(environment) {
  const issues = []
  try {
    executionProfile(environment)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  if (!environment.TEST_AGENT_SERVER_URL) issues.push('TEST_AGENT_SERVER_URL is required')
  const paths = e2eProjectPaths(environment)
  if (paths.length !== 2) issues.push('TEST_AGENT_E2E_PROJECT_PATHS must contain exactly two isolated project paths')
  if (paths.some((path) => !isAbsolute(path))) issues.push('Every TEST_AGENT_E2E_PROJECT_PATHS entry must be absolute')
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) issues.push('E2E project paths must be distinct')
  try {
    if (!parseRoleTokens(environment.TEST_AGENT_ROLE_TOKENS).get('admin')?.[0]) issues.push('An admin role token is required')
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  return issues
}

export function e2eProjectPaths(environment) {
  return String(environment.TEST_AGENT_E2E_PROJECT_PATHS ?? '')
    .split(delimiter).map((path) => path.trim()).filter(Boolean)
}

async function waitForTask(server, token, id, deadline) {
  while (Date.now() < deadline) {
    const task = await jsonRequest(server, `/api/tasks/${id}`, token)
    if (terminal.has(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  throw new Error(`Task ${id} did not finish before the E2E deadline`)
}

async function main() {
  if (!process.argv.includes('--confirm-production-e2e')) {
    throw new Error('Refusing to create real tasks without --confirm-production-e2e')
  }
  const issues = validateE2eEnvironment(process.env)
  if (issues.length > 0) throw new Error(issues.join('; '))

  const server = process.env.TEST_AGENT_SERVER_URL.replace(/\/$/, '')
  const admin = parseRoleTokens(process.env.TEST_AGENT_ROLE_TOKENS).get('admin')[0]
  const profile = executionProfile(process.env)
  const projectPaths = e2eProjectPaths(process.env)
  const runtime = await jsonRequest(server, '/api/runtime', admin)
  const workers = (runtime.workers ?? []).filter((worker) => worker.status === 'ONLINE'
    && profile.capabilities.every((capability) => worker.capabilities?.includes(capability)))
  if (workers.length < 2) throw new Error(`Production E2E requires at least two ONLINE ${profile.capabilities.join('+')} workers; found ${workers.length}`)

  const run = new Date().toISOString().replace(/[:.]/g, '-')
  const requests = [1, 2].map((number) => jsonRequest(server, '/api/tasks', admin, {
    method: 'POST',
    body: JSON.stringify({
      input: {
        projectPath: projectPaths[number - 1],
        systemName: `production-e2e-${number}`,
        version: run,
        testTypes: ['unit'],
        requiredCapabilities: profile.capabilities,
        coverageTarget: 0
      },
      triggerType: 'production-e2e',
      idempotencyKey: `production-e2e:${run}:${number}`
    })
  }))
  const created = await Promise.all(requests)
  const deadline = Date.now() + Number(process.env.TEST_AGENT_E2E_TIMEOUT_MS ?? 900_000)
  const results = await Promise.all(created.map((task) => waitForTask(server, admin, task.id, deadline)))

  const failures = results.filter((task) => task.status !== 'COMPLETED' || task.report?.gate?.passed !== true)
  if (failures.length > 0) throw new Error(`E2E quality gate failed: ${failures.map((task) => `${task.id}=${task.status}`).join(', ')}`)
  const workerIds = new Set(results.map((task) => task.workerId).filter(Boolean))
  if (workerIds.size < 2) throw new Error(`Tasks passed but multi-worker distribution was not proven; workers=${[...workerIds].join(',')}`)
  process.stdout.write(`PASS production E2E: ${results.map((task) => `${task.id}@${task.workerId}`).join(', ')}\n`)
}

if (process.argv[1]?.endsWith('production-e2e.mjs')) main().catch((error) => {
  process.stderr.write(`FAIL production E2E: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
