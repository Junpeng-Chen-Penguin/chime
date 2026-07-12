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
  error?: string // 真故障：显示为红色「检索出错」
  denied?: string // 触检索上限
  notice?: string // 知识库暂时不可用
  invalid?: string // 模型发了空检索词、被拦下自愈：非错误，中性显示
  interrupted?: string // 停止时在途被中断（第二级文案），中性显示
}

// 通用工具（MCP 等）的返回：成功为纯文本，失败为 { error }，
// 拒绝授权为 { denied }，被打断为 { interrupted }（三级文案）
export type GenericToolResult = string | { error: string } | { denied: string } | { interrupted: string }

// 提问卡回应（作答 / 放弃整卡；停止与打字中断走全局停止通道）
export type AskOutcomePayload =
  | { kind: 'answers'; answers: { question: string; answer: string | null }[] }
  | { kind: 'declined' }

// 提问卡的问题结构（询问用户工具的 args.questions）
export interface AskQuestionSpec {
  question: string
  options: { label: string }[]
  multiSelect?: boolean
}

// 一轮的有序过程记录的元素（与主进程 engine/store 的 TurnItem 一致）
export type TurnItem =
  | { t: 'reasoning'; text: string }
  | { t: 'text'; text: string } // 位置即语义：工具步骤前为意图叙述，末位为最终回答
  | {
      t: 'tool'
      name: string
      id?: string // toolCallId（授权卡回应路由用）
      display?: string // 展示名（MCP 为「服务名:工具名」），随落库
      desc?: string // 卡上「用途」：服务自带工具描述原样（仅需授权的调用有）
      auth?: 'pending' | 'approved' | 'denied' | 'unanswered' // 授权状态（仅需授权的调用有）
      // 提问卡状态（仅询问用户工具有）：answered 附问答结构（折叠记录点开看每题问答）
      ask?: {
        state: 'pending' | 'answered' | 'skipped' | 'unanswered'
        answers?: { question: string; answer: string | null }[]
      }
      args: Record<string, unknown>
      result?: SearchToolResult | GenericToolResult
      resultRef?: number // 超限结果的结果编号（result 存摘要，全量在结果库）
      ms?: number
    }
  | { t: 'sources'; list: SourceRef[] }
  | { t: 'boundary'; kind: 'limit' | 'error'; text?: string }

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t']; item: TurnItem }
  | { type: 'item-delta'; streamId: string; index: number; text: string }
  | { type: 'item-done'; streamId: string; index: number; item: TurnItem }
  | { type: 'item-update'; streamId: string; index: number; item: TurnItem }
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

// MCP 服务列表项（配置 + 运行时状态；认证头值已打码）
export interface McpServiceInfo {
  id: number
  name: string
  url: string
  headersMasked: Record<string, string>
  enabled: boolean
  status: 'connected' | 'error' | 'auth' | null // null = 已停用
  error?: string
  toolCount: number
}

export interface McpTestResult {
  ok: boolean
  toolNames?: string[]
  error?: string
  auth?: boolean
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
  cardRespond: (payload: { streamId: string; toolCallId: string; decision: 'approved' | 'denied' }) => void
  askRespond: (payload: { streamId: string; toolCallId: string; outcome: AskOutcomePayload }) => void
  onChatEvent: (cb: (evt: ChatEvent) => void) => () => void
  onFullscreen: (cb: (v: boolean) => void) => () => void
  mcpList: () => Promise<McpServiceInfo[]>
  mcpSave: (input: {
    id?: number
    name: string
    url: string
    headers: Record<string, string> | null
    enabled: boolean
  }) => Promise<void>
  mcpDelete: (id: number) => Promise<void>
  mcpTest: (input: {
    id?: number
    url: string
    headers: Record<string, string> | null
  }) => Promise<McpTestResult>
  onMcpStatus: (cb: () => void) => () => void
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
