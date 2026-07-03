import { ElectronAPI } from '@electron-toolkit/preload'

export interface ProviderInfo {
  baseUrl: string
  defaultModel: string
  keyMask: string
  hasKey: boolean
}

export interface DetectResult {
  ok: boolean
  latencyMs?: number
  models?: string[]
  error?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SourceRef {
  n: number
  chunkId: number
  filePath: string
  headingPath: string
  startLine: number
  endLine: number
}

export interface ChatEvent {
  type: 'chunk' | 'done' | 'stopped' | 'error' | 'sources' | 'step'
  streamId: string
  delta?: string
  kind?: 'content' | 'reasoning'
  error?: string
  sources?: SourceRef[]
  key?: string
  label?: string
  status?: 'start' | 'end'
  detail?: string
}

export interface Conversation {
  id: string
  title: string
  model: string
  updatedAt: number
  kbEnabled?: number
}

export interface PersistedMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  status: string
  createdAt: number
  sources?: string | null
}

export interface KbSummary {
  updated: number
  deleted: number
  skipped: number
}

export interface KbInfo {
  rootPath: string
  name: string
  indexedAt: number | null
  busy: boolean
  files: number
  chunks: number
  lastSummary: KbSummary | null
}

export interface KbProgress {
  phase: 'pulling' | 'scanning' | 'downloading-model' | 'embedding' | 'done' | 'error'
  current?: number
  total?: number
  file?: string
  message?: string
  warning?: string
  stats?: { files: number; chunks: number; summary: KbSummary }
}

export interface ChimeApi {
  getProvider: () => Promise<ProviderInfo>
  saveProvider: (input: {
    baseUrl: string
    defaultModel: string
    apiKey: string | null
  }) => Promise<void>
  detect: (input: { baseUrl: string; apiKey: string | null }) => Promise<DetectResult>
  getModels: () => Promise<string[]>
  listConversations: () => Promise<Conversation[]>
  createConversation: (input: { id: string; model: string }) => Promise<Conversation>
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  getMessages: (id: string) => Promise<PersistedMessage[]>
  saveMessage: (m: PersistedMessage) => Promise<void>
  autoTitle: (input: {
    convId: string
    userText: string
    assistantText: string
  }) => Promise<string | null>
  sendChat: (payload: { streamId: string; model: string; messages: ChatMessage[]; kb?: boolean }) => void
  stopChat: (streamId: string) => void
  onChatEvent: (cb: (evt: ChatEvent) => void) => () => void
  getKb: () => Promise<KbInfo>
  kbBuild: (input: { path: string; name: string }) => Promise<{ ok: boolean; error?: string }>
  kbRefresh: () => Promise<{ ok: boolean; error?: string }>
  kbRename: (name: string) => Promise<void>
  kbRemove: () => Promise<{ ok: boolean; error?: string }>
  setConversationKb: (input: { id: string; enabled: boolean }) => Promise<void>
  onKbProgress: (cb: (p: KbProgress) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChimeApi
  }
}
