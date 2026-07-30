// 落库与历史组装：主进程是消息的唯一写者。一轮一行，items 存整轮有序过程；
// 历史进模型上下文时按映射降级（回答全文 + 检索概要），存储保持原样。

import { randomUUID } from 'crypto'
import type { ModelMessage } from 'ai'
import { getDb } from '../db'

export interface SourceSnapshot {
  n: number
  chunkId: number
  kbId: number
  kbName: string // 库名快照：来源展示带库名，且不随库改名/移除而丢失
  filePath: string
  headingPath: string
  startLine: number
  endLine: number
  content: string // 片段原文快照，侧板校验不依赖知识库当前状态
}

export type TurnItem =
  | { t: 'reasoning'; text: string }
  | { t: 'text'; text: string } // 位置即语义：工具步骤前为意图叙述，末位为最终回答
  | {
      t: 'tool'
      name: string
      id?: string // toolCallId：卡片路由、落库幂等、启动修复都以它为键
      display?: string
      desc?: string // 卡上「用途」：服务自带工具描述原样（仅需授权的调用有）
      auth?: 'pending' | 'approved' | 'denied' | 'unanswered' // 授权状态（仅需授权的调用有）
      // 提问卡状态（仅询问用户工具有）：answered 附问答结构（点开折叠记录看每题问答）
      ask?: {
        state: 'pending' | 'answered' | 'skipped' | 'unanswered'
        answers?: { question: string; answer: string | null }[]
      }
      args: Record<string, unknown>
      result?: unknown
      resultRef?: number // 超限结果的结果编号（全量在结果库，result 存摘要）
      ms?: number
    }
  | { t: 'sources'; list: SourceSnapshot[] }
  | { t: 'artifact'; id: number; title: string; rowCount: number; result?: string } // 制品卡（成功的生成调用不出工具步骤行，成果即过程）；result 为给模型的返回文本，旧记录无此字段
  | { t: 'boundary'; kind: 'limit' | 'error'; text?: string }

// waiting = 等卡中（弹卡即落库的中间态）；interrupted = 应用退出打断、启动修复后收场
export type TurnStatus = 'done' | 'stopped' | 'error' | 'waiting' | 'interrupted'

export function saveUserMessage(convId: string, text: string): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    'INSERT INTO message (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), convId, 'user', text, 'done', now)
  db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').run(now, convId)
  // 首条用户消息自动作为标题（回复后再由模型生成精炼标题）
  db.prepare("UPDATE conversation SET title = ? WHERE id = ? AND title = '新对话'").run(
    text.slice(0, 18) || '新对话',
    convId
  )
}

// 落库节点化：一轮多次写同一行（弹卡时 / 卡片回应后 / 轮终结），以 msgId 幂等 UPSERT。
// created_at 只在首次写入时定，节点更新不动它（保持消息顺序稳定）。
export function saveAssistantTurn(
  convId: string,
  msgId: string,
  turn: {
    content: string
    items: TurnItem[]
    status: TurnStatus
    usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  }
): void {
  const db = getDb()
  const now = Date.now()
  // 用量落库（PRD Case 5）：{input, output, cached}；中断轮 usage 为空存 NULL——没有就是没有，不估算
  const usageJson = turn.usage
    ? JSON.stringify({ input: turn.usage.inputTokens, output: turn.usage.outputTokens, cached: turn.usage.cachedInputTokens ?? 0 })
    : null
  db.prepare(
    `INSERT INTO message (id, conversation_id, role, content, items, usage, status, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, items = excluded.items, usage = excluded.usage, status = excluded.status`
  ).run(msgId, convId, turn.content, JSON.stringify(turn.items), usageJson, turn.status, now)
  db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').run(now, convId)
}

// chat:retry 的支撑：取末条用户消息原文；删除末行（仅当它是 assistant 时）
export function lastUserText(convId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT content FROM message WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
    )
    .get(convId) as { content: string } | undefined
  return row?.content ?? null
}

export function deleteLastAssistant(convId: string): void {
  getDb()
    .prepare(
      `DELETE FROM message WHERE id = (
         SELECT id FROM message WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1
       )`
    )
    .run(convId)
}

// ── 历史 → 模型上下文（07-14 核心改造：原生消息形态）──────────────────
// 按模型语料里的多轮形态重建：当时的调用块、返回块原样保留在消息结构里，
// 不再压成自造句式（自造形态不如语料形态——取数工具重构已验证过一次；三家主流历史全部原生）。
// 压缩不在这里发生：轮结束不再无条件降级，上下文有压力时由 orchestrator 按压力分级清最老的返回。
// 定点转换一处：知识库检索结果只留命中文档名——「追问本轮重查」规则的配套，原文留存诱导吃老本。
// stopped/interrupted 轮照常进（正常收场）；error 轮跳过；暂停等卡的轮由续跑单独重建。

export interface HistoryToolOutput {
  msgIdx: number // 所在 tool 消息在 messages 中的下标
  partIdx: number // 在该消息 content 数组中的下标
  toolCallId: string
  toolName: string
  resultRef?: number // 已有结果编号（超限摘要），降级时直接指向它
  chars: number
}

export interface HistoryBundle {
  messages: ModelMessage[]
  toolOutputs: HistoryToolOutput[] // 全部工具返回的位置索引（旧→新），压力降级按此定位
}

