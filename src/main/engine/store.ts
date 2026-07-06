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
  | { t: 'tool'; name: string; args: Record<string, unknown>; result?: unknown; ms?: number }
  | { t: 'sources'; list: SourceSnapshot[] }
  | { t: 'boundary'; kind: 'limit' | 'error'; text?: string }

export type TurnStatus = 'done' | 'stopped' | 'error'

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

export function saveAssistantTurn(
  convId: string,
  turn: { content: string; items: TurnItem[]; status: TurnStatus }
): void {
  const db = getDb()
  const now = Date.now()
  db.prepare(
    'INSERT INTO message (id, conversation_id, role, content, items, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), convId, 'assistant', turn.content, JSON.stringify(turn.items), turn.status, now)
  db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').run(now, convId)
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
    const summary = r.items ? summarizeSearches(JSON.parse(r.items) as TurnItem[]) : ''
    const content = summary ? `${r.content}\n\n${summary}` : r.content
    if (content.trim()) out.push({ role: 'assistant', content })
  }
  return out
}

// 概要一行一条：本轮检索：「query」命中《文章》《文章》——让模型记得查过什么，可追问时重查
function summarizeSearches(items: TurnItem[]): string {
  const lines: string[] = []
  for (const it of items) {
    if (it.t !== 'tool' || it.name !== 'search_knowledge_base') continue
    const result = it.result as { results?: { file: string }[]; denied?: string } | undefined
    if (!result || result.denied) continue // 被闸门拒绝的请求不是一次检索
    const query = String((it.args as { query?: unknown }).query ?? '')
    const files = [...new Set((result.results ?? []).map((r) => r.file))].map((f) => `《${f}》`).join('')
    lines.push(files ? `本轮检索：「${query}」命中${files}` : `本轮检索：「${query}」未命中`)
  }
  return lines.join('\n')
}
