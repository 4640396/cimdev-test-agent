import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveClaudeExecutable } from './agent/claude-code-adapter.js'
import { resolveCodexExecutable } from './agent/codex-cli-adapter.js'
import type { TaskInput, TaskSnapshot, TestType } from '../shared/contracts.js'

let mainWindow: BrowserWindow | null = null
const execFileAsync = promisify(execFile)
const serverUrl = (process.env.TEST_AGENT_SERVER_URL ?? 'http://127.0.0.1:8088').replace(/\/$/, '')
const taskWatchers = new Map<string, NodeJS.Timeout>()

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
  const statusMap: Record<string, TaskSnapshot['status']> = { QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' }
  const status = statusMap[task.status] ?? 'planning'
  const laneStatus = status === 'completed' ? (task.report?.failed === 0 ? 'passed' : 'failed') : status === 'failed' || status === 'cancelled' ? 'failed' : status === 'running' ? 'running' : 'pending'
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

app.whenReady().then(() => {
  ipcMain.handle('project:select', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled) return null
    const path = result.filePaths[0]
    return {
      path,
      detectedSystem: basename(path),
      detectedVersion: await detectVersion(path)
    }
  })

  ipcMain.handle('runtime:status', async () => {
    try {
      await serverRequest('/actuator/health')
    } catch {
      return { mode: 'unavailable', provider: null, message: `Java控制服务不可用：${serverUrl}` }
    }
    if (process.env.TEST_AGENT_PROVIDER === 'cimicode') {
      const configured = process.env.CIMICODE_ENABLE_REAL === 'true' && Boolean(process.env.CIMICODE_EXECUTABLE)
      return {
        mode: configured ? 'real' : 'unavailable',
        provider: configured ? 'cimicode' : null,
        message: configured ? '真实模式：CimiCode' : 'CimiCode 尚未完成真实调用配置'
      }
    }
    if (process.env.TEST_AGENT_PROVIDER === 'codex-cli') {
      const executable = resolveCodexExecutable()
      if (!executable) return { mode: 'unavailable', provider: null, message: '未找到可调用的 Codex CLI' }
      try {
        const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : executable
        const args = process.platform === 'win32'
          ? ['/d', '/s', '/c', executable, 'login', 'status']
          : ['login', 'status']
        const { stdout, stderr } = await execFileAsync(command, args, { windowsHide: true, timeout: 10000 })
        const status = `${stdout}\n${stderr}`
        return /Logged in/i.test(status)
          ? { mode: 'real', provider: 'codex-cli', message: '真实模式：Codex CLI 已登录' }
          : { mode: 'unavailable', provider: 'codex-cli', message: 'Codex CLI 已安装但尚未登录，请先执行 codex login' }
      } catch {
        return { mode: 'unavailable', provider: 'codex-cli', message: 'Codex CLI 存在，但登录状态检查失败' }
      }
    }
    if (process.env.TEST_AGENT_PROVIDER !== 'claude-code') {
      return { mode: 'real', provider: 'local-go', message: '真实模式：Local Go Runner；Claude Code 可作为后续增强层' }
    }
    const executable = resolveClaudeExecutable()
    if (!executable) return { mode: 'unavailable', provider: null, message: '未安装 Claude Code' }
    if (process.env.ANTHROPIC_API_KEY) {
      return { mode: 'real', provider: 'claude-code', message: '真实模式：Claude Code 使用 ANTHROPIC_API_KEY' }
    }
    if (process.env.ANTHROPIC_AUTH_TOKEN && process.env.ANTHROPIC_BASE_URL) {
      return { mode: 'real', provider: 'claude-code', message: '真实模式：Claude Code 使用企业 LLM Gateway' }
    }
    try {
      const { stdout } = await execFileAsync(executable, ['auth', 'status'], { windowsHide: true, timeout: 5000 })
      const status = JSON.parse(stdout) as { loggedIn?: boolean }
      return status.loggedIn
        ? { mode: 'real', provider: 'claude-code', message: '真实模式：Claude Code 已登录' }
        : { mode: 'unavailable', provider: 'claude-code', message: 'Claude Code 已安装但尚未登录，请先执行 claude auth login' }
    } catch {
      return { mode: 'unavailable', provider: 'claude-code', message: '无法读取 Claude Code 登录状态' }
    }
  })

  ipcMain.handle('task:start', async (_event, input: TaskInput) => {
    const task = await serverRequest<ServerTask>('/api/tasks', { method: 'POST', body: JSON.stringify({ input, triggerType: 'desktop' }) })
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
})
