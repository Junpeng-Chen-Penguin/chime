// 调用行（016 Case 5/6）：思考与工具调用共用一套「图标 + 动词 + 描述」三段式，
// 一行一次调用；点整行展开详情，最终回答完成后整组折叠。
// 动词从 shared/builtinTools 的登记表取（与设置页展示名同源不同字段），图标映射只在本文件。

import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Folder,
  MessageCircleQuestion,
  Puzzle,
  Search,
  Sparkles,
  Table,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { builtinEntry } from '../../../shared/builtinTools'
import type { SearchToolResult, SourceRef, TurnItem } from '../../../preload/index.d'
import { diffLines } from 'diff'

type ToolItem = Extract<TurnItem, { t: 'tool' }>
type CallItem = Extract<TurnItem, { t: 'reasoning' | 'tool' }>

// ── 图标映射（键 = 函数名；思考与 MCP 是渲染层固定配置，不进登记表）──
const TOOL_ICONS: Record<string, LucideIcon> = {
  search_knowledge_base: Search,
  ask_user_question: MessageCircleQuestion,
  create_artifact: Table,
  grep_result: FileSearch,
  read_result: FileSearch,
  fetch_tool_result: FileSearch, // 退役工具名：历史会话的旧调用行
  read_file: FileText,
  list_dir: Folder,
  write_file: FilePlus,
  edit_file: FilePen,
  activate_skill: Puzzle
}

// ── 描述位截断（Case 5 功能点 6）：35 字上限，路径中间截断，其余尾部截断，title 看全文 ──
const DESC_MAX = 35
function truncTail(s: string): string {
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1) + '…' : s
}
function baseName(p: unknown): string {
  return (
    String(p ?? '')
      .split('/')
      .filter(Boolean)
      .pop() ?? ''
  )
}

// 结果规模口径（与主进程摘要一致）：千字 / 万字取整
export function formatChars(n: number): string {
  if (n < 1000) return `${n} 字`
  if (n < 10000) return `约 ${Math.round(n / 1000)} 千字`
  return `约 ${Math.round(n / 10000)} 万字`
}

// 取数工具参数的人话标签与取值（grep_result / read_result；mode/startLine/start 等键是历史旧形态）
function fetchArgLabel(name: string | undefined, k: string): string {
  if (k === 'offset') return name === 'read_result' ? '起始行' : '翻页'
  const labels: Record<string, string> = {
    resultId: '取自结果',
    pattern: '匹配',
    context: '上下文',
    head_limit: '行数上限',
    '-i': '大小写',
    limit: '行数',
    mode: '取数方式',
    fromHit: '翻页',
    startLine: '起始行',
    lines: '行数',
    start: '起始位置',
    length: '读取长度',
    keyword: '关键词'
  }
  return labels[k] ?? k
}
function fetchArgValue(name: string | undefined, k: string, v: unknown): string {
  if (k === 'mode')
    return v === 'search' ? '按关键词搜索' : v === 'read' ? '按行读取' : '按位置读取'
  if (k === 'resultId') return `#${v}`
  if (k === 'offset')
    return name === 'read_result'
      ? `第 ${Number(v).toLocaleString()} 行起`
      : `跳过前 ${Number(v)} 行`
  if (k === 'startLine') return `第 ${Number(v).toLocaleString()} 行起`
  if (k === 'lines' || k === 'limit' || k === 'head_limit')
    return `${Number(v).toLocaleString()} 行`
  if (k === 'context') return `前后 ${Number(v)} 行`
  if (k === '-i') return v ? '忽略' : '区分'
  if (k === 'fromHit') return `跳过前 ${Number(v)} 处命中`
  if (k === 'start') return `第 ${Number(v).toLocaleString()} 字起`
  if (k === 'length') return `${Number(v).toLocaleString()} 字`
  return typeof v === 'string' ? v : JSON.stringify(v)
}

// ── 一行的三段内容：按工具与状态推导动词、描述、失败与否 ──
interface RowFace {
  icon: LucideIcon
  verb: string
  desc: string
  descFull?: string // 截断前的全文（title 用）；空 = 与 desc 相同
  failed?: boolean // 失败动词标红（Case 5 功能点 4）
  running?: boolean // 进行中整行脉动
}

