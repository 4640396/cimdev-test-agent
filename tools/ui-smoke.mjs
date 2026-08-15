import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostCli = resolve(here, '..', 'out', 'main', 'host-cli.js')
const projectPath = resolve(here, 'ui-sample-project')

const child = spawn(process.execPath, [hostCli], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TEST_AGENT_PROVIDER: 'node',
    TEST_AGENT_AI_MODE: 'false',
    TEST_AGENT_HOST_CAPABILITIES: 'windows,node,codex-cli,playwright',
    TEST_AGENT_ALLOWED_PROJECT_ROOTS: projectPath
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

const lines = createInterface({ input: child.stdout })
let seq = 0
const nextId = () => `ui-smoke-${++seq}`

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
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
  if (message.kind === 'event') {
    process.stdout.write(`[${message.event?.level ?? 'info'}] ${message.event?.message ?? ''}\n`)
  } else if (message.kind === 'run-result') {
    const report = message.outcome?.report
    const screenshots = report?.screenshots ?? []
    process.stdout.write(`RUN_RESULT passed=${report?.passed} failed=${report?.failed} screenshots=${screenshots.length}\n`)
    for (const shot of screenshots) process.stdout.write(`SCREENSHOT ${shot}\n`)
    finish(screenshots.length > 0 && report?.failed === 0 ? 0 : 2)
  } else if (message.kind === 'run-error') {
    process.stdout.write(`RUN_ERROR ${message.error}\n`)
    finish(1)
  } else if (message.kind === 'error') {
    process.stdout.write(`PROTOCOL_ERROR ${message.message}\n`)
    finish(1)
  }
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
  executionId: `ui-smoke-${Date.now()}`,
  input: {
    projectPath,
    systemName: 'ui-sample-project',
    version: 'smoke',
    testTypes: ['ui'],
    coverageTarget: 0
  }
})
