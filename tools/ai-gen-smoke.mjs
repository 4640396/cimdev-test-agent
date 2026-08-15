import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostCli = resolve(here, '..', 'out', 'main', 'host-cli.js')
const projectPath = process.argv[2] ?? resolve(here, 'ai-gen-sample')

const child = spawn(process.execPath, [hostCli], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TEST_AGENT_AI_MODE: 'true',
    TEST_AGENT_HOST_CAPABILITIES: 'windows,node,codex-cli,playwright',
    TEST_AGENT_ALLOWED_PROJECT_ROOTS: projectPath,
    CODEX_CLI_TIMEOUT_MS: '360000'
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

const lines = createInterface({ input: child.stdout })
let seq = 0
const nextId = () => `smoke-${++seq}`

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function log(kind, payload) {
  if (kind === 'event') {
    process.stdout.write(`[${payload?.event?.level ?? 'info'}] ${payload?.event?.message ?? ''}\n`)
  } else if (kind === 'handshake') {
    process.stdout.write(`HANDSHAKE ok=${payload?.ok} caps=${(payload?.capabilities ?? []).join(',')}\n`)
  } else if (kind === 'run-accepted') {
    process.stdout.write(`RUN_ACCEPTED ${payload?.executionId}\n`)
  } else if (kind === 'run-result') {
    const report = payload?.outcome?.report ?? payload?.outcome?.adapterResult?.report
    process.stdout.write(`RUN_RESULT passed=${report?.passed} failed=${report?.failed} coverage=${report?.coverage ?? 'N/A'} gate=${payload?.outcome?.gate?.passed}\n`)
  } else if (kind === 'run-error') {
    process.stdout.write(`RUN_ERROR ${payload?.error}\n`)
  } else if (kind === 'error') {
    process.stdout.write(`PROTOCOL_ERROR ${payload?.message}\n`)
  }
}

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  child.stdin.end()
  setTimeout(() => child.kill(), 2000).unref()
  process.exitCode = code
}

lines.on('line', (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  log(message.kind, message)
  if (message.kind === 'run-result') finish(message.outcome?.gate?.passed ? 0 : 2)
  else if (message.kind === 'run-error') finish(1)
  else if (message.kind === 'error') finish(1)
})

child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('exit', (code) => {
  if (!finished) {
    process.stdout.write(`HOST_EXITED ${code ?? 'unknown'}\n`)
    finish(code ?? 1)
  }
})

send({ id: nextId(), kind: 'handshake', protocolVersion: 1 })
send({
  id: nextId(),
  kind: 'run',
  executionId: `ai-gen-smoke-${Date.now()}`,
  input: {
    projectPath,
    systemName: 'ai-gen-sample',
    version: 'smoke',
    testTypes: ['unit'],
    coverageTarget: 60
  }
})
