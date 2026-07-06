// 渲染层用的数据形状（与主进程 IPC 返回结构一致，靠结构化类型对齐）

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
