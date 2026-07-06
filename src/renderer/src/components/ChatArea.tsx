import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  PanelLeft,
  ChevronRight,
  RotateCw,
  AlertCircle,
  ArrowDown,
  Copy,
  Check,
  Info,
  Sparkles,
  FileText
} from 'lucide-react'
import { cn, stripCitations } from '@/lib/utils'
import type { Msg } from '@/hooks/useChat'
import type { SourceRef, TurnItem, SearchToolResult } from '../../../preload/index.d'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { Markdown } from './Markdown'
import Composer, { type KbState } from './Composer'

// 规则 5：单条消息上限（字符），发送前就地拦下；与主进程常量同值（engine/budget SEND_CHAR_LIMIT）
const SEND_CHAR_LIMIT = 30000

interface Props {
  title: string
  convId: string
  collapsed: boolean
  onExpand: () => void
  messages: Msg[]
  sending: boolean
  contextRatio: number
  input: string
  onInput: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  onRetry: () => void
  onRename: (title: string) => void
  model: string
  models: string[]
  onPickModel: (m: string) => void
  kbState: KbState
  kbName: string
  kbSelected: boolean
  kbLocked: boolean
  onToggleKb: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
}

export default function ChatArea({
  title,
  convId,
  collapsed,
  onExpand,
  messages,
  sending,
  contextRatio,
  input,
  onInput,
  onSubmit,
  onStop,
  onRetry,
  onRename,
  model,
  models,
  onPickModel,
  kbState,
  kbName,
  kbSelected,
  kbLocked,
  onToggleKb,
  onOpenSource
}: Props): React.JSX.Element {
  const empty = messages.length === 0
  const { scrollRef, onScroll, showJump, scrollToBottom } = useStickToBottom(messages, convId)
  const overLimit = input.length > SEND_CHAR_LIMIT
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id

  return (
    <div className="flex h-full min-w-[480px] flex-1 flex-col overflow-hidden rounded-[12px] border border-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.07)]">
      <header
        className={cn(
          'app-drag flex h-[44px] flex-none items-center gap-1',
          collapsed ? 'pr-4 pl-[72px]' : 'px-4'
        )}
      >
        {collapsed && (
          <button
            onClick={onExpand}
            title="展开侧栏  ⌘."
            className="app-no-drag grid size-8 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
          >
            <PanelLeft className="size-[18px]" />
          </button>
        )}
        <TitleBar title={title} onRename={onRename} />
      </header>

      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
          {empty ? (
            <EmptyState />
          ) : (
            <div className="mx-auto w-full max-w-[800px] px-8 pt-3 pb-10">
              <div className="flex flex-col gap-8">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <UserMsg key={m.id}>{m.content}</UserMsg>
                  ) : (
                    <AssistantMsg
                      key={m.id}
                      m={m}
                      isLast={m.id === lastAssistantId}
                      onRetry={onRetry}
                      onOpenSource={onOpenSource}
                    />
                  )
                )}
              </div>
            </div>
          )}
        </div>
        {showJump && (
          <button
            onClick={scrollToBottom}
            title="回到底部"
            className="absolute bottom-3 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:text-foreground"
          >
            <ArrowDown className="size-[18px]" />
          </button>
        )}
      </div>

      {/* 输入框上方轻提示：过长消息就地拦下；对话较长建议新开（均不阻断界面其他操作） */}
      {(overLimit || contextRatio > 0.7) && (
        <div className="mx-auto w-full max-w-[800px] px-8 pb-1">
          {overLimit ? (
            <div className="text-[12px] text-destructive">
              消息过长，请精简或拆分（当前 {input.length.toLocaleString()} 字，上限{' '}
              {SEND_CHAR_LIMIT.toLocaleString()} 字）
            </div>
          ) : (
            <div className="text-[12px] text-muted-foreground">对话较长，建议新开会话</div>
          )}
        </div>
      )}
      <Composer
        model={model}
        models={models}
        onPickModel={onPickModel}
        sending={sending}
        value={input}
        onChange={onInput}
        onSubmit={() => {
          if (!overLimit) onSubmit()
        }}
        onStop={onStop}
        kbState={kbState}
        kbName={kbName}
        kbSelected={kbSelected}
        kbLocked={kbLocked}
        onToggleKb={onToggleKb}
      />
    </div>
  )
}

