import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import type { TaskInput } from '../../shared/contracts.js'
import type { QaService } from './qa-service.js'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': 'http://127.0.0.1' }

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(value))
}

function match(path: string, pattern: RegExp): RegExpMatchArray | null { return path.match(pattern) }

export class QaHttpServer {
  private server?: Server

  constructor(private readonly service: QaService, private readonly host = '127.0.0.1', private readonly port = 4318) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.route(request, response) })
    await new Promise<void>((resolveStart, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.port, this.host, resolveStart)
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolveStop) => this.server?.close(() => resolveStop()))
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${this.host}:${this.port}`)
    const method = request.method ?? 'GET'
    if (method === 'OPTIONS') { response.writeHead(204, { ...JSON_HEADERS, 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }); response.end(); return }
    try {
      if (method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', service: 'cimdev-test-agent', time: new Date().toISOString() })
      if (method === 'GET' && url.pathname === '/api/runtime') return send(response, 200, this.service.getRuntime())
      if (method === 'GET' && url.pathname === '/api/tasks') return send(response, 200, this.service.listTasks(Number(url.searchParams.get('limit') ?? 100)))
      if (method === 'POST' && url.pathname === '/api/tasks') return send(response, 202, this.service.createTask(await bodyOf(request) as unknown as TaskInput, 'api'))
      if (method === 'GET' && url.pathname === '/api/projects') return send(response, 200, this.service.listProjects())
      if (method === 'POST' && url.pathname === '/api/projects') return send(response, 201, this.service.upsertProject(await bodyOf(request) as never))
      if (method === 'GET' && url.pathname === '/api/schedules') return send(response, 200, this.service.listSchedules())
      if (method === 'POST' && url.pathname === '/api/schedules') {
        const body = await bodyOf(request)
        return send(response, 201, this.service.createSchedule(String(body.projectId ?? ''), Number(body.intervalMinutes), body.enabled !== false))
      }
      if (method === 'POST' && url.pathname === '/api/webhooks/version-release') {
        const body = await bodyOf(request)
        const project = this.service.listProjects().find((item) => item.id === String(body.projectId ?? ''))
        if (!project) return send(response, 404, { error: '项目不存在' })
        const input: TaskInput = { projectPath: project.projectPath, systemName: project.name, version: String(body.version ?? project.defaultVersion), testTypes: Array.isArray(body.testTypes) ? body.testTypes as TaskInput['testTypes'] : project.defaultTestTypes }
        return send(response, 202, this.service.createTask(input, 'version-release'))
      }

      let found = match(url.pathname, /^\/api\/tasks\/([^/]+)$/)
      if (method === 'GET' && found) { const task = this.service.getTask(found[1]); return send(response, task ? 200 : 404, task ?? { error: '任务不存在' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/cancel$/)
      if (method === 'POST' && found) { const task = this.service.cancelTask(found[1]); return send(response, task ? 200 : 404, task ?? { error: '任务不存在' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/retry$/)
      if (method === 'POST' && found) { const task = this.service.retryTask(found[1]); return send(response, task ? 202 : 404, task ?? { error: '任务不存在' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/logs$/)
      if (method === 'GET' && found) { const task = this.service.getTask(found[1]); return send(response, task ? 200 : 404, task?.logs ?? { error: '任务不存在' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/report$/)
      if (method === 'GET' && found) { const task = this.service.getTask(found[1]); return send(response, task ? 200 : 404, task?.report ?? { error: '报告尚未生成' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/artifacts$/)
      if (method === 'GET' && found) { const task = this.service.getTask(found[1]); return send(response, task ? 200 : 404, task?.artifacts ?? { error: '任务不存在' }) }
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/events$/)
      if (method === 'GET' && found) return this.streamEvents(found[1], response)
      found = match(url.pathname, /^\/api\/tasks\/([^/]+)\/artifact$/)
      if (method === 'GET' && found) return this.streamArtifact(found[1], url.searchParams.get('path') ?? '', response)
      found = match(url.pathname, /^\/api\/schedules\/([^/]+)$/)
      if (method === 'PUT' && found) { const schedule = this.service.updateSchedule(found[1], await bodyOf(request)); return send(response, schedule ? 200 : 404, schedule ?? { error: '调度不存在' }) }
      if (method === 'DELETE' && found) return send(response, this.service.deleteSchedule(found[1]) ? 204 : 404, {})
      send(response, 404, { error: '接口不存在' })
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : '请求处理失败' })
    }
  }

  private streamEvents(taskId: string, response: ServerResponse): void {
    const task = this.service.getTask(taskId)
    if (!task) return send(response, 404, { error: '任务不存在' })
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': 'http://127.0.0.1' })
    response.write(`event: snapshot\ndata: ${JSON.stringify(task)}\n\n`)
    const unsubscribe = this.service.subscribeTask(taskId, (snapshot) => response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`))
    response.on('close', unsubscribe)
  }

  private streamArtifact(taskId: string, artifact: string, response: ServerResponse): void {
    const absolute = this.service.getArtifactPath(taskId, artifact)
    if (!absolute) return send(response, 404, { error: '产物不存在' })
    const types: Record<string, string> = { '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }
    response.writeHead(200, { 'content-type': types[extname(absolute).toLowerCase()] ?? 'application/octet-stream', 'content-length': statSync(absolute).size, 'content-disposition': `attachment; filename="${encodeURIComponent(absolute.split(/[\\/]/).pop() ?? 'artifact')}"` })
    createReadStream(absolute).pipe(response)
  }
}
