import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { TaskEngine } from './task-engine.js'
import { createCimiCodeAdapter } from './cimicode/adapter.js'
import type { TaskInput } from '../shared/contracts.js'

let mainWindow: BrowserWindow | null = null

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
      preload: join(__dirname, '../preload/index.mjs'),
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
  createWindow()

  ipcMain.handle('project:select', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('task:start', async (_event, input: TaskInput) => {
    if (!mainWindow) throw new Error('Main window is not ready')
    if (!input.projectPath || !input.systemName || input.testTypes.length === 0) {
      throw new Error('项目目录、系统名称和测试类型不能为空')
    }
    return new TaskEngine(mainWindow, createCimiCodeAdapter()).start(input)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
