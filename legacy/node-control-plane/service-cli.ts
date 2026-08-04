import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Repository } from './service/repository.js'
import { QaService } from './service/qa-service.js'
import { QaHttpServer } from './service/http-server.js'

const dataDirectory = resolve(process.env.TEST_AGENT_DATA_DIR ?? join(process.cwd(), '.test-agent-service'))
mkdirSync(dataDirectory, { recursive: true })
const host = process.env.TEST_AGENT_API_HOST ?? '127.0.0.1'
const port = Number(process.env.TEST_AGENT_API_PORT ?? 4318)
const repository = new Repository(join(dataDirectory, 'qa-pipeline.sqlite'))
const service = new QaService(repository, Number(process.env.TEST_AGENT_CONCURRENCY ?? 1))
const server = new QaHttpServer(service, host, port)

service.start()
await server.start()
console.log(`CIMDEV Test Agent API listening on http://${host}:${port}`)

async function shutdown(): Promise<void> {
  service.stop()
  await server.stop()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
