// 工具结果超限处理：全量存本地、模型只拿够决策的部分，不够再取（PRD 超限机制章）。
// 两道闸：单结果闸在 execute 返回时判定；总量闸在「本步结果集齐、交给模型之前」（prepareStep）批量判定。
// 「查结果集」的取数实现是纯字符串操作，不绑定数据来源（将来读本地文件复用，研发约束）。

import { getDb, insertToolResult, getToolResult, listToolResults } from '../db'

// 数值初值（技术方案初值表，实测调优的起点；07-13 修订：取数按行、单次上限调大）
export const RESULT_LIMIT = 30_000 // 单结果上限（字符）
export const TOTAL_LIMIT = 100_000 // 会话内工具结果总量上限
export const PREVIEW_CHARS = 1_000 // 摘要开头样例 / 时间线预览
export const TAIL_CHARS = 200 // 摘要结尾样例：分页总数、收尾元信息多在尾部（goose 内联预览同理只保尾部）
export const FETCH_LIMIT = 30_000 // 取数单次返回上限（字符兜底；行数上限见 GREP_HEAD_LIMIT / READ_LINES_DEFAULT）
export const GREP_HEAD_LIMIT = 250 // grep 输出默认行数上限（对齐 Claude Code Grep head_limit 默认值）
export const READ_LINES_DEFAULT = 2_000 // read 默认读取行数（对齐 Claude Code Read 默认值）

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
  // 标明未展示的规模：防止模型把头尾样例当全量下结论（07-14 修订，评估曾现直接凭样例作答的案例）
  const midChars = content.length - PREVIEW_CHARS - TAIL_CHARS
  const tail =
    content.length > PREVIEW_CHARS + TAIL_CHARS
      ? `以上仅是开头样例，中间约 ${midChars} 字未展示。结尾样例（总数、页码等元信息常在这里）：…${content.slice(-TAIL_CHARS)}。`
      : ''
  return `共约 ${content.length} 字、${lineCount} 行。开头样例：${content.slice(0, PREVIEW_CHARS)}。${tail}已存为结果编号 #${id}——这是你的内部取数编号，需要更多内容时先用 grep_result 搜关键词定位（多个词用 | 合并一次搜），再用 read_result 从命中行号一次读取整段，不要小段多次。不要在给用户的回答里提到编号或这套存取机制。`
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
        if (it.name === 'fetch_tool_result' || it.name === 'grep_result' || it.name === 'read_result') continue // 豁免：取数工具取回的片段不计（fetch_tool_result 为历史轮的旧工具名）
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

// 取数两工具（07-13 二次修订：单工具 mode 切换拆为 grep/read 两工具，形态与输出仿 grep -n / 按行读，
// 参数面照搬 Claude Code Grep/Read，仅把文件路径换成结果编号——mode 参数映射是语料外结构，模型用不地道）

function loadResult(convId: string, resultId: unknown): { all: string[]; id: number } | { error: string } {
  const id = Number(resultId)
  if (!Number.isInteger(id)) return { error: '缺少 resultId：请传入要取用的结果编号（如 #3 传 3）' }
  const row = getToolResult(id, convId)
  if (!row) return { error: `结果编号 #${id} 不存在或不属于本会话` }
  return { all: row.content.split('\n'), id }
}

// 单个结果内的匹配：输出仿 rg -n（命中行「N:内容」、上下文行「N-内容」、不连续块间 --）。
// prefix 用于跨结果搜索时标明来源（「#id:」，对齐 grep 多文件输出的「文件名:行号:内容」）
function matchInContent(
  all: string[],
  re: RegExp,
  ctx: number,
  prefix: string
): { hits: number; outLines: string[] } {
  const matched = new Set<number>()
  for (let i = 0; i < all.length; i++) if (re.test(all[i])) matched.add(i)
  if (!matched.size) return { hits: 0, outLines: [] }
  const show = new Set<number>()
  for (const i of matched) {
    for (let k = Math.max(0, i - ctx); k <= Math.min(all.length - 1, i + ctx); k++) show.add(k)
  }
  const ordered = [...show].sort((a, b) => a - b)
  const outLines: string[] = []
  let prev = -2
  for (const i of ordered) {
    if (i !== prev + 1 && prev >= 0) outLines.push('--')
    outLines.push(`${prefix}${i + 1}${matched.has(i) ? ':' : '-'}${all[i]}`)
    prev = i
  }
  return { hits: matched.size, outLines }
}

