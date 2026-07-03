import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

interface ChatEvent {
  type: 'chunk' | 'done' | 'stopped' | 'error' | 'sources' | 'step'
  streamId: string
  delta?: string
  kind?: 'content' | 'reasoning'
  error?: string
  sources?: unknown[]
  key?: string
  label?: string
  status?: 'start' | 'end'
  detail?: string
}

// 暴露给渲染进程的 API（明文密钥始终留在主进程）
const api = {
  getProvider: () => ipcRenderer.invoke('provider:get'),
  saveProvider: (input: { baseUrl: string; defaultModel: string; apiKey: string | null }) =>
    ipcRenderer.invoke('provider:save', input),
  detect: (input: { baseUrl: string; apiKey: string | null }) =>
    ipcRenderer.invoke('provider:detect', input),
  getModels: (): Promise<string[]> => ipcRenderer.invoke('provider:models'),

  listConversations: () => ipcRenderer.invoke('conv:list'),
  createConversation: (input: { id: string; model: string }) =>
    ipcRenderer.invoke('conv:create', input),
  deleteConversation: (id: string) => ipcRenderer.invoke('conv:delete', id),
  renameConversation: (id: string, title: string) =>
    ipcRenderer.invoke('conv:rename', { id, title }),
  getMessages: (id: string) => ipcRenderer.invoke('conv:messages', id),
  saveMessage: (m: unknown) => ipcRenderer.invoke('msg:save', m),
  autoTitle: (input: { convId: string; userText: string; assistantText: string }) =>
    ipcRenderer.invoke('conv:autotitle', input),

  sendChat: (payload: { streamId: string; model: string; messages: unknown[]; kb?: boolean }) =>
    ipcRenderer.send('chat:send', payload),
  stopChat: (streamId: string) => ipcRenderer.send('chat:stop', streamId),

  getKb: () => ipcRenderer.invoke('kb:get'),
  kbBuild: (input: { path: string; name: string }) => ipcRenderer.invoke('kb:build', input),
  kbRefresh: () => ipcRenderer.invoke('kb:refresh'),
  kbRename: (name: string) => ipcRenderer.invoke('kb:rename', name),
  kbRemove: () => ipcRenderer.invoke('kb:remove'),
  setConversationKb: (input: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('conv:setKb', input),
  onKbProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: unknown): void => cb(p)
    ipcRenderer.on('kb:progress', h)
    return () => ipcRenderer.removeListener('kb:progress', h)
  },

  // 订阅流式事件，返回取消订阅函数
  onChatEvent: (cb: (evt: ChatEvent) => void): (() => void) => {
    const chunk = (
      _e: IpcRendererEvent,
      d: { streamId: string; delta: string; kind: 'content' | 'reasoning' }
    ): void => cb({ type: 'chunk', ...d })
    const done = (_e: IpcRendererEvent, d: { streamId: string }): void =>
      cb({ type: 'done', ...d })
    const stopped = (_e: IpcRendererEvent, d: { streamId: string }): void =>
      cb({ type: 'stopped', ...d })
    const error = (_e: IpcRendererEvent, d: { streamId: string; error: string }): void =>
      cb({ type: 'error', ...d })
    const sources = (_e: IpcRendererEvent, d: { streamId: string; sources: unknown[] }): void =>
      cb({ type: 'sources', ...d })
    const step = (
      _e: IpcRendererEvent,
      d: { streamId: string; key: string; label: string; status: 'start' | 'end'; detail?: string }
    ): void => cb({ type: 'step', ...d })
    ipcRenderer.on('chat:step', step)
    ipcRenderer.on('chat:chunk', chunk)
    ipcRenderer.on('chat:done', done)
    ipcRenderer.on('chat:stopped', stopped)
    ipcRenderer.on('chat:error', error)
    ipcRenderer.on('chat:sources', sources)
    return () => {
      ipcRenderer.removeListener('chat:step', step)
      ipcRenderer.removeListener('chat:chunk', chunk)
      ipcRenderer.removeListener('chat:done', done)
      ipcRenderer.removeListener('chat:stopped', stopped)
      ipcRenderer.removeListener('chat:error', error)
      ipcRenderer.removeListener('chat:sources', sources)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
