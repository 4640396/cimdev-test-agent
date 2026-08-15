import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { LocalHostStatus, TaskInput, TaskSnapshot, TestType } from '../../../../contracts/src/contracts.js'
import { createStdioHostIO, LocalHostClient } from './local-host-client.js'

let mainWindow: BrowserWindow | null = null
const execFileAsync = promisify(execFile)
const serverUrl = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const taskWatchers = new Map<string, NodeJS.Timeout>()
let knowledgeRoots: string[] = []
let localHostClient: LocalHostClient | null = null

interface ServerTask {
  id: string
  input: TaskInput
  status: string
  logs: Array<{ id: number; level: 'info' | 'success' | 'warning' | 'error'; message: string; createdAt: string }>
  report: TaskSnapshot['report'] | null
  artifacts: string[] | null
  errorMessage: string | null
}

async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = process.env.TEST_AGENT_API_TOKEN
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } })
  if (!response.ok) throw new Error(`Java服务请求失败：${response.status} ${await response.text()}`)
  return response.status === 204 ? undefined as T : await response.json() as T
}

function taskSnapshot(task: ServerTask): TaskSnapshot {
  const statusMap: Record<string, TaskSnapshot['status']> = { QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled', NEEDS_REVIEW: 'needsReview' }
  const status = statusMap[task.status] ?? 'planning'
  const laneStatus = status === 'completed' ? (task.report?.failed === 0 ? 'passed' : 'failed') : status === 'failed' || status === 'cancelled' || status === 'needsReview' ? 'failed' : status === 'running' ? 'running' : 'pending'
  return {
    taskId: task.id,
    status,
    logs: task.logs.map((log) => ({ id: String(log.id), time: new Date(log.createdAt).toLocaleTimeString('zh-CN', { hour12: false }), level: log.level, message: log.message })),
    lanes: task.input.testTypes.map((type: TestType) => ({ type, status: laneStatus, summary: task.errorMessage ?? (status === 'completed' ? '真实测试执行完成' : status === 'running' ? 'Worker执行中' : '等待Worker') })),
    artifacts: task.artifacts ?? [],
    report: task.report ?? undefined
  }
}

function watchTask(taskId: string): void {
  if (taskWatchers.has(taskId)) return
  const poll = async (): Promise<void> => {
    try {
      const task = await serverRequest<ServerTask>(`/api/tasks/${taskId}`)
      mainWindow?.webContents.send('task:snapshot', taskSnapshot(task))
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
        const timer = taskWatchers.get(taskId)
        if (timer) clearInterval(timer)
        taskWatchers.delete(taskId)
      }
    } catch (error) {
      console.error('Task polling failed', error)
    }
  }
  void poll()
  taskWatchers.set(taskId, setInterval(() => { void poll() }, 1000))
}

function ensureLocalHostClient(): LocalHostClient {
  if (localHostClient) return localHostClient
  const hostCliPath = process.env.TEST_AGENT_HOST_CLI_PATH ?? join(app.getAppPath(), 'out', 'main', 'host-cli.js')
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TEST_AGENT_HOST_CAPABILITIES: process.env.TEST_AGENT_HOST_CAPABILITIES ?? 'windows,node,codex-cli,go,java,vue,playwright',
    TEST_AGENT_AI_MODE: process.env.TEST_AGENT_AI_MODE ?? 'true'
  }
  const io = createStdioHostIO(process.execPath, [hostCliPath], { cwd: process.cwd(), env })
  const client = new LocalHostClient(io)
  client.onMessage((message) => mainWindow?.webContents.send('host:message', message))
  localHostClient = client
  return client
}

async function detectVersion(projectPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: projectPath,
      windowsHide: true,
      timeout: 3000
    })
    return stdout.trim() || '未识别'
  } catch {
    return '未识别'
  }
}

function detectTestTypes(projectPath: string): TestType[] {
  const hasPlaywright = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'playwright.config.cjs']
    .some((name) => existsSync(join(projectPath, name)))
  if (hasPlaywright) return ['ui']
  if (existsSync(join(projectPath, 'pom.xml'))) return ['unit', 'regression']
  if (existsSync(join(projectPath, 'package.json'))) return ['unit']
  return ['unit']
}

