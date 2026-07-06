import { ElectronAPI } from '@electron-toolkit/preload'

export interface ProviderInfo {
  baseUrl: string
  defaultModel: string
  defaultWindow: number
  keyMask: string
  hasKey: boolean
}

export interface DetectResult {
  ok: boolean
  latencyMs?: number
  models?: string[]
  error?: string
}

export interface SourceRef {
  n: number
  chunkId: number
  filePath: string
  headingPath: string
  startLine: number
  endLine: number
  content?: string // 片段原文快照（v3 起随消息落库，用于侧板高亮校验）
}

export type DocOpenResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'no-kb' | 'busy' | 'missing' }

// 检索工具的返回（进 items 的 tool.result）：四态 + 截断标注
export interface SearchToolResult {
  results?: { n: number; file: string; heading: string; content: string }[]
  truncated?: string
  error?: string
  denied?: string
  notice?: string
}

// 一轮的有序过程记录的元素（与主进程 engine/store 的 TurnItem 一致）
export type TurnItem =
  | { t: 'reasoning'; text: string }
  | { t: 'text'; text: string } // 位置即语义：工具步骤前为意图叙述，末位为最终回答
  | { t: 'tool'; name: string; args: { query?: string }; result?: SearchToolResult; ms?: number }
  | { t: 'sources'; list: SourceRef[] }
  | { t: 'boundary'; kind: 'limit' | 'error'; text?: string }

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t']; item: TurnItem }
  | { type: 'item-delta'; streamId: string; index: number; text: string }
  | { type: 'item-done'; streamId: string; index: number; item: TurnItem }
  | {
      type: 'turn-done'
      streamId: string
      status: 'done' | 'stopped' | 'error'
      error?: string
      usage?: { inputTokens: number; outputTokens: number }
      contextRatio: number
    }
  | { type: 'notice'; streamId: string; text: string }

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
  items: string | null // TurnItem[] 的 JSON，仅 assistant 行有
  status: string
  createdAt: number
}

export interface KbSummary {
  updated: number
  deleted: number
  skipped: number
}

export interface KbInfo {
  rootPath: string
  name: string
  intro: string
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
    defaultWindow?: number
  }) => Promise<void>
  detect: (input: { baseUrl: string; apiKey: string | null }) => Promise<DetectResult>
  getModels: () => Promise<string[]>
  listConversations: () => Promise<Conversation[]>
  createConversation: (input: { id: string; model: string }) => Promise<Conversation>
  deleteConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  getMessages: (id: string) => Promise<PersistedMessage[]>
  autoTitle: (input: {
    convId: string
    userText: string
    assistantText: string
  }) => Promise<string | null>
  sendChat: (payload: { streamId: string; convId: string; text: string; model: string }) => void
  retryChat: (payload: { streamId: string; convId: string; model: string }) => void
  stopChat: (streamId: string) => void
  onChatEvent: (cb: (evt: ChatEvent) => void) => () => void
  getKb: () => Promise<KbInfo>
  kbBuild: (input: { path: string; name: string; intro: string }) => Promise<{ ok: boolean; error?: string }>
  kbRefresh: () => Promise<{ ok: boolean; error?: string }>
  kbUpdate: (input: { name: string; intro: string }) => Promise<void>
  kbRemove: () => Promise<{ ok: boolean; error?: string }>
  setConversationKb: (input: { id: string; enabled: boolean }) => Promise<void>
  openDoc: (filePath: string) => Promise<DocOpenResult>
  onKbProgress: (cb: (p: KbProgress) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChimeApi
  }
}