function searchFace(item: ToolItem): RowFace {
  const r = item.result as SearchToolResult | undefined
  const q = String((item.args as { query?: string }).query ?? '')
  if (r === undefined)
    return { icon: Search, verb: '检索中', desc: truncTail(q), descFull: q, running: true }
  if (r.results) {
    const files = new Set(r.results.map((x) => x.file)).size
    return { icon: Search, verb: '检索', desc: `命中 ${files} 篇` }
  }
  if (r.error) return { icon: Search, verb: '检索失败', desc: item.userText ?? '检索出错', failed: true }
  const desc = r.denied
    ? '已达检索上限'
    : r.notice
      ? '知识库更新中'
      : r.invalid
        ? '未提供检索词'
        : (item.userText ?? '已中断')
  return { icon: Search, verb: '检索', desc }
}

function toolFace(item: ToolItem, mcpRunning: boolean): RowFace {
  if (item.name === 'search_knowledge_base') return searchFace(item)
  const entry = builtinEntry(item.name)
  const icon = TOOL_ICONS[item.name] ?? Wrench
  const doing = entry?.verbDoing ?? '调用中'
  const done = entry?.verbDone ?? '调用'
  const r = item.result as
    | string
    | { error?: string; denied?: string; interrupted?: string }
    | undefined
  const args = item.args ?? {}

  // 进行中的描述位：调用对象（参数流式期间为空）
  const doingDesc = (): { desc: string; full?: string } => {
    if (item.inputStreaming) return { desc: '' }
    switch (item.name) {
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return { desc: truncTail(baseName((args as { path?: string }).path)) }
      case 'list_dir':
        return { desc: truncTail(baseName((args as { path?: string }).path)) }
      case 'grep_result': {
        const p = String((args as { pattern?: string }).pattern ?? '')
        return { desc: truncTail(p), full: p }
      }
      case 'activate_skill':
        return { desc: truncTail(String((args as { name?: string }).name ?? '')) }
      case 'ask_user_question':
      case 'create_artifact':
      case 'read_result':
        return { desc: '' }
      default: {
        // MCP：服务名与工具名（display 落库为「服务名:工具名」）
        const d = item.display ?? item.name
        return { desc: truncTail(d), full: d }
      }
    }
  }

  // 等卡（授权待回应）：动词保持进行中，描述给对象；排队与等待的区分由授权卡承载
  if (item.auth === 'pending' || item.ask?.state === 'pending' || r === undefined) {
    const { desc, full } = doingDesc()
    return { icon, verb: doing, desc, descFull: full, running: !mcpRunning ? true : true }
  }

  // 授权拒绝：单行终态（Case 7），无执行过程
  if (item.auth === 'denied' || (typeof r === 'object' && r?.denied))
    return { icon, verb: '已拒绝', desc: doingDesc().desc }

  // 中断补齐（Case 14 功能点 2）：等卡未回应 →「已结束」，其余 →「已中断」；描述用 userText
  if (typeof r === 'object' && r?.interrupted) {
    const verb = item.auth === 'unanswered' || item.ask?.state === 'unanswered' ? '已结束' : '已中断'
    return { icon, verb, desc: item.userText ?? '' }
  }

  // 失败：动词 = 结束动词 + 失败，红色；描述是面向用户的那句（Case 5 功能点 4/5）
  if (typeof r === 'object' && r?.error)
    return { icon, verb: `${done}失败`, desc: item.userText ?? '', failed: true }

  // 提问收场三态
  if (item.ask) {
    const st = item.ask.state
    const desc =
      st === 'answered'
        ? `已回答 ${item.ask.answers?.length ?? 0} 题`
        : st === 'skipped'
          ? '已跳过'
          : '未回应'
    return { icon, verb: '提问', desc }
  }

  // 成功结束的描述位（Case 5 功能点 3 表）
  const text = typeof r === 'string' ? r : ''
  const lines = text ? text.split('\n') : []
  switch (item.name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return { icon, verb: done, desc: truncTail(baseName((args as { path?: string }).path)) }
    case 'list_dir': {
      // 文件树里目录名末尾带斜杠：不带斜杠的行是文件
      const files = lines.filter((l) => l.trim() && !l.trimEnd().endsWith('/')).length
      return { icon, verb: done, desc: `${files} 个文件` }
    }
    case 'grep_result': {
      const hits = lines.filter((l) => /^\s*#?\d*:?\d+:/.test(l)).length || lines.length
      return { icon, verb: done, desc: `命中 ${hits} 处` }
    }
    case 'read_result':
      return { icon, verb: done, desc: `${lines.length} 行` }
    case 'activate_skill':
      return { icon, verb: done, desc: truncTail(String((args as { name?: string }).name ?? '')) }
    default:
      // 超限已存的结果 r 是摘要，规模看不出，退回通用词
      return {
        icon,
        verb: done,
        desc: item.resultRef ? '返回已存为结果集' : `返回${formatChars(text.length)}`
      }
  }
}

function faceOf(item: CallItem, running: boolean): RowFace {
  if (item.t === 'reasoning')
    return { icon: Sparkles, verb: running ? '思考中' : '思考', desc: '', running }
  return toolFace(item, running)
}

// ── 限高渐隐（Case 6 功能点 6）：超出限高时底部渐隐加展开箭头，点开显示全部 ──
function ClampBox({ maxH, children }: { maxH: number; children: ReactNode }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  // 挂载后量一次即可：详情内容是终态数据，不再变化
  const measure = (el: HTMLDivElement | null): void => {
    ;(ref as { current: HTMLDivElement | null }).current = el
    if (el) setOverflowing(el.scrollHeight > maxH + 4)
  }
  return (
    <div className="relative">
      <div ref={measure} style={expanded ? undefined : { maxHeight: maxH }} className="overflow-hidden">
        {children}
      </div>
      {overflowing && !expanded && (
        <div className="absolute right-0 bottom-0 left-0 flex justify-center bg-gradient-to-t from-muted/90 to-transparent pt-6 pb-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(true)
            }}
            className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-black/5"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

// ── 编辑文件详情：按行比对着色（Case 6 功能点 5）──
function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }): React.JSX.Element {
  const parts = useMemo(() => diffLines(oldStr, newStr), [oldStr, newStr])
  return (
    <div className="font-mono text-[12px] leading-[1.7]">
      {parts.map((p, i) =>
        p.value
          .replace(/\n$/, '')
          .split('\n')
          .map((line, j) => (
            <div
              key={`${i}-${j}`}
              className={cn(
                'flex gap-2 px-1',
                p.added && 'bg-emerald-50',
                p.removed && 'bg-red-50'
              )}
            >
              <span className="w-3 flex-none select-none text-muted-foreground/50">
                {p.added ? '+' : p.removed ? '-' : ' '}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-all">{line}</span>
            </div>
          ))
      )}
    </div>
  )
}

// 参数键值两列（Case 6 功能点 3）：键宽 120px 次文字色
function KvRows({
  entries,
  toolName,
  translate
}: {
  entries: [string, unknown][]
  toolName?: string
  translate?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-3 text-[13px]">
          <span className="w-[120px] flex-none truncate text-muted-foreground">
            {translate ? fetchArgLabel(toolName, k) : k}
          </span>
          <span className="min-w-0 break-all">
            {translate ? fetchArgValue(toolName, k, v) : typeof v === 'string' ? v : JSON.stringify(v)}
          </span>
        </div>
      ))}
    </div>
  )
}

