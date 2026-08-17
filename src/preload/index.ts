import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

// 统一事件通道 chat:event：一轮 = turn-start → item-* 序列 → turn-done（结构见主进程 engine）
interface ChatEvent {
  type:
    | 'turn-start'
    | 'item-start'
    | 'item-delta'
    | 'item-done'
    | 'item-update'
    | 'turn-done'
    | 'notice'
  streamId: string
  [k: string]: unknown
}

// 暴露给渲染进程的 API（明文密钥始终留在主进程）
const api = {
  providerList: () => ipcRenderer.invoke('provider:list'),
  providerSave: (input: {
    vendor: string
    apiKey?: string | null
    baseUrl?: string
    enabled?: boolean
    extraParams?: Record<string, unknown>
  }) => ipcRenderer.invoke('provider:save', input),
  providerDetect: (input: { vendor: string; apiKey: string | null }) =>
    ipcRenderer.invoke('provider:detect', input),
  providerFetchModels: (vendor: string) => ipcRenderer.invoke('provider:fetchModels', vendor),
  providerPickModel: (input: { vendor: string; id: string; picked: boolean }) =>
    ipcRenderer.invoke('provider:pickModel', input),
  providerGetDefault: (): Promise<string> => ipcRenderer.invoke('provider:getDefault'),
  providerSetDefault: (ref: string) => ipcRenderer.invoke('provider:setDefault', ref),
  providerMenu: () => ipcRenderer.invoke('provider:menu'),

  listConversations: () => ipcRenderer.invoke('conv:list'),
  createConversation: (input: { id: string; model: string }) =>
    ipcRenderer.invoke('conv:create', input),
  deleteConversation: (id: string) => ipcRenderer.invoke('conv:delete', id),
  renameConversation: (id: string, title: string) =>
    ipcRenderer.invoke('conv:rename', { id, title }),
  getMessages: (id: string) => ipcRenderer.invoke('conv:messages', id),
  autoTitle: (input: { convId: string; userText: string; assistantText: string }) =>
    ipcRenderer.invoke('conv:autotitle', input),

  // 渲染层只发「会话 + 一句话」，历史组装与落库都在主进程；refs 为表格行引用（013 Case 2）；
  // ws 为首条消息随带的工作空间选中集合（015 Case 1），定格后主进程忽略
  sendChat: (payload: {
    streamId: string
    convId: string
    text: string
    model: string
    refs?: { t: 'ref'; artifactId: number; title: string; rowIndexes: number[] }[]
    ws?: { picked: string[]; fromAgent: string[] }
  }) => ipcRenderer.send('chat:send', payload),
  retryChat: (payload: { streamId: string; convId: string; model: string }) =>
    ipcRenderer.send('chat:retry', payload),
  stopChat: (streamId: string) => ipcRenderer.send('chat:stop', streamId),
  // 授权卡回应（同意 / 拒绝）
  cardRespond: (payload: {
    streamId: string
    toolCallId: string
    decision: 'approved' | 'denied'
  }) => ipcRenderer.send('chat:card-response', payload),
  // 提问卡回应（作答 / 直接打字 / 放弃整卡）
  askRespond: (payload: { streamId: string; toolCallId: string; outcome: unknown }) =>
    ipcRenderer.send('chat:ask-response', payload),

  // MCP 服务：mcp:status 为无载荷提醒，收到后重新拉列表即可
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  agentList: () => ipcRenderer.invoke('agent:list'),
  agentSave: (a: unknown) => ipcRenderer.invoke('agent:save', a),
  agentDelete: (id: number) => ipcRenderer.invoke('agent:delete', id),
  agentUsage: (id: number) => ipcRenderer.invoke('agent:usage', id),
  setConversationAgent: (input: unknown) => ipcRenderer.invoke('conv:setAgent', input),
  mcpAckToolsChanged: (id: number) => ipcRenderer.invoke('mcp:ackToolsChanged', id),
  mcpSetTrusted: (input: { id: number; trusted: boolean }) =>
    ipcRenderer.invoke('mcp:setTrusted', input),
  mcpRetry: () => ipcRenderer.invoke('mcp:retry'),
  mcpSave: (input: {
    id?: number
    name: string
    url: string
    headers: Record<string, string> | null
    enabled: boolean
  }) => ipcRenderer.invoke('mcp:save', input),
  mcpDelete: (id: number) => ipcRenderer.invoke('mcp:delete', id),
  mcpTest: (input: { id?: number; url: string; headers: Record<string, string> | null }) =>
    ipcRenderer.invoke('mcp:test', input),
  onMcpStatus: (cb: () => void): (() => void) => {
    const h = (): void => cb()
    ipcRenderer.on('mcp:status', h)
    return () => ipcRenderer.removeListener('mcp:status', h)
  },

  getKb: () => ipcRenderer.invoke('kb:get'),
  kbList: () => ipcRenderer.invoke('kb:list'),
  kbAdd: (input: { name: string; intro: string; path: string }) =>
    ipcRenderer.invoke('kb:add', input),
  kbUpdate: (input: { id: number; name: string; intro: string; path: string }) =>
    ipcRenderer.invoke('kb:update', input),
  kbRemove: (id: number) => ipcRenderer.invoke('kb:remove', id),
  kbBuild: (input: { id: number; force?: boolean }) => ipcRenderer.invoke('kb:build', input),
  kbPickFolder: () => ipcRenderer.invoke('kb:pickFolder'),
  setConversationKbSel: (input: { id: string; sel: { id: number; name: string }[] }) =>
    ipcRenderer.invoke('conv:setKbSel', input),
  getConversationKbSel: (id: string) => ipcRenderer.invoke('conv:getKbSel', id),
  kbOptions: () => ipcRenderer.invoke('kb:options'),
  setConversationMcpSelection: (input: { id: string; serviceIds: number[] }) =>
    ipcRenderer.invoke('conv:setMcpSel', input),
  getConversationMcpSelection: (id: string): Promise<number[]> =>
    ipcRenderer.invoke('conv:getMcpSel', id),
  openDoc: (input: { kbId: number; filePath: string }) => ipcRenderer.invoke('doc:open', input),
  getArtifact: (id: number) => ipcRenderer.invoke('artifact:get', id),
  exportArtifact: (id: number) => ipcRenderer.invoke('artifact:export', id),
  listArtifacts: (conversationId: string) => ipcRenderer.invoke('artifact:list', conversationId),

  // 工作空间（015 Case 1）
  wsRecent: () => ipcRenderer.invoke('ws:recent'),
  getConversationWs: (id: string) => ipcRenderer.invoke('conv:getWs', id),
  wsAdd: (input: { id: string; path: string }) => ipcRenderer.invoke('conv:wsAdd', input),
  wsRemove: (input: { id: string; path: string }) => ipcRenderer.invoke('conv:wsRemove', input),
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
  },

  // 窗口全屏态（全屏时红绿灯隐藏，界面据此调左上角内边距）
  onFullscreen: (cb: (v: boolean) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, v: boolean): void => cb(v)
    ipcRenderer.on('window:fullscreen', h)
    return () => ipcRenderer.removeListener('window:fullscreen', h)
  }
}

// contextIsolation 恒开（安全默认），只暴露白名单 api；裸 ipcRenderer 不出 preload
contextBridge.exposeInMainWorld('api', api)