function TitleBar({
  title,
  onRename
}: {
  title: string
  onRename: (t: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const commit = (): void => {
    const t = draft.trim()
    if (t && t !== title) onRename(t)
    setEditing(false)
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
        className="app-no-drag min-w-0 flex-1 rounded-md border border-ring bg-background px-1.5 py-0.5 text-[15px] font-semibold text-foreground outline-none"
      />
    )
  }
  return (
    <button
      onClick={() => {
        setDraft(title)
        setEditing(true)
      }}
      title="点击重命名"
      className="app-no-drag -mx-1.5 max-w-full truncate rounded-md px-1.5 py-0.5 text-[15px] font-semibold text-foreground transition-colors hover:bg-muted"
    >
      {title}
    </button>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-primary-soft">
        <span className="size-3 rounded-full bg-primary" />
      </div>
      <div className="text-[16px] font-semibold">开始一段新对话</div>
      <div className="text-[13px] text-muted-foreground">在下方输入问题，Chime 会基于当前模型作答</div>
    </div>
  )
}

function UserMsg({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%] rounded-[18px] bg-[#f0f0ee] px-4 py-2.5 text-[16px] leading-[1.7] whitespace-pre-wrap text-foreground select-text">
        {children}
      </div>
    </div>
  )
}

// 整轮进度指示：轻趣味中文词表轮播（多数中性、偶穿轻俏词），几秒一换
const PROGRESS_WORDS = ['梳理中', '翻查中', '琢磨中', '核对中', '斟酌中', '串联中', '查证中', '整理中', '推敲中', '落笔中']

function ProgressIndicator(): React.JSX.Element {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * PROGRESS_WORDS.length))
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setSecs((s) => {
        if (s % 3 === 2) setIdx((i) => (i + 1) % PROGRESS_WORDS.length)
        return s + 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="mt-1 flex items-center gap-2.5 text-[14px]">
      <span className="size-4 flex-none animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="text-shimmer font-medium">{PROGRESS_WORDS[idx]}…</span>
      {secs > 0 && <span className="text-[12px] text-muted-foreground">{secs}s</span>}
    </div>
  )
}

// ── 对话流：按 items 渲染，每个元素圆点起头，折叠只发生在单步内部 ──────────────

function AssistantMsg({
  m,
  isLast,
  onRetry,
  onOpenSource
}: {
  m: Msg
  isLast: boolean
  onRetry: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  const streaming = m.status === 'streaming'
  const finished = m.status === 'done' || m.status === 'stopped'
  const items = m.items ?? []

  // 位置即语义：末位非空 text 为最终回答，之前的 text 为意图叙述
  const lastTextIdx = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.t === 'text' && it.text.trim()) return i
    }
    return -1
  }, [items])
  const answer = lastTextIdx >= 0 ? (items[lastTextIdx] as { text: string }).text : ''
  const sources = items.find((i): i is Extract<TurnItem, { t: 'sources' }> => i.t === 'sources')

  const hasBody = items.some((i) => (i.t === 'text' || i.t === 'reasoning') && i.text.trim())
  // 一开始就失败、没有任何内容 → 单独一张错误卡片
  if (m.status === 'error' && !hasBody) {
    return <ErrorCard text={m.error ?? '请求中断，请重试'} onRetry={isLast ? onRetry : undefined} />
  }

  return (
    <div className="flex flex-col gap-2 text-foreground select-text">
      {m.notice && <NoticeRow text={m.notice} />}
      {items.map((it, i) => {
        if ((it.t === 'text' || it.t === 'reasoning') && !it.text.trim()) return null
        switch (it.t) {
          case 'reasoning':
            return <ThinkRow key={i} text={it.text} running={streaming && i === items.length - 1} />
          case 'text':
            return i === lastTextIdx ? (
              <AnswerRow key={i} text={it.text} streaming={streaming} />
            ) : (
              <IntentRow key={i} text={it.text} />
            )
          case 'tool':
            return <ToolRow key={i} item={it} />
          case 'boundary':
            return it.kind === 'limit' ? (
              <PlainRow key={i} text="已达工具调用上限，基于已有结果作答" />
            ) : null // error 边界由下方错误卡片呈现
          default:
            return null // sources 在回答之后统一渲染
        }
      })}
      {/* 整轮进度指示：挂在当前助手消息末尾，紧随已有内容——无内容时就贴着用户消息，不留空隙 */}
      {streaming && <ProgressIndicator />}
      {m.status === 'stopped' && <PlainRow text="已停止" />}
      {!streaming && sources && sources.list.length > 0 && (
        <SourcesFooter list={sources.list} onOpen={onOpenSource} />
      )}
      {finished && answer && (
        <MessageActions
          content={stripCitations(answer, false)}
          onRetry={isLast ? onRetry : undefined}
        />
      )}
      {m.status === 'error' && hasBody && (
        <ErrorCard text={m.error ?? '请求中断，请重试'} onRetry={isLast ? onRetry : undefined} />
      )}
    </div>
  )
}