export function loadHistoryMessages(convId: string): HistoryBundle {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT role, content, items, status FROM message WHERE conversation_id = ? ORDER BY created_at'
    )
    .all(convId) as { role: string; content: string; items: string | null; status: string }[]

  const messages: ModelMessage[] = []
  const toolOutputs: HistoryToolOutput[] = []
  let fallbackId = 0 // 旧数据缺 toolCallId 时的稳定补位

  for (const r of rows) {
    if (r.role === 'user') {
      messages.push({ role: 'user', content: r.content })
      continue
    }
    if (r.status === 'error' || r.status === 'waiting') continue
    const items = r.items ? (JSON.parse(r.items) as TurnItem[]) : []
    if (!items.length) {
      if (r.content.trim()) messages.push({ role: 'assistant', content: r.content })
      continue
    }

    // 一轮内按发生顺序重建：文本与调用块进 assistant 消息，紧随的 tool 消息带全部返回。
    // 中途文本会切开批次（保持 调用→结果→后续文本 的时序），并行调用天然落在同一批。
    let asst: Array<Record<string, unknown>> = []
    let results: Array<{ part: Record<string, unknown>; meta: Omit<HistoryToolOutput, 'msgIdx' | 'partIdx'> }> = []
    const flush = (): void => {
      if (asst.length) messages.push({ role: 'assistant', content: asst } as unknown as ModelMessage)
      if (results.length) {
        const msgIdx = messages.length
        messages.push({ role: 'tool', content: results.map((x) => x.part) } as unknown as ModelMessage)
        results.forEach((x, i) => toolOutputs.push({ msgIdx, partIdx: i, ...x.meta }))
      }
      asst = []
      results = []
    }
    for (const it of items) {
      if (it.t === 'text') {
        if (!it.text.trim()) continue
        if (results.length) flush()
        asst.push({ type: 'text', text: it.text })
      } else if (it.t === 'artifact') {
        if (results.length) flush()
        asst.push({ type: 'text', text: `已生成表格制品《${it.title}》（${it.rowCount} 行），用户可随时点开查看` })
      } else if (it.t === 'tool') {
        const callId = it.id ?? `hist_${++fallbackId}`
        const value = historyToolOutput(it)
        asst.push({ type: 'tool-call', toolCallId: callId, toolName: it.name, input: it.args ?? {} })
        results.push({
          part: { type: 'tool-result', toolCallId: callId, toolName: it.name, output: { type: 'text', value } },
          meta: { toolCallId: callId, toolName: it.name, resultRef: it.resultRef, chars: value.length }
        })
      }
      // reasoning / sources / boundary 不进历史
    }
    flush()
  }
  return { messages, toolOutputs }
}

// 工具返回进历史的文本形态：字符串原样（含超限摘要）；对象结构原样序列化（当轮模型看到的就是它）；
// 知识库检索定点转换为命中文档名
function historyToolOutput(it: Extract<TurnItem, { t: 'tool' }>): string {
  const r = it.result
  if (it.name === 'search_knowledge_base' && r && typeof r === 'object' && 'results' in r) {
    const files = [...new Set(((r as { results?: { file: string }[] }).results ?? []).map((s) => s.file))]
    return files.length
      ? `检索命中${files.map((f) => `《${f}》`).join('')}。片段原文不跨轮保留（资料会更新），追问业务问题时本轮重新检索后作答`
      : '未命中'
  }
  if (typeof r === 'string') return r
  if (r === undefined) return '（本次调用未产生结果）'
  return JSON.stringify(r)
}

// ── 等待与启动修复（弹卡即落库的配套）────────────────────────

interface WaitingTurn {
  msgId: string
  items: TurnItem[]
}

// 会话中等卡的轮（只可能是最后一条 assistant 行）
function getWaitingTurn(convId: string): WaitingTurn | null {
  const row = getDb()
    .prepare(
      `SELECT id, items, status FROM message WHERE conversation_id = ? AND role = 'assistant'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(convId) as { id: string; items: string | null; status: string } | undefined
  if (!row || row.status !== 'waiting') return null
  return { msgId: row.id, items: row.items ? (JSON.parse(row.items) as TurnItem[]) : [] }
}

// 启动修复（打开会话时调用，幂等）：对等卡轮做配对检查。
// 授权请求的有效期 = 进程生命周期——重启后待回应的卡一律作废（Claude Code / goose 同此：
// 授权是对当下动作的确认，跨重启不恢复可操作状态，用户带着新上下文让模型重新发起）；
// 已在执行、结果拿不回来的调用按三级文案补齐（MCP 外部补第三级「是否生效未知」，本地补第二级）。
// 修复后轮收场为 interrupted，会话可正常继续。
export function repairConversation(
  convId: string,
  texts: { notStarted: string; external: string; local: string; ask: string }
): void {
  const w = getWaitingTurn(convId)
  if (!w) return
  for (const it of w.items) {
    if (it.t !== 'tool' || it.result !== undefined) continue
    if (it.ask) {
      it.ask = { state: 'unanswered' }
      it.result = { interrupted: texts.ask }
    } else if (it.auth === 'pending') {
      it.auth = 'unanswered'
      it.result = { interrupted: texts.notStarted }
    } else {
      it.result = { interrupted: it.auth === 'approved' ? texts.external : texts.local }
    }
  }
  const content = [...w.items].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
  saveAssistantTurn(convId, w.msgId, { content, items: w.items, status: 'interrupted' })
}

