// 工具结果超限处理：全量存本地、模型只拿够决策的部分，不够再取（PRD 超限机制章）。
// 两道闸：单结果闸在 execute 返回时判定；总量闸在「本步结果集齐、交给模型之前」（prepareStep）批量判定。
// 「查结果集」的取数实现是纯字符串操作，不绑定数据来源（将来读本地文件复用，研发约束）。

import { getDb, insertToolResult, getToolResult } from '../db'

// 数值初值（技术方案初值表，实测调优的起点；07-13 修订：取数按行、单次上限调大）
export const RESULT_LIMIT = 30_000 // 单结果上限（字符）
export const TOTAL_LIMIT = 100_000 // 会话内工具结果总量上限
export const PREVIEW_CHARS = 1_000 // 摘要开头样例 / 时间线预览
export const FETCH_LIMIT = 30_000 // 查结果集单次返回上限（业界单次 2000 行量级，1 万实测逼出小段多次）
export const SEARCH_CONTEXT_DEFAULT = 5 // 命中上下文默认行数（模型可调，对齐 Grep -C）
export const SEARCH_CONTEXT_MAX = 50
export const SEARCH_HITS = 10 // 单次最多返回命中处数（超出可用 fromHit 翻页）

// 落库归一的唯一例外：压缩成单行的 JSON 格式化为多行——不改数据，只为按行取数有行可依
function normalizeForStore(text: string): string {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return text
  const longLine = text.split('\n').some((l) => l.length > 1000)
  if (!longLine) return text
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return text
  }
}

// 给模型的摘要（也是时间线展开的预览，同一份数据）。
// 编号的内部属性写进摘要本身：仅靠输出约定条款拦不住模型把编号转述给用户（实测约半数泄漏）
export function overflowSummary(id: number, content: string): string {
  const lineCount = content.split('\n').length
  return `共约 ${content.length} 字、${lineCount} 行。开头样例：${content.slice(0, PREVIEW_CHARS)}。已存为结果编号 #${id}——这是你的内部取数编号，需要更多内容时用「查结果集」：先搜关键词拿到行号，再从该行起一次读取整段，不要小段多次。不要在给用户的回答里提到编号或这套存取机制。`
}

// 轮内超限状态：resultRef 映射（tool item 标注用）+ 本轮已全文放行的字数累计
export interface OverflowCtx {
  convId: string
  refs: Map<string, number> // toolCallId → 结果编号
  turnFullChars: number // 本轮已全文交给模型的结果字数（总量闸增量）
}

// 单结果闸：超限即全量落库（结构化数据一并存，制品第一层解析用），返回摘要替代原文
export function guardSingle(
  ctx: OverflowCtx,
  toolCallId: string,
  toolName: string,
  text: string,
  structured?: unknown
): string {
  if (text.length <= RESULT_LIMIT) return text
  const content = normalizeForStore(text)
  const id = insertToolResult({
    conversationId: ctx.convId,
    toolCallId,
    toolName,
    content,
    structuredContent: structured === undefined ? null : JSON.stringify(structured)
  })
  ctx.refs.set(toolCallId, id)
  return overflowSummary(id, content)
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
    const content = normalizeForStore(b.text)
    const id = insertToolResult({ conversationId: ctx.convId, toolCallId: b.toolCallId, toolName: b.toolName, content })
    ctx.refs.set(b.toolCallId, id)
    replaced.set(b.toolCallId, overflowSummary(id, content))
    total -= b.text.length
  }
  // 留在线内的按全文放行，计入本轮累计
  for (const b of batch) {
    if (!replaced.has(b.toolCallId)) ctx.turnFullChars += b.text.length
  }
  return replaced
}

// 「查结果集」取数（07-13 修订，参数面对齐 Claude Code Grep/Read）：
// 按关键词搜（正则、逐行匹配、命中带行号、上下文行数可调、可翻页）/ 按行读取整段，单次返回封顶
export function fetchFromResult(
  convId: string,
  args: {
    resultId?: number
    mode?: string
    pattern?: string
    context?: number
    fromHit?: number
    startLine?: number
    lines?: number
  }
): string | { error: string } {
  const id = Number(args.resultId)
  if (!Number.isInteger(id)) return { error: '缺少 resultId：请传入要取用的结果编号（如 #3 传 3）' }
  const row = getToolResult(id, convId)
  if (!row) return { error: `结果编号 #${id} 不存在或不属于本会话` }
  const all = row.content.split('\n')

  if (args.mode === 'search') {
    const raw = String(args.pattern ?? '').trim()
    if (!raw) return { error: 'search 模式需要 pattern 参数' }
    let re: RegExp
    try {
      re = new RegExp(raw, 'i')
    } catch {
      re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') // 非法正则退回普通文本匹配
    }
    const ctx = Math.min(SEARCH_CONTEXT_MAX, Math.max(0, Number(args.context ?? SEARCH_CONTEXT_DEFAULT) || 0))
    const from = Math.max(0, Number(args.fromHit ?? 0) || 0)
    const matched: number[] = []
    for (let i = 0; i < all.length; i++) if (re.test(all[i])) matched.push(i)
    if (!matched.length) return `结果 #${id}（共 ${all.length} 行）中未匹配到「${raw}」`
    if (from >= matched.length) return { error: `fromHit=${from} 超出命中范围（共 ${matched.length} 处）` }
    const page = matched.slice(from, from + SEARCH_HITS)
    const blocks = page.map((i) => {
      const s = Math.max(0, i - ctx)
      const e = Math.min(all.length - 1, i + ctx)
      return all
        .slice(s, e + 1)
        .map((l, k) => `${s + k + 1}: ${l}`)
        .join('\n')
    })
    let text =
      `结果 #${id}（共 ${all.length} 行）中「${raw}」命中 ${matched.length} 处，` +
      `显示第 ${from + 1}-${from + page.length} 处（每处前后 ${ctx} 行，行号: 内容）：\n\n${blocks.join('\n---\n')}`
    if (matched.length > from + page.length) {
      text += `\n\n（还有 ${matched.length - from - page.length} 处命中，用 fromHit=${from + page.length} 翻页）`
    }
    return text.length > FETCH_LIMIT ? `${text.slice(0, FETCH_LIMIT)}\n（已达单次上限截断，可调小 context 或翻页）` : text
  }

  // 缺省按行读取
  const start = Math.max(1, Number(args.startLine ?? 1) || 1)
  if (start > all.length) return { error: `起始行 ${start} 超出范围（共 ${all.length} 行）` }
  const want = Math.max(1, Number(args.lines ?? all.length) || all.length)
  const out: string[] = []
  let used = 0
  let end = start - 1
  for (let i = start - 1; i < Math.min(all.length, start - 1 + want); i++) {
    const line = `${i + 1}: ${all[i]}`
    if (used + line.length > FETCH_LIMIT && out.length) break
    out.push(line)
    used += line.length + 1
    end = i + 1
  }
  let text = `结果 #${id}（共 ${all.length} 行，第 ${start}-${end} 行，行号: 内容）：\n${out.join('\n')}`
  if (end < Math.min(all.length, start - 1 + want)) {
    text += `\n（已达单次 ${FETCH_LIMIT} 字上限，续读用 startLine=${end + 1}）`
  }
  return text
}