// 详情区（Case 6 功能点 3/4）：圆角浅灰底框，上半参数、下半结果，按工具选内容与样式
function CallDetail({
  item,
  sourcePool,
  onOpenSource
}: {
  item: CallItem
  sourcePool?: SourceRef[] // 本条消息的来源池：检索命中点开进侧板靠它反查
  onOpenSource?: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  if (item.t === 'reasoning') {
    return (
      <DetailShell>
        <ClampBox maxH={240}>
          <div className="text-[13px] leading-[1.7] whitespace-pre-wrap">{item.text}</div>
        </ClampBox>
      </DetailShell>
    )
  }
  const args = Object.entries(item.args ?? {})
  const name = item.name
  const isFetch = name === 'grep_result' || name === 'read_result' || name === 'fetch_tool_result'
  const r = item.result as
    | string
    | SearchToolResult
    | { error?: string; denied?: string; interrupted?: string }
    | undefined
  const text = typeof r === 'string' ? r : ''

  // 检索：命中的文档列表，点一条进侧板看原文
  if (name === 'search_knowledge_base') {
    const sr = r as SearchToolResult | undefined
    const hits = sr?.results ?? []
    const uniq = [...new Map(hits.map((x) => [x.file, x])).values()]
    const poolFor = (file: string): SourceRef[] =>
      (sourcePool ?? []).filter((s) => s.filePath === file)
    return (
      <DetailShell>
        <SectionLabel>检索词</SectionLabel>
        <div className="mb-2 text-[13px]">{String((item.args as { query?: string }).query ?? '')}</div>
        <Divider />
        <SectionLabel>命中</SectionLabel>
        <div className="flex flex-col gap-1">
          {uniq.map((x, i) => (
            <button
              key={i}
              disabled={!poolFor(x.file).length}
              onClick={(e) => {
                e.stopPropagation()
                const pool = poolFor(x.file)
                if (pool.length) onOpenSource?.(x.file, pool)
              }}
              className="-mx-1 flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] transition-colors enabled:hover:bg-black/5"
            >
              <FileText className="size-3.5 flex-none text-muted-foreground/50" />
              <span className="min-w-0 truncate">
                {x.file.replace(/\.md$/, '')}
                {x.heading ? ' › ' + x.heading : ''}
              </span>
            </button>
          ))}
        </div>
      </DetailShell>
    )
  }

  // 编辑文件：路径 + 按行比对
  if (name === 'edit_file') {
    const a = item.args as { path?: string; old_string?: string; new_string?: string }
    return (
      <DetailShell>
        <KvRows entries={[['path', a.path ?? '']]} />
        <Divider />
        <ClampBox maxH={240}>
          <DiffView oldStr={String(a.old_string ?? '')} newStr={String(a.new_string ?? '')} />
        </ClampBox>
      </DetailShell>
    )
  }

  // 询问用户：逐题问答
  if (item.ask) {
    const rows = item.ask.answers
      ? item.ask.answers.map((a) => [a.question, a.answer ?? '未回答'] as const)
      : (
          ((item.args as { questions?: { question: string }[] }).questions ?? []).map(
            (q) => [q.question, '—'] as const
          )
        )
    return (
      <DetailShell>
        <div className="flex flex-col gap-1.5">
          {rows.map(([q, a], i) => (
            <div key={i} className="text-[13px]">
              <div className="text-muted-foreground">{q}</div>
              <div>{a}</div>
            </div>
          ))}
        </div>
      </DetailShell>
    )
  }

  // 失败 / 中断：结果区显示给用户的说明，附给模型的原文（排障可读）
  const failText =
    typeof r === 'object' && r && !('results' in r)
      ? ((r as { error?: string; interrupted?: string; denied?: string }).error ??
        (r as { interrupted?: string }).interrupted ??
        (r as { denied?: string }).denied)
      : undefined

  const mono =
    name === 'read_file' ||
    name === 'list_dir' ||
    name === 'write_file' ||
    isFetch ||
    (!!text && text.trimStart().startsWith('{'))

  const resultBody = (): ReactNode => {
    if (failText)
      return <div className="text-[13px] leading-[1.7] whitespace-pre-wrap">{failText}</div>
    let body = text
    if (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      try {
        body = JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        body = text
      }
    }
    return (
      <div
        className={cn(
          'text-[13px] leading-[1.7] whitespace-pre-wrap break-all',
          mono && 'font-mono text-[12px]'
        )}
      >
        {body}
      </div>
    )
  }

  return (
    <DetailShell>
      {args.length > 0 && (
        <>
          <SectionLabel>参数</SectionLabel>
          <ClampBox maxH={200}>
            <KvRows entries={args} toolName={name} translate={isFetch} />
          </ClampBox>
          <Divider />
        </>
      )}
      <SectionLabel>结果</SectionLabel>
      <ClampBox maxH={240}>{resultBody()}</ClampBox>
    </DetailShell>
  )
}

function DetailShell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="mt-1.5 mb-1 ml-6 rounded-lg bg-muted/40 px-3 py-2.5 select-text">{children}</div>
  )
}
function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">{children}</div>
}
function Divider(): React.JSX.Element {
  return <div className="my-2 border-t border-border/70" />
}

