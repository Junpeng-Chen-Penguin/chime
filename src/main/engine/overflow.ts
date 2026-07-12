// 工具结果超限处理：全量存本地、模型只拿够决策的部分，不够再取（PRD 超限机制章）。
// 两道闸：单结果闸在 execute 返回时判定；总量闸在「本步结果集齐、交给模型之前」（prepareStep）批量判定。
// 「查结果集」的取数实现是纯字符串操作，不绑定数据来源（将来读本地文件复用，研发约束）。

import { getDb, insertToolResult, getToolResult } from '../db'

// 数值初值（技术方案初值表，实测调优的起点）
export const RESULT_LIMIT = 30_000 // 单结果上限（字符）
export const TOTAL_LIMIT = 100_000 // 会话内工具结果总量上限
export const PREVIEW_CHARS = 1_000 // 摘要开头样例 / 时间线预览
export const FETCH_LIMIT = 10_000 // 查结果集单次返回上限
export const SEARCH_WINDOW = 200 // 关键词命中上下文窗口（字）
export const SEARCH_HITS = 10 // 关键词最多命中处数

// 给模型的摘要（也是时间线展开的预览，同一份数据）。
// 编号的内部属性写进摘要本身：仅靠输出约定条款拦不住模型把编号转述给用户（实测约半数泄漏）
export function overflowSummary(id: number, content: string): string {
  return `共约 ${content.length} 字。开头样例：${content.slice(0, PREVIEW_CHARS)}。已存为结果编号 #${id}——这是你的内部取数编号，需要更多内容时用「查结果集」按位置或关键词取用；不要在给用户的回答里提到编号或这套存取机制。`
}

// 轮内超限状态：resultRef 映射（tool item 标注用）+ 本轮已全文放行的字数累计
export interface OverflowCtx {
  convId: string
  refs: Map<string, number> // toolCallId → 结果编号
  turnFullChars: number // 本轮已全文交给模型的结果字数（总量闸增量）
}

// 单结果闸：超限即全量落库，返回摘要替代原文
export function guardSingle(ctx: OverflowCtx, toolCallId: string, toolName: string, text: string): string {
  if (text.length <= RESULT_LIMIT) return text
  const id = insertToolResult({ conversationId: ctx.convId, toolCallId, toolName, content: text })
  ctx.refs.set(toolCallId, id)
  return overflowSummary(id, text)
}

// 会话基线：历史里已全文交给模型的结果字数合计（打开会话/新轮开始时从 items 重建）
export function sessionFullResultChars(convId: string): number {
  const rows = getDb()
    .prepare("SELECT items FROM message WHERE conversation_id = ? AND role = 'assistant' AND items IS NOT NULL")
    .all(convId) as { items: string }[]
  let sum = 0
  for (const r of rows) {
    try {
      for (const it of JSON.parse(r.items) as { t: string; name?: string; result?: unknown; resultRef?: number }[]) {
        if (it.t !== 'tool' || it.resultRef || typeof it.result !== 'string') continue
        if (it.name === 'fetch_tool_result') continue // 豁免工具取回的片段不计
        sum += it.result.length
      }
    } catch {
      // 单行解析失败不影响其余
    }
  }
  return sum
}

// 总量闸（prepareStep 汇聚点调用）：本批新结果加会话累计超上限时，批内从大到小落库改摘要，
// 直到回线内；已全文给过模型的不回头改（消息一旦生成即冻结，保模型服务前缀缓存）。
// 返回需要改写的 toolCallId → 摘要；ctx 的累计与 refs 同步更新。
export function applyTotalGate(
  ctx: OverflowCtx,
  sessionBase: number,
  batch: { toolCallId: string; toolName: string; text: string }[]
): Map<string, string> {
  const replaced = new Map<string, string>()
  let total = sessionBase + ctx.turnFullChars + batch.reduce((s, b) => s + b.text.length, 0)
  const bySize = [...batch].sort((a, b) => b.text.length - a.text.length)
  for (const b of bySize) {
    if (total <= TOTAL_LIMIT) break
    const id = insertToolResult({ conversationId: ctx.convId, toolCallId: b.toolCallId, toolName: b.toolName, content: b.text })
    ctx.refs.set(b.toolCallId, id)
    replaced.set(b.toolCallId, overflowSummary(id, b.text))
    total -= b.text.length
  }
  // 留在线内的按全文放行，计入本轮累计
  for (const b of batch) {
    if (!replaced.has(b.toolCallId)) ctx.turnFullChars += b.text.length
  }
  return replaced
}

// 「查结果集」取数：按位置读一段 / 按关键词搜上下文，单次返回封顶
export function fetchFromResult(
  convId: string,
  args: { resultId?: number; mode?: string; start?: number; length?: number; keyword?: string }
): string | { error: string } {
  const id = Number(args.resultId)
  if (!Number.isInteger(id)) return { error: '缺少 resultId：请传入要取用的结果编号（如 #3 传 3）' }
  const row = getToolResult(id, convId)
  if (!row) return { error: `结果编号 #${id} 不存在或不属于本会话` }
  if (args.mode === 'search') {
    const kw = String(args.keyword ?? '').trim()
    if (!kw) return { error: 'search 模式需要 keyword 参数' }
    const hits: string[] = []
    let from = 0
    while (hits.length < SEARCH_HITS) {
      const at = row.content.indexOf(kw, from)
      if (at < 0) break
      hits.push(
        `【位置 ${at}】…${row.content.slice(Math.max(0, at - SEARCH_WINDOW), at + kw.length + SEARCH_WINDOW)}…`
      )
      from = at + kw.length
    }
    if (!hits.length) return `结果 #${id}（共 ${row.chars} 字）中未找到「${kw}」`
    const text = `结果 #${id}（共 ${row.chars} 字）中「${kw}」命中 ${hits.length} 处：\n${hits.join('\n')}`
    return text.length > FETCH_LIMIT ? text.slice(0, FETCH_LIMIT) : text
  }
  // 缺省按位置读
  const start = Math.max(0, Number(args.start ?? 0) || 0)
  const length = Math.min(FETCH_LIMIT, Math.max(1, Number(args.length ?? FETCH_LIMIT) || FETCH_LIMIT))
  const piece = row.content.slice(start, start + length)
  if (!piece) return { error: `起始位置 ${start} 超出结果范围（共 ${row.chars} 字）` }
  return `结果 #${id}（共 ${row.chars} 字，第 ${start}-${start + piece.length} 字）：\n${piece}`
}