// 过程层统一尺度：14px、弱化色；类型区分只靠行首标记，不靠字号变化
const PROCESS_ROW = 'text-[14px] leading-[1.7] text-muted-foreground'

// 元素行首的圆点。tone：单步状态点三态 + 中性缺省（对齐 14px 首行光学中心）
function Dot({ tone = 'neutral' }: { tone?: 'neutral' | 'running' | 'error' }): React.JSX.Element {
  return (
    <span
      className={cn(
        'mt-[8px] size-[6px] flex-none rounded-full',
        tone === 'running' && 'animate-pulse bg-primary',
        tone === 'neutral' && 'bg-foreground/25',
        tone === 'error' && 'bg-destructive'
      )}
    />
  )
}

// 意图叙述：常显短句，不折叠
function IntentRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <Dot />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>{text}</div>
    </div>
  )
}

// 固定文案的普通行（边界与停止事件：设计内的正常收场，不用警告色）
function PlainRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex gap-2.5">
      <Dot />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>{text}</div>
    </div>
  )
}

function NoticeRow({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Info className="size-3.5 flex-none" />
      <span>{text}</span>
    </div>
  )
}

// 思考：星形图标 + 标签同处一个居中的行（图标与文字水平对齐），内容默认折叠。
// 展开内容挂左侧竖线成「归属块」，与主流程分开（与检索命中列表同一处理）。
function ThinkRow({ text, running }: { text: string; running: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          '-ml-1 flex w-fit items-center gap-2.5 rounded-md px-1 py-0.5 transition-colors hover:bg-muted',
          PROCESS_ROW
        )}
      >
        <Sparkles
          className={cn(
            'size-3.5 flex-none',
            running ? 'animate-pulse text-primary' : 'text-muted-foreground/50'
          )}
        />
        <span>{running ? '思考中' : '思考'}</span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        // 方框归属块（参照来源框），缩进到标签之下体现父子层级
        <div className="mt-1.5 ml-6 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <div className={cn('whitespace-pre-wrap', PROCESS_ROW)}>{text}</div>
        </div>
      )}
    </div>
  )
}