// ── 单条调用行（Case 5）：图标、动词、描述三段一行，点整行展开详情 ──
export function CallRow({
  item,
  running,
  connectDown,
  sourcePool,
  onOpenSource
}: {
  item: CallItem
  running: boolean // 这一行是否处于进行中（末位判定由父级传入）
  connectDown: boolean // 与下一行之间画竖线（Case 5 功能点 7）
  sourcePool?: SourceRef[]
  onOpenSource?: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const face = faceOf(item, running)
  // 制品生成成功不出行（换制品卡，Case 9）——父级已过滤，这里只处理进行中与失败
  const expandable =
    !face.running &&
    !(item.t === 'tool' && (item.auth === 'denied' || item.auth === 'unanswered')) &&
    !(item.t === 'tool' && item.name === 'create_artifact' && !item.userText)
  const pulse = face.running
  return (
    <div className="flex gap-2.5">
      {/* 图标列：竖线从图标下方延伸到下一行图标（相邻行连接） */}
      <div className="flex w-[14px] flex-none flex-col items-center">
        <face.icon
          className={cn('mt-[5px] size-3.5 flex-none', pulse ? 'text-primary' : 'text-muted-foreground/70')}
        />
        {connectDown && <div className="mt-1 w-px flex-1 bg-border" />}
      </div>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => expandable && setOpen((o) => !o)}
          className={cn(
            '-ml-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left',
            expandable && 'transition-colors hover:bg-muted',
            pulse && 'text-shimmer'
          )}
        >
          <span
            className={cn(
              'flex-none text-[14px] font-medium',
              face.failed ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {face.verb}
          </span>
          {face.desc && (
            <span
              className="min-w-0 truncate text-[14px] text-muted-foreground"
              title={face.descFull && face.descFull !== face.desc ? face.descFull : undefined}
            >
              {face.desc}
            </span>
          )}
          {expandable && (
            <ChevronRight
              className={cn(
                'size-3.5 flex-none text-muted-foreground/50 transition-transform',
                open && 'rotate-90'
              )}
            />
          )}
        </button>
        {open && expandable && (
          <CallDetail item={item} sourcePool={sourcePool} onOpenSource={onOpenSource} />
        )}
      </div>
    </div>
  )
}

// ── 消息块分段：连续的调用行（思考 + 工具）收成一组，正文与制品卡把组切开 ──
export type Segment =
  | { kind: 'calls'; items: CallItem[]; indices: number[]; base: number }
  | { kind: 'other'; item: TurnItem; idx: number }

export function segmentItems(items: TurnItem[]): Segment[] {
  const segs: Segment[] = []
  let cur: { kind: 'calls'; items: CallItem[]; indices: number[]; base: number } | null = null
  items.forEach((it, i) => {
    // 技能激活的重复激活提示不出行（015 验收定）：返回是字符串但不是技能正文
    const skipSkill =
      it.t === 'tool' &&
      it.name === 'activate_skill' &&
      typeof it.result === 'string' &&
      !it.result.startsWith('【技能：')
    const isCall = (it.t === 'reasoning' && !!it.text.trim()) || (it.t === 'tool' && !skipSkill)
    if (isCall) {
      if (!cur) {
        cur = { kind: 'calls', items: [], indices: [], base: i }
        segs.push(cur)
      }
      cur.items.push(it as CallItem)
      cur.indices.push(i)
      return
    }
    cur = null
    if (it.t === 'reasoning' || it.t === 'sources') return // 空思考不占行；来源在页脚统一渲染
    if (it.t === 'text' && !it.text.trim()) return
    if (skipSkill) return
    segs.push({ kind: 'other', item: it, idx: i })
  })
  return segs
}

// ── 一组连续调用行（Case 6 Feature 3）：最终回答完成后折成「执行 N 个步骤 ›」──
export function CallGroup({
  items,
  baseIndex,
  streaming,
  collapsed: collapsible,
  lastRunningIdx,
  sourcePool,
  onOpenSource,
  children
}: {
  items: CallItem[]
  baseIndex: number // 组内第一个 item 在整条消息里的下标（key 稳定用）
  streaming: boolean
  collapsed: boolean // 满足折叠条件（正常答完且组内不止一行）
  lastRunningIdx: number // 整条消息里处于进行中的 item 下标（-1 = 无）
  sourcePool?: SourceRef[]
  onOpenSource?: (file: string, sources: SourceRef[]) => void
  children?: ReactNode // 挂在组末尾的内容（授权卡，Case 7）
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const anyFailed = items.some(
    (it) =>
      it.t === 'tool' &&
      typeof it.result === 'object' &&
      !!(it.result as { error?: string })?.error
  )
  if (collapsible && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className={cn(
          '-ml-1 flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-[14px] transition-colors hover:bg-muted',
          anyFailed ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        执行 {items.length} 个步骤
        <ChevronRight className="size-3.5" />
      </button>
    )
  }
  return (
    <div className="flex flex-col">
      {collapsible && (
        <button
          onClick={() => setExpanded(false)}
          className={cn(
            '-ml-1 mb-1 flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 text-[14px] transition-colors hover:bg-muted',
            anyFailed ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          执行 {items.length} 个步骤
          <ChevronDown className="size-3.5" />
        </button>
      )}
      {items.map((it, i) => (
        <CallRow
          key={baseIndex + i}
          item={it}
          running={streaming && baseIndex + i === lastRunningIdx}
          connectDown={i < items.length - 1}
          sourcePool={sourcePool}
          onOpenSource={onOpenSource}
        />
      ))}
      {children}
    </div>
  )
}
