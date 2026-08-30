// 制品（数据表格）：模型有意为用户生成的数据成品，自包含快照——生成那一刻数据完整物化落库，
// 此后不依赖结果库。解析三层阶梯（PRD 制品章）：结构化数据 → 尽力解析 → 解析不动不生成。

import { insertArtifact, getToolResult } from '../db'

export const TABLE_RENDER_CAP = 2_000 // 侧板渲染上限（数据完整在库，渲染截断防卡）

export interface ArtifactRef {
  resultId?: number
  start?: number
  length?: number
  keyword?: string
}

type Table = { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }

// 第一层：结构化数据（服务 structuredContent / 模型直接给的数组）→ 键即列
function fromStructured(data: unknown): Table | null {
  const arr = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? // 单对象一行成表；对象内首个数组字段视为行集（MCP structuredContent 常见形状 { 字段: [...] }）
        ((Object.values(data).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [data])
      : null
  if (!arr?.length) return null
  const objs = arr.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)
  )
  if (!objs.length) return null
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))]
  if (!keys.length) return null
  return { columns: keys.map((k) => ({ key: k, label: k })), rows: objs }
}

// 第二层：尽力解析文本——JSON 数组 / 首行表头的分隔文本 / 「标签 值」逐格标注的分隔文本
function fromText(text: string): Table | null {
  const t = text.trim()
  if (!t) return null
  // JSON 数组（或包着数组的对象）
  if (/^[[{]/.test(t)) {
    try {
      return fromStructured(JSON.parse(t))
    } catch {
      // 不是 JSON，继续走分隔文本
    }
  }
  const lines = t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return null
  const delim = ['|', '\t', ','].find((d) => lines[0].includes(d) && lines[1].includes(d))
  if (!delim) return null
  const split = (l: string): string[] =>
    l
      .split(delim)
      .map((c) => c.trim())
      .filter((c) => c !== '')
  const first = split(lines[0])
  if (first.length < 2) return null
  // 「标签 值」逐格标注（如 `租户 A公司 | 周期 2026-06`）：每格以同一批标签开头 → 标签为列
  const labelOf = (cell: string): string | null => {
    const m = /^(\S+)\s+\S/.exec(cell)
    return m ? m[1] : null
  }
  const firstLabels = first.map(labelOf)
  const labeled =
    firstLabels.every(Boolean) &&
    lines.slice(1, 5).every((l) => split(l).map(labelOf).join() === firstLabels.join())
  if (labeled) {
    const cols = firstLabels as string[]
    const rows = lines.map((l) => {
      const row: Record<string, unknown> = {}
      for (const cell of split(l)) {
        const m = /^(\S+)\s+(.*)$/.exec(cell)
        if (m) row[m[1]] = m[2]
      }
      return row
    })
    return { columns: cols.map((k) => ({ key: k, label: k })), rows }
  }
  // 首行表头样式：后续行列数与表头一致
  const bodyRows = lines.slice(1).map(split)
  if (!bodyRows.length || !bodyRows.every((r) => r.length === first.length)) return null
  return {
    columns: first.map((k) => ({ key: k, label: k })),
    rows: bodyRows.map((cells) => Object.fromEntries(first.map((k, i) => [k, cells[i]])))
  }
}

// 引用取数：按结果编号取内容（可带位置范围 / 关键词行筛选），与查结果集共用结果库读取
function resolveRef(
  convId: string,
  ref: ArtifactRef
): { structured?: unknown; text?: string } | { error: string; userText?: string } {
  const id = Number(ref.resultId)
  if (!Number.isInteger(id)) return { error: '数据引用缺少 resultId', userText: '调用参数不完整' }
  const row = getToolResult(id, convId)
  if (!row) return { error: `结果编号 #${id} 不存在或不属于本会话`, userText: '数据引用无效' }
  // 无附加条件且有结构化数据 → 第一层
  if (!ref.keyword && ref.start === undefined && row.structuredContent) {
    try {
      return { structured: JSON.parse(row.structuredContent) }
    } catch {
      // 结构化数据损坏则回落文本
    }
  }
  let text = row.content
  if (ref.keyword) {
    const kw = String(ref.keyword)
    text = text
      .split('\n')
      .filter((l) => l.includes(kw))
      .join('\n')
    if (!text) return { error: `结果 #${id} 中没有包含「${kw}」的行`, userText: '筛选后没有数据' }
  } else if (ref.start !== undefined || ref.length !== undefined) {
    const start = Math.max(0, Number(ref.start ?? 0) || 0)
    const len = Math.max(1, Number(ref.length ?? row.content.length) || row.content.length)
    text = text.slice(start, start + len)
  }
  return { text }
}

// CSV 导出（013 Case 3）：开头加 BOM 让 Excel 按 UTF-8 解，否则中文乱码；
// 值含逗号/引号/换行的按 CSV 标准加引号转义，引号写两遍。
// Excel 对数字的自作主张（吃前导零、超 15 位变科学计数法）不处理，值原样输出——
// 处理它（写成 ="007"）会让所有其他软件里的数据都变脏，理由见产品方案
export function artifactCsv(
  columns: { key: string; label: string }[],
  rows: Record<string, unknown>[]
): string {
  const esc = (v: unknown): string => {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  const lines = [columns.map((c) => esc(c.label)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => esc(row[c.key])).join(','))
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

// 生成制品：解析成功 → 物化落库，返回制品信息；解析不动 → 不生成（错误交回模型换路）。
// 不设说明字段：数据是什么由对话正文交代，制品只装标题与数据本体（同一信息只出现一次）
export function createArtifact(
  convId: string,
  args: { title?: string; data?: unknown; ref?: ArtifactRef }
): { id: number; title: string; rowCount: number } | { error: string; userText?: string } {
  const title = String(args.title ?? '').trim() || '数据表格'
  let table: Table | null = null
  if (args.ref) {
    const got = resolveRef(convId, args.ref)
    if ('error' in got) return got
    table = got.structured !== undefined ? fromStructured(got.structured) : fromText(got.text ?? '')
  } else if (args.data !== undefined) {
    table = typeof args.data === 'string' ? fromText(args.data) : fromStructured(args.data)
  } else {
    return { error: '缺少数据：data（直接内容）或 ref（数据引用）必须提供一个', userText: '数据没有传过来' }
  }
  if (!table) return { error: '数据无法解析为表格，未生成制品', userText: '这批数据不是行列结构，做不成表格' }
  const id = insertArtifact({
    conversationId: convId,
    title,
    columns: table.columns,
    rows: table.rows
  })
  return { id, title, rowCount: table.rows.length }
}