// 工具步骤成对两行：调用行（状态点三态）+ 缩进结果行（点击展开命中列表 / 错误说明）
function ToolRow({ item }: { item: Extract<TurnItem, { t: 'tool' }> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const r: SearchToolResult | undefined = item.result as SearchToolResult | undefined
  const running = r === undefined
  const failed = !!r?.error // 仅真故障算失败态（标红）；invalid 自愈不算
  const summary = running
    ? '检索中…'
    : r.results
      ? `${r.results.length} 条结果${r.truncated ? '（已截断）' : ''}`
      : r.denied
        ? '已达检索上限'
        : r.notice
          ? '知识库更新中'
          : r.invalid
            ? '未提供检索词'
            : '检索出错'
  const detail = r?.results?.length
    ? [...new Set(r.results.map((x) => `${x.file.replace(/\.md$/, '')}${x.heading ? ' › ' + x.heading : ''}`))]
    : r?.error
      ? [r.error]
      : r?.denied
        ? [r.denied]
        : r?.notice
          ? [r.notice]
          : []
  return (
    <div className="flex gap-2.5">
      <Dot tone={running ? 'running' : failed ? 'error' : 'neutral'} />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>
        {/* 调用行：检索词用等宽字体，读作「一次机器动作」——与文字叙述区分，但字号一致 */}
        <div>
          检索(
          <span className="font-mono text-[13px] text-muted-foreground">
            &quot;{item.args.query ?? ''}&quot;
          </span>
          )
        </div>
        <button
          onClick={() => detail.length && setOpen((o) => !o)}
          className={cn(
            '-ml-1 flex items-center gap-2 rounded-md px-1 py-0.5',
            detail.length && 'transition-colors hover:bg-muted'
          )}
        >
          <span className={cn('text-muted-foreground/50', failed && 'text-destructive/60')}>⎿</span>
          {/* 真故障标红，对齐 Claude Code 工具失败的视觉 */}
          <span className={cn(failed && 'font-medium text-destructive')}>{summary}</span>
          {detail.length > 0 && (
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          )}
        </button>
        {open && (
          // 「-」无序列表，缩进到结果行文字之下体现父子；不用竖线
          <div className="mt-1 ml-5 flex flex-col gap-0.5">
            {detail.map((d, i) => (
              <div key={i} className="flex gap-1.5">
                <span className="flex-none text-muted-foreground/50">-</span>
                <span className="min-w-0">{d}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// 最终回答：正文直接起排、不带行首标记（回答是交付主体，与带标记的过程行分层，
// 也避免与正文里的无序列表圆点混淆）；隐去 [n] 角标（引用关系保留，供来源清单与侧板）。
// token 到达即渲染，不做逐字平滑——平滑的帧节奏与贴底节奏不同步，是滚动抖动的根源。
function AnswerRow({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const content = useMemo(() => stripCitations(text, streaming), [text, streaming])
  return (
    <div className="pt-1">
      <Markdown text={content} />
    </div>
  )
}

// 来源清单：按文章（文件）去重，只列实际引用；点击进侧板定位高亮
function SourcesFooter({
  list,
  onOpen
}: {
  list: SourceRef[]
  onOpen: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  const articles = useMemo(() => {
    const byFile = new Map<string, { file: string; sources: SourceRef[] }>()
    for (const s of list) {
      let art = byFile.get(s.filePath)
      if (!art) {
        art = { file: s.filePath, sources: [] }
        byFile.set(s.filePath, art)
      }
      art.sources.push(s)
    }
    return [...byFile.values()]
  }, [list])
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 mt-2 duration-500">
      <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">来源</div>
      {/* 带框的一列来源：每条显示完整相对路径，整行可点、悬停高亮；超宽尾部省略、悬停看全路径 */}
      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
        {articles.map((a) => (
          <button
            key={a.file}
            onClick={() => onOpen(a.file, a.sources)}
            title={a.file}
            className="group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted"
          >
            <FileText className="size-3.5 flex-none text-muted-foreground" />
            <span className="truncate text-[12px] text-muted-foreground group-hover:text-foreground">
              {a.file.replace(/\.md$/, '')}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageActions({
  content,
  onRetry
}: {
  content: string
  onRetry?: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="-ml-1.5 flex items-center gap-0.5">
      {content && (
        <ActionBtn title={copied ? '已复制' : '复制'} onClick={copy}>
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </ActionBtn>
      )}
      {onRetry && (
        <ActionBtn title="重新生成" onClick={onRetry}>
          <RotateCw className="size-4" />
        </ActionBtn>
      )}
    </div>
  )
}

function ActionBtn({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

function ErrorCard({
  text,
  onRetry,
  className
}: {
  text: string
  onRetry?: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border border-l-[3px] border-destructive/25 border-l-destructive bg-destructive/[0.04] px-3.5 py-2.5',
        className
      )}
    >
      <AlertCircle className="size-[18px] flex-none text-destructive" />
      <span className="flex-1 text-[13px] text-foreground">{text}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="flex flex-none items-center gap-1.5 rounded-md border border-destructive/30 px-2.5 py-1 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <RotateCw className="size-3.5" />
          重试
        </button>
      )}
    </div>
  )
}
