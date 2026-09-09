// 工具清单的组装（018 Case 2）：十二个内置工具无条件挂载、顺序固定，tools 数组在所有会话完全一致。
// 正常轮次与摘要请求共用这一份——摘要请求带同一份清单才能命中缓存前缀（七节）。
// MCP 工具不在这里：定义存进本会话的查询表，模型用 tool_search 找回、tool_invoke 转接（deferred.ts）

import { tool, type Tool, type ModelMessage } from 'ai'
import {
  makeSearchTool,
  makeAskTool,
  makeGrepResultTool,
  makeReadResultTool,
  makeArtifactTool,
  ASK_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  ARTIFACT_TOOL_NAME,
  type TurnToolContext
} from './tools'
import { makeFsTools, type FsCard } from './fs-tools'
import { makeActivateSkillTool, ACTIVATE_TOOL_NAME } from '../skills'
import type { CardQueue } from './cards'
import type { OverflowCtx } from './overflow'
import {
  makeToolSearchTool,
  makeToolInvokeTool,
  TOOL_SEARCH_NAME,
  TOOL_INVOKE_NAME,
  type DeferredTool
} from './deferred'

export interface ToolsetInputs {
  convId: string
  signal: AbortSignal
  cards: CardQueue
  overflow: OverflowCtx
  onFsCard: (toolCallId: string, card: FsCard) => void
  toolCtx: TurnToolContext
  skillNames: string[]
  getHistory: () => ModelMessage[]
  onArtifact: (toolCallId: string, info: { id: number; title: string; rowCount: number }) => void
  deferred: DeferredTool[]
  onInvokeAuth: (toolCallId: string) => void
}

export function assembleTurnTools(i: ToolsetInputs): Record<string, Tool> {
  const t: Record<string, Tool> = {}
  t[ASK_TOOL_NAME] = makeAskTool(i.signal, i.cards)
  t[GREP_TOOL_NAME] = makeGrepResultTool(i.convId)
  t[READ_TOOL_NAME] = makeReadResultTool(i.convId)
  t[ARTIFACT_TOOL_NAME] = makeArtifactTool(i.convId, i.onArtifact)
  // 文件工具（015 C2 读/列；C3 加写/编辑）：白名单校验在 execute 内
  Object.assign(
    t,
    makeFsTools({
      convId: i.convId,
      signal: i.signal,
      cards: i.cards,
      overflow: i.overflow,
      onFsCard: i.onFsCard
    })
  )
  // 检索：没关联知识库时 execute 返回一句说明
  t.search_knowledge_base = makeSearchTool(i.toolCtx)
  // 技能：范围为空时 execute 返回说明
  t[ACTIVATE_TOOL_NAME] = makeActivateSkillTool({ names: i.skillNames, getHistory: i.getHistory })
  t[TOOL_SEARCH_NAME] = makeToolSearchTool(i.deferred)
  t[TOOL_INVOKE_NAME] = makeToolInvokeTool({
    table: i.deferred,
    signal: i.signal,
    cards: i.cards,
    overflow: i.overflow,
    onAuthPending: i.onInvokeAuth
  })
  return t
}

// 只留定义（名字、说明、参数）的一份：摘要请求 toolChoice 为 none，永远不执行，
// 手动压缩没有轮内的卡片队列等上下文时用它拼出与正常轮次逐字相同的清单
export function definitionsOnly(tools: Record<string, Tool>): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools))
    out[name] = tool({ description: t.description, inputSchema: t.inputSchema })
  return out
}
