import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, LocalHostApi, TaskInput, TaskSnapshot } from '../../../../contracts/src/contracts.js'

const api: DesktopApi = {
  selectProject: () => ipcRenderer.invoke('project:select'),
  getKnowledgeRoots: () => ipcRenderer.invoke('config:getKnowledgeRoots'),
  onKnowledgeRootsChanged: (listener: (roots: string[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, roots: string[]) => listener(roots)
    ipcRenderer.on('config:changed', handler)
    return () => ipcRenderer.removeListener('config:changed', handler)
  },
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startTask: (input: TaskInput) => ipcRenderer.invoke('task:start', input),
  getTask: (taskId: string) => ipcRenderer.invoke('task:get', taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke('task:cancel', taskId),
  retryTask: (taskId: string) => ipcRenderer.invoke('task:retry', taskId),
  subscribeTask: (listener: (snapshot: TaskSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: TaskSnapshot) => listener(snapshot)
    ipcRenderer.on('task:snapshot', handler)
    return () => ipcRenderer.removeListener('task:snapshot', handler)
  }
}

const localApi: LocalHostApi = {
  getStatus: () => ipcRenderer.invoke('host:status'),
  start: (input: TaskInput, executionId?: string) => ipcRenderer.invoke('host:start', input, executionId),
  cancel: (executionId: string) => ipcRenderer.invoke('host:cancel', executionId),
  subscribe: (listener: (message: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown) => listener(message)
    ipcRenderer.on('host:message', handler)
    return () => ipcRenderer.removeListener('host:message', handler)
  }
}

contextBridge.exposeInMainWorld('testAgent', api)
contextBridge.exposeInMainWorld('testAgentLocal', localApi)
