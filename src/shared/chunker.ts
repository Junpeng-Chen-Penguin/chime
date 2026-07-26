// Markdown 切块器：行扫描状态机。
// 规则（PRD Case 2 处理规则）：按最底层标题切；超长在段落边界再切；过短合并；
// 表格/围栏代码原子不可切；每片带标题链与起止行号（来源坐标）。

export interface Chunk {
  headingPath: string // '续签 › 新计费生效'（不含文件名，入库时由调用方拼）
  startLine: number // 1-based，含
  endLine: number // 1-based，含
  content: string
}

// 正文 token 预算：给标题链与模型特殊符号留余量，保证 embedding 输入 < 512
const MAX_TOKENS = 380
// 低于此长度的片段并入相邻片段
const MIN_CHARS = 50

// ponytail: 估算而非真分词——中文 1 字 1 token，其余字符 2 字 1 token（偏保守）；
// 若实测常超窗，再换 tokenizer 实数
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (/[一-鿿　-〿＀-￯]/.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 2)
}

interface Block {
  lines: string[]
  startLine: number
  endLine?: number // 缺省按 lines 长度推算；切分表格的片带重复表头（不占物理行），须显式给出
  atomic: boolean // 表格 / 围栏代码：不可从中间切
}

// 表格片预算比 MAX_TOKENS 更紧：表格行彼此独立，重排窗口（320，含 query、文件路径、特殊符号）
// 截掉的尾行等于直接丢失，所以整片必须装进重排窗口；散文片开头能代表整篇，截尾无碍，不受此限
const TABLE_PIECE_TOKENS = 240

// 超预算的表格按数据行切分，每片重复表头——原子性保留的是「不从行中间切、表头始终在场」，
// 去掉的只是「无上限」；围栏代码不切（从中间切会失去语法完整性）
function splitOversizedTable(b: Block): Block[] {
  const isTable = b.atomic && /^\s*\|/.test(b.lines[0] ?? '')
  if (!isTable || estimateTokens(b.lines.join('\n')) <= TABLE_PIECE_TOKENS) return [b]
  // 表头 = 列名行 + 分隔行；没有分隔行的非标准表格不重复表头，只按行切
  const header = /^\|[\s:|-]+$/.test((b.lines[1] ?? '').trim()) ? b.lines.slice(0, 2) : []
  const headerTokens = estimateTokens(header.join('\n'))
  const out: Block[] = []
  let rows: string[] = []
  let rowStart = header.length
  const flush = (endIdx: number): void => {
    if (rows.length === 0) return
    out.push({
      lines: [...header, ...rows],
      // 首片的表头是物理存在的，坐标从表头起；后续片的表头是重复出来的，坐标只算数据行
      startLine: b.startLine + (out.length === 0 ? 0 : rowStart),
      endLine: b.startLine + endIdx,
      atomic: true
    })
    rows = []
  }
  let tokens = headerTokens
  for (let i = header.length; i < b.lines.length; i++) {
    const rowTokens = estimateTokens(b.lines[i])
    if (rows.length > 0 && tokens + rowTokens > TABLE_PIECE_TOKENS) {
      flush(i - 1)
      tokens = headerTokens
    }
    if (rows.length === 0) rowStart = i
    rows.push(b.lines[i])
    tokens += rowTokens
  }
  flush(b.lines.length - 1)
  return out
}

interface Section {
  headingPath: string[]
  blocks: Block[]
}

export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let headings: { level: number; text: string }[] = []
  let cur: Section = { headingPath: [], blocks: [] }
  let block: Block | null = null
  let i = 0

  // front matter：文件头的 --- 包裹区，跳过（行号照常推进）
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---')
    if (end > 0) i = end + 1
  }

  const flushBlock = (): void => {
    if (block && block.lines.some((l) => l.trim() !== '')) cur.blocks.push(block)
    block = null
  }
  const flushSection = (): void => {
    flushBlock()
    if (cur.blocks.length > 0) sections.push(cur)
  }

  let fence: string | null = null // 当前围栏的开栏标记（``` 或 ~~~）

  for (; i < lines.length; i++) {
    const line = lines[i]
    const fenceMark = line.match(/^\s*(```+|~~~+)/)?.[1] ?? null

    if (fence) {
      block!.lines.push(line)
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null
      continue
    }

    if (fenceMark) {
      flushBlock()
      block = { lines: [line], startLine: i + 1, atomic: true }
      fence = fenceMark
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      flushSection()
      const level = heading[1].length
      headings = headings.filter((h) => h.level < level)
      headings.push({ level, text: heading[2] })
      cur = { headingPath: headings.map((h) => h.text), blocks: [] }
      continue
    }

    const isTableLine = /^\s*\|/.test(line)
    if (isTableLine) {
      if (!block || !block.atomic) {
        flushBlock()
        block = { lines: [], startLine: i + 1, atomic: true }
      }
      block.lines.push(line)
      continue
    }

    if (line.trim() === '') {
      flushBlock() // 空行 = 段落边界
      continue
    }

    if (!block || block.atomic) {
      flushBlock()
      block = { lines: [], startLine: i + 1, atomic: false }
    }
    block.lines.push(line)
  }
  flushSection()

  // 每节：块序列按 token 预算聚合成片段；原子块整体进片段（超预算也不切）
  const chunks: Chunk[] = []
  for (const sec of sections) {
    const path = sec.headingPath.join(' › ')
    let acc: Block[] = []

    const emit = (): void => {
      if (acc.length === 0) return
      const content = acc
        .map((b) => b.lines.join('\n'))
        .join('\n\n')
        .trim()
      if (content) {
        chunks.push({
          headingPath: path,
          startLine: acc[0].startLine,
          endLine:
            acc[acc.length - 1].endLine ??
            acc[acc.length - 1].startLine + acc[acc.length - 1].lines.length - 1,
          content
        })
      }
      acc = []
    }

    for (const b of sec.blocks.flatMap(splitOversizedTable)) {
      const accTokens = estimateTokens(acc.map((x) => x.lines.join('\n')).join('\n'))
      const bTokens = estimateTokens(b.lines.join('\n'))
      if (acc.length > 0 && accTokens + bTokens > MAX_TOKENS) emit()
      acc.push(b)
    }
    emit()
  }

  // 过短片段并入前一个同路径片段（跨标题不并，保住标题链准确性）
  const merged: Chunk[] = []
  for (const c of chunks) {
    const prev = merged[merged.length - 1]
    if (prev && prev.headingPath === c.headingPath && c.content.length < MIN_CHARS) {
      prev.content += '\n\n' + c.content
      prev.endLine = c.endLine
    } else if (
      prev &&
      prev.headingPath === c.headingPath &&
      prev.content.length < MIN_CHARS &&
      estimateTokens(prev.content + c.content) <= MAX_TOKENS
    ) {
      prev.content += '\n\n' + c.content
      prev.endLine = c.endLine
    } else {
      merged.push({ ...c })
    }
  }
  return merged
}