// grep_result：逐行正则匹配。resultId 缺省时搜本会话全部已存结果（等价 grep 整个目录，命中带 #编号 前缀）
export function grepResult(
  convId: string,
  args: { resultId?: number; pattern?: string; '-i'?: boolean; context?: number; head_limit?: number; offset?: number }
): string | { error: string } {
  const raw = String(args.pattern ?? '').trim()
  if (!raw) return { error: '缺少 pattern 参数' }
  const flags = args['-i'] ? 'i' : ''
  let re: RegExp
  try {
    re = new RegExp(raw, flags)
  } catch {
    re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags) // 非法正则退回普通文本匹配
  }
  const ctx = Math.max(0, Number(args.context ?? 0) || 0)

  let hits = 0
  let outLines: string[] = []
  let header: string
  if (args.resultId === undefined || args.resultId === null) {
    const rows = listToolResults(convId)
    if (!rows.length) return { error: '本会话没有已存结果' }
    for (const row of rows) {
      const m = matchInContent(row.content.split('\n'), re, ctx, `#${row.id}:`)
      if (!m.hits) continue
      if (outLines.length) outLines.push('--')
      hits += m.hits
      outLines = outLines.concat(m.outLines)
    }
    if (!hits) return `全部已存结果（${rows.length} 个）中未匹配到「${raw}」`
    header = `全部已存结果（${rows.length} 个）中「${raw}」命中 ${hits} 处（#编号:行号:内容）：`
  } else {
    const r = loadResult(convId, args.resultId)
    if ('error' in r) return r
    const m = matchInContent(r.all, re, ctx, '')
    if (!m.hits) return `结果 #${r.id}（共 ${r.all.length} 行）中未匹配到「${raw}」`
    hits = m.hits
    outLines = m.outLines
    header = `结果 #${r.id}（共 ${r.all.length} 行）「${raw}」命中 ${hits} 处：`
  }

  const skip = Math.max(0, Number(args.offset ?? 0) || 0)
  const head = Math.max(1, Number(args.head_limit ?? GREP_HEAD_LIMIT) || GREP_HEAD_LIMIT)
  const page = outLines.slice(skip, skip + head)
  let text = `${header}\n${page.join('\n')}`
  if (text.length > FETCH_LIMIT) text = `${text.slice(0, FETCH_LIMIT)}\n[超过单次 ${FETCH_LIMIT} 字上限截断，可缩小 context 或用 offset 翻页]`
  else if (outLines.length > skip + page.length) {
    text += `\n[输出共 ${outLines.length} 行，已显示第 ${skip + 1}-${skip + page.length} 行；继续用 offset=${skip + page.length}]`
  }
  return text
}

// read_result：按行号读一段原文（输出「N:内容」），单次字符封顶
export function readResult(
  convId: string,
  args: { resultId?: number; offset?: number; limit?: number }
): string | { error: string } {
  const r = loadResult(convId, args.resultId)
  if ('error' in r) return r
  const { all, id } = r
  const start = Math.max(1, Number(args.offset ?? 1) || 1)
  if (start > all.length) return { error: `起始行 ${start} 超出范围（共 ${all.length} 行）` }
  const want = Math.max(1, Number(args.limit ?? READ_LINES_DEFAULT) || READ_LINES_DEFAULT)
  const out: string[] = []
  let used = 0
  let end = start - 1
  for (let i = start - 1; i < Math.min(all.length, start - 1 + want); i++) {
    const line = `${i + 1}:${all[i]}`
    if (used + line.length > FETCH_LIMIT && out.length) break
    out.push(line)
    used += line.length + 1
    end = i + 1
  }
  let text = `结果 #${id}（共 ${all.length} 行，第 ${start}-${end} 行）：\n${out.join('\n')}`
  if (end < Math.min(all.length, start - 1 + want)) {
    text += `\n[已达单次 ${FETCH_LIMIT} 字上限，续读用 offset=${end + 1}]`
  }
  return text
}
