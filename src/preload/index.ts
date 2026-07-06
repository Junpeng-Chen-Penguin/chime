import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 统一事件通道 chat:event：一轮 = turn-start → item-* 序列 → turn-done（结构见主进程 engine）
interface ChatEvent {
  type: 'turn-start' | 'item-start' | 'item-delta' | 'item-done' | 'turn-done' | 'notice'
  streamId: string
  [k: string]: unknown
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
  autoTitle: (input: { convId: string; userText: string; assistantText: string }) =>
    ipcRenderer.invoke('conv:autotitle', input),

  // 渲染层只发「会话 + 一句话」，历史组装与落库都在主进程
  sendChat: (payload: { streamId: string; convId: string; text: string; model: string }) =>
    ipcRenderer.send('chat:send', payload),
  retryChat: (payload: { streamId: string; convId: string; model: string }) =>
    ipcRenderer.send('chat:retry', payload),
  stopChat: (streamId: string) => ipcRenderer.send('chat:stop', streamId),

  getKb: () => ipcRenderer.invoke('kb:get'),
  kbBuild: (input: { path: string; name: string }) => ipcRenderer.invoke('kb:build', input),
  kbRefresh: () => ipcRenderer.invoke('kb:refresh'),
  kbRename: (name: string) => ipcRenderer.invoke('kb:rename', name),
  kbRemove: () => ipcRenderer.invoke('kb:remove'),
  setConversationKb: (input: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('conv:setKb', input),
  openDoc: (filePath: string) => ipcRenderer.invoke('doc:open', filePath),
  onKbProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: unknown): void => cb(p)
    ipcRenderer.on('kb:progress', h)
    return () => ipcRenderer.removeListener('kb:progress', h)
  },

  // 订阅统一事件通道，返回取消订阅函数
  onChatEvent: (cb: (evt: ChatEvent) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, evt: ChatEvent): void => cb(evt)
    ipcRenderer.on('chat:event', h)
    return () => ipcRenderer.removeListener('chat:event', h)
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