function reportSummaryText(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  const lines = [
    'CIMDEV 测试报告',
    `任务：${snapshot.taskId}`,
    `状态：${snapshot.status}`,
    `通过：${report?.passed ?? '--'}`,
    `失败：${report?.failed ?? '--'}`,
    `覆盖率：${report?.coverage === null || report?.coverage === undefined ? 'N/A' : `${report.coverage}%`}`,
    report?.gate ? `质量门禁：${report.gate.passed ? '通过' : '未通过'}` : '质量门禁：--'
  ]
  if (report?.summary) lines.push(`结论：${report.summary}`)
  if (report?.failedCases?.length) {
    lines.push('失败用例：')
    for (const item of report.failedCases) lines.push(`- ${item.name}：${item.error}`)
  }
  return lines.join('\n')
}

function reportMarkdown(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  let md = `# CIMDEV 测试报告\n\n- 任务：\`${snapshot.taskId}\`\n- 状态：${snapshot.status}\n`
  if (report) {
    md += `- 通过：${report.passed}\n- 失败：${report.failed}\n- 覆盖率：${report.coverage === null ? 'N/A' : `${report.coverage}%`}\n`
    if (report.gate) md += `- 质量门禁：${report.gate.passed ? '通过' : '未通过'}\n`
    if (report.durationMs !== undefined) md += `- 耗时：${Math.round(report.durationMs / 1000)}s\n`
    if (report.summary) md += `\n## 结论\n\n${report.summary}\n`
    if (report.cases?.length) {
      md += `\n## 测试计划（${report.cases.length} 条）\n\n| 用例 | 层级 | 优先级 | 场景 | 预期 |\n|---|---|---|---|---|\n`
      for (const item of report.cases) md += `| ${item.title} | ${item.layer ?? '-'} | ${item.priority} | ${item.scenario} | ${item.expected} |\n`
    }
    if (report.failedCases?.length) {
      md += `\n## 失败用例\n\n| 用例 | 层级 | 错误 | 建议 |\n|---|---|---|---|\n`
      for (const item of report.failedCases) md += `| ${item.name} | ${item.layer} | ${item.error} | ${item.suggestion ?? '-'} |\n`
    }
  }
  return md
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

function reportHtml(snapshot: TaskSnapshot): string {
  const report = snapshot.report
  const coverageText = report?.coverage === null || report?.coverage === undefined ? 'N/A' : `${report.coverage}%`
  const caseRows = (report?.cases ?? []).map((item) => `<tr><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.layer ?? '-')}</td><td>${escapeHtml(item.priority)}</td><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.expected)}</td></tr>`).join('')
  const failedRows = (report?.failedCases ?? []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.layer)}</td><td>${escapeHtml(item.error)}</td><td>${escapeHtml(item.suggestion ?? '-')}</td></tr>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>CIMDEV 测试报告</title><body style="font-family:system-ui"><h1>CIMDEV 测试报告</h1><p>通过 ${report?.passed ?? '--'} · 失败 ${report?.failed ?? '--'} · 覆盖率 ${coverageText}</p>${report?.summary ? `<p>${escapeHtml(report.summary)}</p>` : ''}<h2>测试计划</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>用例</th><th>层级</th><th>优先级</th><th>场景</th><th>预期</th></tr>${caseRows}</table><h2>失败用例</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>用例</th><th>层级</th><th>错误</th><th>建议</th></tr>${failedRows}</table></body>`
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f6fa',
    title: 'CIMDEV Test Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  if (process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { role: 'quit', label: 'Exit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' }, { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { role: 'about', label: 'About CIMDEV Test Agent' }
      ]
    },
    {
      label: 'Configure',
      submenu: [
        {
          label: 'Knowledge Base Directory…',
          click: async () => {
            if (!mainWindow) return
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'], title: 'Select knowledge base directories' })
            if (result.canceled) return
            knowledgeRoots = result.filePaths
            mainWindow.webContents.send('config:changed', knowledgeRoots)
          }
        }
      ]
    }
  ]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  buildMenu()
  ipcMain.handle('config:getKnowledgeRoots', () => knowledgeRoots)
  ipcMain.handle('project:select', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled) return null
    const path = result.filePaths[0]
    return {
      path,
      detectedSystem: basename(path),
      detectedVersion: await detectVersion(path),
      detectedTestTypes: detectTestTypes(path)
    }
  })

  ipcMain.handle('project:detect', async (_event, path: string) => {
    if (!path || !existsSync(path)) return null
    return {
      path,
      detectedSystem: basename(path),
      detectedVersion: await detectVersion(path),
      detectedTestTypes: detectTestTypes(path)
    }
  })

  ipcMain.handle('report:export', async (_event, format: 'markdown' | 'html' | 'json', snapshot: TaskSnapshot) => {
    if (!mainWindow) return { saved: false, error: 'window unavailable' }
    const extension = format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'
    const content = format === 'json' ? JSON.stringify(snapshot, null, 2) : format === 'html' ? reportHtml(snapshot) : reportMarkdown(snapshot)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出测试报告',
      defaultPath: `test-report.${extension}`,
      filters: [{ name: format, extensions: [extension] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    try {
      writeFileSync(result.filePath, content, 'utf8')
      return { saved: true, path: result.filePath }
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('report:copy', async (_event, snapshot: TaskSnapshot) => {
    clipboard.writeText(reportSummaryText(snapshot))
    return { copied: true }
  })

  ipcMain.handle('runtime:status', async () => {
    try {
      await serverRequest('/actuator/health')
      const runtime = await serverRequest<{ workers?: Array<{ status?: string; capabilities?: string[] }> }>('/api/runtime')
      const onlineWorkers = (runtime.workers ?? []).filter((worker) => worker.status === 'ONLINE')
      const providers = [...new Set(onlineWorkers.flatMap((worker) => worker.capabilities ?? []).filter((capability) => capability.endsWith('-cli') || capability === 'cimicode'))]
      return {
        mode: onlineWorkers.length > 0 ? 'real' : 'unavailable',
        provider: providers.join(', ') || null,
        message: onlineWorkers.length > 0
          ? `Java控制服务已连接，在线Worker ${onlineWorkers.length}个`
          : 'Java控制服务已连接，当前没有在线Worker'
      }
    } catch {
      return { mode: 'unavailable', provider: null, message: `Java控制服务不可用：${serverUrl}` }
    }
  })

  ipcMain.handle('task:start', async (_event, input: TaskInput) => {
    const mergedInput = knowledgeRoots.length > 0 ? { ...input, knowledgeRoots } : input
    const task = await serverRequest<ServerTask>('/api/tasks', { method: 'POST', body: JSON.stringify({ input: mergedInput, triggerType: 'desktop' }) })
    watchTask(task.id)
    return { taskId: task.id }
  })
  ipcMain.handle('task:get', async (_event, taskId: string) => taskSnapshot(await serverRequest<ServerTask>(`/api/tasks/${taskId}`)))
  ipcMain.handle('task:cancel', async (_event, taskId: string) => taskSnapshot(await serverRequest<ServerTask>(`/api/tasks/${taskId}/cancel`, { method: 'POST' })))
  ipcMain.handle('task:retry', async (_event, taskId: string) => {
    const task = await serverRequest<ServerTask>(`/api/tasks/${taskId}/retry`, { method: 'POST' })
    watchTask(task.id)
    return { taskId: task.id }
  })
  ipcMain.handle('host:status', async (): Promise<LocalHostStatus> => {
    try {
      const client = ensureLocalHostClient()
      const handshake = await client.handshake()
      if (handshake.kind !== 'handshake') return { running: false, error: 'handshake failed' }
      if (!handshake.ok) return { running: false, error: handshake.error ?? 'handshake rejected' }
      const health = await client.health()
      return {
        running: true,
        protocolVersion: handshake.protocolVersion,
        hostVersion: handshake.hostVersion,
        capabilities: handshake.capabilities,
        activeRuns: health.kind === 'health' ? health.activeRuns : undefined
      }
    } catch (error) {
      return { running: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('host:start', async (_event, input: TaskInput, executionId?: string) => {
    const client = ensureLocalHostClient()
    const id = executionId && executionId.trim() !== '' ? executionId : randomUUID()
    void client.run(input, id).catch((error) => {
      mainWindow?.webContents.send('host:message', { id: '', kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return { taskId: id }
  })
  ipcMain.handle('host:cancel', async (_event, executionId: string) => {
    const client = ensureLocalHostClient()
    const response = await client.cancel(executionId)
    return { cancelled: response.kind === 'cancelled' }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const timer of taskWatchers.values()) clearInterval(timer)
  taskWatchers.clear()
  localHostClient?.close()
  localHostClient = null
})
