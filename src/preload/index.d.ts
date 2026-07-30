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
  kbId: number
  kbName: string
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
  | { t: 'artifact'; id: number; title: string; rowCount: number; result?: string } // 制品卡
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
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
      contextRatio: number
    }
  | { type: 'notice'; streamId: string; text: string }

export interface Conversation {
  id: string
  title: string
  model: string
  updatedAt: number
  kbSelection?: { id: number; name: string }[]
}

export interface PersistedMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  items: string | null // TurnItem[] 的 JSON，仅 assistant 行有
  usage: string | null // {input, output, cached} JSON；中断轮 NULL
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
  kbId?: number
  phase: 'pulling' | 'scanning' | 'downloading-model' | 'embedding' | 'done' | 'error'
  current?: number
  total?: number
  file?: string
  message?: string
  warning?: string
  stats?: { files: number; chunks: number; summary: KbSummary }
}

// 变更检查结果（PRD Case 2）
export interface KbChanges {
  added: number
  changed: number
  deleted: number
  needsFullRebuild: boolean
  folderMissing: boolean
}

// 会话选库条目（name 为快照）
// 模型服务商（PRD Case 6/7）
export interface VendorModel {
  id: string
  picked: boolean
  offline?: boolean
}
export interface VendorInfo {
  vendor: string
  name: string
  baseUrl: string
  defaultBaseUrl: string
  keyMask: string
  hasKey: boolean
  enabled: boolean
  models: VendorModel[]
  extraParams: Record<string, unknown>
  windows: Record<string, number>
  health: { ok: boolean; reason?: string }
}
export interface VendorMenuGroup {
  vendor: string
  name: string
  health: { ok: boolean; reason?: string }
  models: string[]
}

export interface KbSelEntry {
  id: number
  name: string
}

// 会话控件的库选项（轻量，不含哈希检查）
export interface KbOption {
  id: number
  name: string
  ready: boolean
  building: boolean
  folderMissing: boolean
}

// 多库列表卡片项
export interface KbCard {
  id: number
  name: string
  intro: string
  rootPath: string
  indexedAt: number | null
  files: number
  chunks: number
  changes: KbChanges | null // 构建中为 null
  building: boolean
  othersBuilding: boolean
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
  mcpRetry: () => Promise<void>
  setConversationMcpSelection: (input: { id: string; serviceIds: number[] }) => Promise<void>
  getConversationMcpSelection: (id: string) => Promise<number[]>
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
  kbList: () => Promise<KbCard[]>
  kbAdd: (input: { name: string; intro: string; path: string }) => Promise<{ ok: boolean; error?: string; id?: number }>
  kbUpdate: (
    input: { id: number; name: string; intro: string; path: string }
  ) => Promise<{ ok: boolean; error?: string; rebuilt?: boolean }>
  kbRemove: (id: number) => Promise<{ ok: boolean; error?: string }>
  kbBuild: (
    input: { id: number; force?: boolean }
  ) => Promise<{ ok: boolean; error?: string; confirmRequired?: { deleted: number; kept: number } }>
  kbPickFolder: () => Promise<string | null>
  setConversationKbSel: (input: { id: string; sel: KbSelEntry[] }) => Promise<void>
  getConversationKbSel: (id: string) => Promise<KbSelEntry[]>
  kbOptions: () => Promise<KbOption[]>
  providerList: () => Promise<VendorInfo[]>
  providerSave: (input: {
    vendor: string
    apiKey?: string | null
    baseUrl?: string
    enabled?: boolean
    extraParams?: Record<string, unknown>
  }) => Promise<void>
  providerDetect: (input: { vendor: string; apiKey: string | null }) => Promise<DetectResult>
  providerFetchModels: (vendor: string) => Promise<{ ok: boolean; error?: string; models?: VendorModel[] }>
  providerPickModel: (input: { vendor: string; id: string; picked: boolean }) => Promise<void>
  providerGetDefault: () => Promise<string>
  providerSetDefault: (ref: string) => Promise<void>
  providerMenu: () => Promise<VendorMenuGroup[]>
  openDoc: (input: { kbId: number; filePath: string }) => Promise<DocOpenResult>
  getArtifact: (id: number) => Promise<ArtifactView | null>
  onKbProgress: (cb: (p: KbProgress) => void) => () => void
}

// 制品查看数据（侧板表格视图；rows 已按渲染上限截断，totalRows 为完整行数）
export interface ArtifactView {
  id: number
  title: string
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
  totalRows: number
}

declare global {
  interface Window {
    api: ChimeApi
  }
}
