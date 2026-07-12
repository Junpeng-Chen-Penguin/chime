// 落库与历史组装：主进程是消息的唯一写者。一轮一行，items 存整轮有序过程；
// 历史进模型上下文时按映射降级（回答全文 + 检索概要），存储保持原样。

import { randomUUID } from 'crypto'
import type { ModelMessage } from 'ai'
import { getDb } from '../db'

export interface SourceSnapshot {
  n: number
  chunkId: number
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
      id?: string // toolCallId：卡片路由、落库幂等、启动修复、续跑重建都以它为键
      display?: string
      desc?: string // 卡上「用途」：服务自带工具描述原样（仅需授权的调用有）
      auth?: 'pending' | 'approved' | 'denied' | 'unanswered' // 授权状态（仅需授权的调用有）
      args: Record<string, unknown>
      result?: unknown
      ms?: number
    }
  | { t: 'sources'; list: SourceSnapshot[] }
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
  turn: { content: string; items: TurnItem[]; status: TurnStatus }
): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    `INSERT INTO message (id, conversation_id, role, content, items, status, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, items = excluded.items, status = excluded.status`
  ).run(msgId, convId, turn.content, JSON.stringify(turn.items), turn.status, now)
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

// 历史 → 模型上下文映射：user 原文；assistant 取最终回答 + 检索概要（结果全文不进上下文）。
// stopped 轮照常进（停止是正常收场）；error 轮跳过（无有效回应）。
export function loadHistoryMessages(convId: string): ModelMessage[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT role, content, items, status FROM message WHERE conversation_id = ? ORDER BY created_at'
    )
    .all(convId) as { role: string; content: string; items: string | null; status: string }[]

  const out: ModelMessage[] = []
  for (const r of rows) {
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content })
      continue
    }
    if (r.status === 'error') continue
    if (r.status === 'waiting') continue // 等卡中的轮不进历史概要：续跑时由 buildTurnMessages 原样重建
    const summary = r.items ? summarizeToolCalls(JSON.parse(r.items) as TurnItem[]) : ''
    const content = summary ? `${r.content}\n\n${summary}` : r.content
    if (content.trim()) out.push({ role: 'assistant', content })
  }
  return out
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
  texts: { notStarted: string; external: string; local: string }
): void {
  const w = getWaitingTurn(convId)
  if (!w) return
  for (const it of w.items) {
    if (it.t !== 'tool' || it.result !== undefined) continue
    if (it.auth === 'pending') {
      it.auth = 'unanswered'
      it.result = { interrupted: texts.notStarted }
    } else {
      it.result = { interrupted: it.auth === 'approved' ? texts.external : texts.local }
    }
  }
  const content = [...w.items].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
  saveAssistantTurn(convId, w.msgId, { content, items: w.items, status: 'interrupted' })
}

// 概要一行一条，让模型记得本轮做过什么：
// 检索：「query」命中《文章》《文章》；其他工具（MCP 等）：展示名(参数) → 结果规模或失败原因。
// 结果编号、三级中断文案的完整历史映射随卡片机制一起做（技术方案 6.3）。
function summarizeToolCalls(items: TurnItem[]): string {
  const lines: string[] = []
  for (const it of items) {
    if (it.t !== 'tool') continue
    if (it.name === 'search_knowledge_base') {
      const result = it.result as { results?: { file: string }[]; denied?: string; interrupted?: string } | undefined
      if (!result || result.denied || result.interrupted) continue // 被闸门拒绝/中断的请求不是一次检索
      const query = String((it.args as { query?: unknown }).query ?? '')
      const files = [...new Set((result.results ?? []).map((r) => r.file))].map((f) => `《${f}》`).join('')
      lines.push(files ? `本轮检索：「${query}」命中${files}` : `本轮检索：「${query}」未命中`)
      continue
    }
    const label = it.display ?? it.name
    const argsShort = JSON.stringify(it.args ?? {}).slice(0, 100)
    const r = it.result as { error?: unknown; denied?: string; interrupted?: string } | string | undefined
    if (typeof r === 'string') {
      lines.push(`本轮调用：${label}(${argsShort}) → 返回约 ${r.length} 字`)
    } else if (r?.denied || r?.interrupted) {
      // 拒绝与三级中断文案原样保留：模型下一轮据此判断能否重试
      lines.push(`本轮调用：${label}(${argsShort}) → ${r.denied ?? r.interrupted}`)
    } else if (r && typeof r === 'object' && 'error' in r) {
      lines.push(`本轮调用：${label}(${argsShort}) → 失败：${String(r.error).slice(0, 100)}`)
    }
  }
  return lines.join('\n')
}
