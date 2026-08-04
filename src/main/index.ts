import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { basename } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TaskEngine } from './task-engine.js'
import { createAgentAdapter } from './agent/factory.js'
import { resolveClaudeExecutable } from './agent/claude-code-adapter.js'
import { resolveCodexExecutable } from './agent/codex-cli-adapter.js'
import type { TaskInput } from '../shared/contracts.js'

let mainWindow: BrowserWindow | null = null
const execFileAsync = promisify(execFile)

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
    if (!mainWindow) throw new Error('Main window is not ready')
    if (!input.projectPath || !input.systemName || input.testTypes.length === 0) {
      throw new Error('项目目录、系统名称和测试类型不能为空')
    }
    return new TaskEngine(mainWindow, createAgentAdapter()).start(input)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
