import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, TaskInput, TaskSnapshot } from '../shared/contracts.js'

const api: DesktopApi = {
  selectProject: () => ipcRenderer.invoke('project:select'),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startTask: (input: TaskInput) => ipcRenderer.invoke('task:start', input),
  subscribeTask: (listener: (snapshot: TaskSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: TaskSnapshot) => listener(snapshot)
    ipcRenderer.on('task:snapshot', handler)
    return () => ipcRenderer.removeListener('task:snapshot', handler)
  }
}

contextBridge.exposeInMainWorld('testAgent', api)
