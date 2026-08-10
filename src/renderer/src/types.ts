// 渲染层用的数据形状（与主进程 IPC 返回结构一致，靠结构化类型对齐）

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
  items: string | null // TurnItem[] 的 JSON；assistant 行是过程件，user 行只有表格行引用（013）
  usage: string | null // {input, output, cached} JSON
  status: string
  createdAt: number
}

// 表格行引用（013 Case 2）：待发送的 chip，随消息落库时转成 TurnItem 的 ref 分支
export interface ChipRef {
  artifactId: number
  title: string
  rowIndexes: number[]
}
