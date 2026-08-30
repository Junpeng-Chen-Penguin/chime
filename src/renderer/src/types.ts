// 渲染层用的数据形状（与主进程 IPC 返回结构一致，靠结构化类型对齐）

export interface Conversation {
  id: string
  title: string
  model: string
  updatedAt: number
  kbSelection?: { id: number; name: string }[]
  agentId?: number | null // 选用的 Agent（014）；null = 通用对话
  agentName?: string | null // 名字快照：Agent 删除后仍显示原名
}

export interface PersistedMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  items: string | null // TurnItem[] 的 JSON；assistant 行是过程件，user 行只有表格行引用（013）
  usage: string | null // {input, output, cached} JSON
  status: string // 走到哪一步：running / waiting / done
  endReason: string | null // 为什么不是正常完成：stopped / interrupted / error；正常为 NULL
  createdAt: number
}

// 表格行引用（013 Case 2）：待发送的 chip，随消息落库时转成 TurnItem 的 ref 分支
export interface ChipRef {
  artifactId: number
  title: string
  rowIndexes: number[]
  chars?: number // 展开后字数的渲染层估算（发送前长度检查用），落库前剥掉
}
