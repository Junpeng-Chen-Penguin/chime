import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  PanelLeft,
  ChevronRight,
  RotateCw,
  AlertCircle,
  ArrowDown,
  ArrowRight,
  CornerDownLeft,
  Copy,
  Check,
  Info,
  Sparkles,
  FileText,
  Table,
  X
} from 'lucide-react'
import { cn, stripCitations } from '@/lib/utils'
import type { Msg } from '@/hooks/useChat'
import type { SourceRef, TurnItem, SearchToolResult, AskOutcomePayload, AskQuestionSpec } from '../../../preload/index.d'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { Markdown } from './Markdown'
import Composer, { type KbOption, type KbSelEntry, type ServiceStatus } from './Composer'

// 规则 5：单条消息上限（字符），发送前就地拦下；与主进程常量同值（engine/budget SEND_CHAR_LIMIT）
const SEND_CHAR_LIMIT = 30000

interface Props {
  title: string
  convId: string
  collapsed: boolean
  fullscreen: boolean
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
  kbOptions: KbOption[]
  kbSel: KbSelEntry[]
  kbLocked: boolean
  onToggleKb: (id: number, name: string) => void
  services: ServiceStatus[]
  selectedServiceIds: number[]
  onToggleService: (id: number) => void
  onRetryServices: () => void
  onOpenSettings: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
  onRespondCard: (toolCallId: string, decision: 'approved' | 'denied') => void
  onRespondAsk: (toolCallId: string, outcome: AskOutcomePayload) => void
  onOpenArtifact: (id: number) => void
}

export default function ChatArea({
  title,
  convId,
  collapsed,
  fullscreen,
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
  kbOptions,
  kbSel,
  kbLocked,
  onToggleKb,
  services,
  selectedServiceIds,
  onToggleService,
  onRetryServices,
  onOpenSettings,
  onOpenSource,
  onRespondCard,
  onRespondAsk,
  onOpenArtifact
}: Props): React.JSX.Element {
  const empty = messages.length === 0
  const { scrollRef, onScroll, showJump, scrollToBottom } = useStickToBottom(messages, convId)
  const overLimit = input.length > SEND_CHAR_LIMIT
  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id
  // 队首待回应的卡决定输入框状态：授权卡→禁用（只能操作卡片或点停止）；提问卡→开放，打字即整体回答
  const lastMsg = messages[messages.length - 1]
  const activeCard = sending
    ? (lastMsg?.items ?? []).find(
        (it): it is Extract<TurnItem, { t: 'tool' }> =>
          it.t === 'tool' && (it.auth === 'pending' || it.ask?.state === 'pending')
      )
    : undefined
  const authWaiting = activeCard?.auth === 'pending'
  const askItem = activeCard?.ask?.state === 'pending' ? activeCard : undefined

  // 会话累计用量：各正常轮次之和（中断轮无 usage 自然不计入）
  const sessionUsage = useMemo(() => {
    let input = 0
    let output = 0
    let cached = 0
    let any = false
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.usage) continue
      any = true
      input += m.usage.input
      output += m.usage.output
      cached += m.usage.cached
    }
    return any ? { input, output, cached } : null
  }, [messages])

  const composer = (
    <Composer
      model={model}
      models={models}
      onPickModel={onPickModel}
      sending={sending}
      inputDisabled={authWaiting}
      askWaiting={!!askItem}
      value={input}
      onChange={onInput}
      onSubmit={() => {
        if (!overLimit) onSubmit()
      }}
      onStop={onStop}
      sessionUsage={sessionUsage}
      kbOptions={kbOptions}
      kbSel={kbSel}
      kbLocked={kbLocked}
      onToggleKb={onToggleKb}
      services={services}
      selectedServiceIds={selectedServiceIds}
      onToggleService={onToggleService}
      onRetryServices={onRetryServices}
      onOpenSettings={onOpenSettings}
    />
  )

  return (
    <div className="flex h-full min-w-[480px] flex-1 flex-col overflow-hidden rounded-[12px] border border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.03),0_2px_8px_rgba(0,0,0,0.05)]">
      <header
        className={cn(
          'app-drag flex h-[44px] flex-none items-center gap-1',
          // 收起时为红绿灯留空；但全屏时红绿灯隐藏，回到常规内边距
          collapsed && !fullscreen ? 'pr-4 pl-[72px]' : 'px-4'
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

      {empty ? (
        // 空态 onboarding：wordmark + tagline + 居中输入框（最简，无起手提示）
        <div className="flex flex-1 flex-col items-center justify-center pb-16">
          {/* 仅一句 tagline，左对齐输入框左边缘，常规字重 */}
          <div className="mx-auto mb-3 w-full max-w-[840px] px-8">
            <div className="text-[24px] text-foreground">Chime with your work!</div>
          </div>
          <div className="w-full">{composer}</div>
        </div>
      ) : (
        <>
          <div className="relative flex-1 overflow-hidden">
            <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-[760px] px-8 pt-3 pb-10">
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
                        onRespondCard={onRespondCard}
                        onOpenArtifact={onOpenArtifact}
                      />
                    )
                  )}
                </div>
              </div>
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

          {/* 提问卡：悬浮于输入框上方，不占对话流位置（key 随卡切换重置内部作答状态） */}
          {askItem?.id && <AskCard key={askItem.id} item={askItem} onRespond={onRespondAsk} />}

          {/* 输入框上方轻提示：过长消息就地拦下；压力高（L2，90%）才建议新开——
              70%~90% 由引擎清老工具返回静默缓解，无需打扰用户 */}
          {(overLimit || contextRatio > 0.9) && (
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
          {composer}
        </>
      )}
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
  onOpenSource,
  onRespondCard,
  onOpenArtifact
}: {
  m: Msg
  isLast: boolean
  onRetry: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
  onRespondCard: (toolCallId: string, decision: 'approved' | 'denied') => void
  onOpenArtifact: (id: number) => void
}): React.JSX.Element {
  const streaming = m.status === 'streaming'
  const finished = m.status === 'done' || m.status === 'stopped' || m.status === 'interrupted'
  const items = m.items ?? []
  // 卡片排队（授权 + 提问共用一条队列）：队首是授权卡时挂在调用行下方；队首是提问卡时悬浮于输入框上方（由 ChatArea 渲染）
  const pendingIdx = streaming
    ? items.findIndex((it) => it.t === 'tool' && (it.auth === 'pending' || it.ask?.state === 'pending'))
    : -1
  const pendingIsAuth = pendingIdx >= 0 && (items[pendingIdx] as Extract<TurnItem, { t: 'tool' }>).auth === 'pending'

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
    // 回复右侧留出缩进，右边缘不顶齐用户气泡右边（参照 Claude）
    <div className="flex flex-col gap-2 pr-10 text-foreground select-text">
      {m.notice && <NoticeRow text={m.notice} />}
      {items.map((it, i) => {
        if ((it.t === 'text' || it.t === 'reasoning') && !it.text.trim()) return null
        switch (it.t) {
          case 'reasoning':
            return <ThinkRow key={i} text={it.text} running={streaming && i === items.length - 1} />
          case 'text':
            // 模型的话一律正文样式（Markdown），不因后续步骤回溯降级——中途回复也是给用户看的内容，
            // 过程行样式只留给工具步骤与状态标记（对齐 Claude：文本与工具行交替、样式稳定）
            return <AnswerRow key={i} text={it.text} streaming={streaming && i === items.length - 1} />
          case 'tool':
            return (
              <div key={i} className="flex flex-col gap-2">
                <ToolRow item={it} active={i === pendingIdx} />
                {i === pendingIdx && pendingIsAuth && (
                  <AuthCard item={it} onRespond={onRespondCard} />
                )}
              </div>
            )
          case 'artifact':
            // 制品卡：Chime 渲染，卡本身就是这次调用的展示（成果即过程）。
            // 可点性靠样式表达（悬停浮起 + 右侧箭头），不写操作说明文案
            return (
              <button
                key={i}
                onClick={() => onOpenArtifact(it.id)}
                className="group flex w-full max-w-[440px] items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-ring/50 hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              >
                <span className="grid size-9 flex-none place-items-center rounded-lg bg-primary/10">
                  <Table className="size-[18px] text-primary" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-foreground">{it.title}</span>
                  {/* 类型由图标表达，文字只补图标说不了的信息（规模） */}
                  <span className="block text-[12px] text-muted-foreground">{it.rowCount} 行</span>
                </span>
                <ChevronRight className="size-4 flex-none text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
              </button>
            )
          case 'boundary':
            return it.kind === 'limit' ? (
              <PlainRow key={i} text="已达工具调用上限，基于已有结果作答" />
            ) : null // error 边界由下方错误卡片呈现
          default:
            return null // sources 在回答之后统一渲染
        }
      })}
      {/* 整轮进度指示：挂在当前助手消息末尾，紧随已有内容——无内容时就贴着用户消息，不留空隙。
          等待授权期间没有请求在跑，不显示进度指示 */}
      {streaming && pendingIdx < 0 && <ProgressIndicator />}
      {/* 停止是用户主动收场：说清是谁停的（区别于故障），并顺带指路（参照 Claude Code 的 Interrupted 标记） */}
      {m.status === 'stopped' && <PlainRow text="你停止了这次回答，需要继续可以直接说" />}
      {/* 应用退出打断（启动修复后收场）：与用户主动停止分开交代 */}
      {m.status === 'interrupted' && <PlainRow text="本轮在应用退出时被中断" />}
      {!streaming && sources && sources.list.length > 0 && (
        <SourcesFooter list={sources.list} onOpen={onOpenSource} />
      )}
      {/* 无正文的收场（如刚开始就停止）末轮也给重试入口；复制按钮由 MessageActions 按内容有无自行隐藏 */}
      {finished && (answer || isLast) && (
        <MessageActions
          content={answer ? stripCitations(answer, false) : ''}
          onRetry={isLast ? onRetry : undefined}
          usage={m.status === 'done' ? m.usage : undefined}
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

// 元素行首的圆点。tone：单步状态点 + 中性缺省（对齐 14px 首行光学中心）；queued = 空心（排队中）
function Dot({ tone = 'neutral' }: { tone?: 'neutral' | 'running' | 'error' | 'queued' }): React.JSX.Element {
  return (
    <span
      className={cn(
        'mt-[8px] size-[6px] flex-none rounded-full',
        tone === 'running' && 'animate-pulse bg-primary',
        tone === 'neutral' && 'bg-muted-foreground/50',
        tone === 'error' && 'bg-destructive',
        tone === 'queued' && 'border border-muted-foreground/50 bg-transparent'
      )}
    />
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

// 工具步骤成对两行（统一框架）：调用行（状态点）+ 缩进结果行（点开详情）。
// 差异只在摘要文案与详情内容：检索为命中列表，通用工具（MCP 等）为参数 + 结果。
function ToolRow({
  item,
  active
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  active: boolean // 当前弹卡行（卡片排队中一次只有一行活跃）
}): React.JSX.Element {
  if (item.ask) return <AskToolRow item={item} active={active} />
  return item.name === 'search_knowledge_base' ? (
    <SearchToolRow item={item} />
  ) : (
    <GenericToolRow item={item} active={active} />
  )
}

// 提问步骤的时间线记录：等待中一行状态，收场后三态（已回答 / 已跳过 / 未回应），点开看每题问答
function AskToolRow({
  item,
  active
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  active: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ask = item.ask!
  const questions = ((item.args as { questions?: AskQuestionSpec[] }).questions ?? []).map((q) => q.question)
  const waiting = ask.state === 'pending'
  const summary = waiting
    ? active
      ? '等待回答'
      : '排队中'
    : ask.state === 'answered'
      ? '已回答'
      : ask.state === 'skipped'
        ? '已跳过'
        : '未回应'
  // 详情：逐题问答；跳过/未回应只列问题
  const detail: string[] = ask.answers
    ? ask.answers.map((a) => `${a.question} → ${a.answer ?? '未回答'}`)
    : questions
  return (
    <div className="flex gap-2.5">
      <Dot tone={waiting && active ? 'running' : waiting ? 'queued' : 'neutral'} />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>
        <div className="truncate">
          {item.display ?? '询问用户'}（{questions.length} 个问题）
        </div>
        <button
          onClick={() => !waiting && detail.length > 0 && setOpen((o) => !o)}
          className={cn(
            '-ml-1 flex items-center gap-2 rounded-md px-1 py-0.5',
            !waiting && detail.length > 0 && 'transition-colors hover:bg-muted'
          )}
        >
          <span className="text-muted-foreground/50">⎿</span>
          <span>{summary}</span>
          {!waiting && detail.length > 0 && (
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          )}
        </button>
        {open && !waiting && (
          <div className="mt-1 ml-5 flex flex-col gap-1">
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

// 「查结果集」参数翻译成人话（原始键值是研发口径，用户看不懂）
// 取数工具参数的人话标签与取值（grep_result / read_result；带 mode/startLine/start 等键的是历史会话旧形态）
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
  if (k === 'mode') return v === 'search' ? '按关键词搜索' : v === 'read' ? '按行读取' : '按位置读取'
  if (k === 'resultId') return `#${v}`
  if (k === 'offset') return name === 'read_result' ? `第 ${Number(v).toLocaleString()} 行起` : `跳过前 ${Number(v)} 行`
  if (k === 'startLine') return `第 ${Number(v).toLocaleString()} 行起`
  if (k === 'lines' || k === 'limit' || k === 'head_limit') return `${Number(v).toLocaleString()} 行`
  if (k === 'context') return `前后 ${Number(v)} 行`
  if (k === '-i') return v ? '忽略' : '区分'
  if (k === 'fromHit') return `跳过前 ${Number(v)} 处命中`
  if (k === 'start') return `第 ${Number(v).toLocaleString()} 字起`
  if (k === 'length') return `${Number(v).toLocaleString()} 字`
  return typeof v === 'string' ? v : JSON.stringify(v)
}

// 结果规模口径（与主进程摘要一致的读法）：千字 / 万字取整
function formatChars(n: number): string {
  if (n < 1000) return `${n} 字`
  if (n < 10000) return `约 ${Math.round(n / 1000)} 千字`
  return `约 ${Math.round(n / 10000)} 万字`
}

function GenericToolRow({
  item,
  active
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  active: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const r = item.result as string | { error?: string; denied?: string; interrupted?: string } | undefined
  const waiting = item.auth === 'pending' // 等待授权（active）或排队中
  const running = r === undefined && !waiting
  const failed = typeof r === 'object' && !!r?.error
  const interrupted = typeof r === 'object' && !!r?.interrupted
  const args = Object.entries(item.args ?? {})
  // fetch_tool_result 为退役工具名，仅历史会话的旧调用行
  const isFetch = item.name === 'fetch_tool_result' || item.name === 'grep_result' || item.name === 'read_result'
  // 调用行参数概要：取第一个参数值，如 计费系统:租户授权查询("A公司")；取数工具用人话概要
  const firstArg = args.length ? args[0][1] : undefined
  const argPreview = isFetch
    ? (() => {
        const a = item.args as {
          resultId?: number
          mode?: string
          pattern?: string
          keyword?: string
          startLine?: number
          offset?: number
        }
        if (item.name === 'grep_result') return `${a.resultId != null ? `#${a.resultId}` : '全部结果'} 搜"${a.pattern ?? ''}"`
        if (item.name === 'read_result') return `#${a.resultId} 读第 ${a.offset ?? 1} 行起`
        if (a.mode === 'search') return `#${a.resultId} 搜"${a.pattern ?? a.keyword ?? ''}"`
        if (a.startLine !== undefined || a.mode === 'read') return `#${a.resultId} 读第 ${a.startLine ?? 1} 行起`
        return `#${a.resultId} 按位置读取` // 历史轮的旧参数形态
      })()
    : firstArg === undefined
      ? ''
      : JSON.stringify(firstArg)
  // 卡片收场折叠为记录：行首加授权去向（已授权 / 已拒绝 / 未回应）
  const prefix =
    item.auth === 'denied'
      ? '已拒绝：'
      : item.auth === 'unanswered'
        ? '未回应：'
        : item.auth === 'approved'
          ? '已授权：'
          : ''
  // 拒绝 / 未回应没有执行过程，单行记录即收场，不出结果行
  const noResultLine = item.auth === 'denied' || item.auth === 'unanswered'
  const summary = waiting
    ? active
      ? '等待授权'
      : '排队中'
    : running
      ? '调用中…'
      : failed
        ? '调用失败'
        : interrupted
          ? '已中断'
          : item.resultRef
            ? // 超限已存：显示真实规模（result 是摘要，长度不代表结果大小）
              `${(r as string).split('。')[0]}，超限已存（#${item.resultRef}）`
            : `返回${formatChars((r as string).length)}`
  const expandable = !waiting && !running
  // 结果详情：规整 JSON 自动格式化便于阅读
  const resultText = useMemo(() => {
    if (!r) return ''
    if (typeof r === 'object') return r.error ?? r.interrupted ?? ''
    try {
      return JSON.stringify(JSON.parse(r), null, 2)
    } catch {
      return r
    }
  }, [r])
  return (
    <div className="flex gap-2.5">
      <Dot tone={waiting && active ? 'running' : waiting ? 'queued' : running ? 'running' : failed ? 'error' : 'neutral'} />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>
        <div className="truncate">
          {prefix}
          {item.display ?? item.name}({argPreview})
        </div>
        {!noResultLine && (
          <button
            onClick={() => expandable && setOpen((o) => !o)}
            className={cn(
              '-ml-1 flex items-center gap-2 rounded-md px-1 py-0.5',
              expandable && 'transition-colors hover:bg-muted'
            )}
          >
            <span className={cn('text-muted-foreground/50', failed && 'text-destructive')}>⎿</span>
            <span className={cn(failed && 'font-medium text-destructive')}>{summary}</span>
            {expandable && <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />}
          </button>
        )}
        {open && expandable && (
          <div className="mt-1.5 ml-5 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            {args.length > 0 && (
              <>
                <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">参数</div>
                <div className="mb-2 flex flex-col gap-1">
                  {args.map(([k, v]) => (
                    <div key={k} className="flex gap-3 text-[13px]">
                      <span className="w-[120px] flex-none truncate text-muted-foreground">
                        {isFetch ? fetchArgLabel(item.name, k) : k}
                      </span>
                      <span className="min-w-0 break-all">
                        {isFetch ? fetchArgValue(item.name, k, v) : typeof v === 'string' ? v : JSON.stringify(v)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mb-2 border-t border-border" />
              </>
            )}
            <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">结果</div>
            <div className="max-h-[240px] overflow-y-auto text-[13px] whitespace-pre-wrap">{resultText}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// 授权卡（四段式，挂在当前调用行下方）：状态徽标 / 展示名 + 用途（服务描述原样，不经模型转述）/
// 参数键值全展开（授权卡的目的就是看清即将发生什么，单值过长卡内滚动）/ 拒绝 + 同意（同意为主按钮居右）
function AuthCard({
  item,
  onRespond
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  onRespond: (toolCallId: string, decision: 'approved' | 'denied') => void
}): React.JSX.Element {
  const args = Object.entries(item.args ?? {})
  const respond = (d: 'approved' | 'denied'): void => {
    if (item.id) onRespond(item.id, d)
  }
  return (
    <div className="ml-4 max-w-[440px] rounded-xl border border-border bg-background px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_16px_-4px_rgba(0,0,0,0.08)]">
      <div className="flex items-center gap-2 text-[12px] font-medium text-primary">
        <span className="size-[6px] animate-pulse rounded-full bg-primary" />
        等待授权
      </div>
      <div className="mt-2 text-[14px] font-medium text-foreground">{item.display ?? item.name}</div>
      {item.desc && (
        <div className="mt-0.5 line-clamp-3 text-[13px] leading-[1.6] text-muted-foreground">{item.desc}</div>
      )}
      {args.length > 0 && (
        <>
          <div className="mt-2.5 border-t border-border pt-2.5 text-[12px] font-medium text-muted-foreground">
            参数
          </div>
          <div className="mt-1.5 flex max-h-[200px] flex-col gap-1 overflow-y-auto">
            {args.map(([k, v]) => (
              <div key={k} className="flex gap-3 text-[13px]">
                <span className="w-[104px] flex-none truncate text-muted-foreground">{k}</span>
                <span className="min-w-0 break-all text-foreground">
                  {typeof v === 'string' ? v : JSON.stringify(v)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
        <button
          onClick={() => respond('denied')}
          className="rounded-lg border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          拒绝
        </button>
        <button
          onClick={() => respond('approved')}
          className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          同意
        </button>
      </div>
    </div>
  )
}

// 提问卡（悬浮于输入框上方）：逐题展示 + 进度切换可回头改；选项整行按钮（单选点击即进下一题，
// 多选勾选后点下一题）；「其他」输入行属作答（有内容时选项置灰、右下按钮由跳过变提交）；✕ 放弃整卡。
// 最后一题完成后提交全部答案。宽度与输入框一致，沿用其浮起阴影（悬浮层同族）。
function AskCard({
  item,
  onRespond
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  onRespond: (toolCallId: string, outcome: AskOutcomePayload) => void
}): React.JSX.Element {
  const questions = (item.args as { questions?: AskQuestionSpec[] }).questions ?? []
  // 模型偶发自设「其他」类选项，与卡片自带的输入行功能重叠，渲染时去重（仅匹配「其他」本身，不误伤正常选项）
  const dedupe = (ops: { label: string }[]): { label: string }[] => {
    const kept = ops.filter((op) => !/^其他([（(].*[)）])?$/.test(op.label.trim()))
    return kept.length >= 1 ? kept : ops
  }
  const [qIdx, setQIdx] = useState(0)
  // 每题作答态：undefined=未答，null=跳过，string=单选/其他，string[]=多选
  const [answers, setAnswers] = useState<(string | string[] | null | undefined)[]>(() =>
    questions.map(() => undefined)
  )
  const [others, setOthers] = useState<string[]>(() => questions.map(() => ''))
  const q = questions[qIdx]
  const last = qIdx === questions.length - 1
  const other = others[qIdx] ?? ''
  const cur = answers[qIdx]
  const multiPicked = Array.isArray(cur) ? cur : []

  const submitAll = (all: (string | string[] | null | undefined)[]): void => {
    if (!item.id) return
    onRespond(item.id, {
      kind: 'answers',
      answers: questions.map((qu, i) => {
        const a = all[i]
        return {
          question: qu.question,
          answer: a == null ? null : Array.isArray(a) ? (a.length ? a.join('、') : null) : a
        }
      })
    })
  }
  const commit = (answer: string | string[] | null): void => {
    const next = [...answers]
    next[qIdx] = answer
    setAnswers(next)
    if (last) submitAll(next)
    else setQIdx(qIdx + 1)
  }

  if (!q) return <></>
  return (
    <div className="flex-none pt-2">
      <div className="mx-auto w-full max-w-[840px] px-8">
        <div className="rounded-2xl border border-input bg-background px-5 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_28px_-8px_rgba(0,0,0,0.14)]">
          {/* 标题行：问题（多选题带标签）+ 进度切换 + 放弃整卡 */}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 text-[14px] font-medium text-foreground">
              {q.question}
              {q.multiSelect && (
                <span className="ml-2 inline-block rounded border border-border bg-muted px-1.5 py-0.5 align-middle text-[11px] font-normal text-muted-foreground">
                  可多选
                </span>
              )}
            </div>
            {questions.length > 1 && (
              <div className="flex flex-none items-center gap-1 text-[12px] text-muted-foreground">
                <button
                  onClick={() => setQIdx(Math.max(0, qIdx - 1))}
                  disabled={qIdx === 0}
                  className="grid size-5 place-items-center rounded hover:bg-muted disabled:opacity-30"
                >
                  ‹
                </button>
                {qIdx + 1} / {questions.length}
                <button
                  onClick={() => setQIdx(Math.min(questions.length - 1, qIdx + 1))}
                  disabled={last}
                  className="grid size-5 place-items-center rounded hover:bg-muted disabled:opacity-30"
                >
                  ›
                </button>
              </div>
            )}
            <button
              onClick={() => item.id && onRespond(item.id, { kind: 'declined' })}
              title="不回答这些问题"
              className="grid size-5 flex-none place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {/* 选项：编号整行按钮；「其他」框有内容时置灰（输入了内容就是在回应）。
              单选=圆徽标、点击即走，悬停显示去向（→ 下一题 / ↵ 提交，借鉴 Claude）；
              多选=方形复选框语义（勾中打 ✓），选完点右下「下一题/提交」 */}
          <div className="mt-3 flex flex-col gap-1.5">
            {dedupe(q.options).map((op, i) => {
              const picked = q.multiSelect ? multiPicked.includes(op.label) : cur === op.label
              return (
                <button
                  key={i}
                  disabled={!!other}
                  onClick={() => {
                    if (q.multiSelect) {
                      const set = picked ? multiPicked.filter((x) => x !== op.label) : [...multiPicked, op.label]
                      const next = [...answers]
                      next[qIdx] = set
                      setAnswers(next)
                    } else {
                      commit(op.label) // 单选点击即选定并自动进下一题
                    }
                  }}
                  className={cn(
                    'group flex min-h-[44px] w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                    picked ? 'border-ring bg-primary-soft' : 'border-border hover:bg-muted',
                    other && 'cursor-default opacity-40'
                  )}
                >
                  <span
                    className={cn(
                      'grid size-5 flex-none place-items-center text-[12px]',
                      q.multiSelect ? 'rounded-md' : 'rounded-full',
                      // 悬停时行底变灰，徽标换白底避免融进背景
                      picked ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:bg-background'
                    )}
                  >
                    {q.multiSelect && picked ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-[14px] text-foreground">{op.label}</span>
                  {!q.multiSelect && !other && (
                    // 悬停提示点击后的去向：非末题 → 进下一题；末题 ↵ 提交
                    <span className="flex-none text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                      {last ? <CornerDownLeft className="size-4" /> : <ArrowRight className="size-4" />}
                    </span>
                  )}
                </button>
              )
            })}

            {/* 「其他」行：与选项同样式的整行，序号位换 ✎ 图标，点击行内输入（对齐 Claude 桌面端）；
                右侧单按钮随状态切换语义：跳过 ↔ 提交（其他框有内容 / 多选已勾选） */}
            <div
              className={cn(
                'flex min-h-[44px] w-full items-center gap-3 rounded-lg border px-3 py-2 transition-colors',
                other ? 'border-ring bg-primary-soft' : 'border-border'
              )}
            >
              <span className="grid size-5 flex-none place-items-center rounded-full bg-muted text-[12px] text-muted-foreground">
                ✎
              </span>
              <input
                value={other}
                onChange={(e) => {
                  const next = [...others]
                  next[qIdx] = e.target.value
                  setOthers(next)
                }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  if (e.key === 'Enter' && other.trim()) {
                    e.preventDefault()
                    commit(other.trim())
                  }
                }}
                placeholder="其他……"
                className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground"
              />
              {other.trim() ? (
                <button
                  onClick={() => commit(other.trim())}
                  title={last ? '提交答案' : '进下一题'}
                  className="grid size-7 flex-none place-items-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {/* 与选项悬停提示同一套语义：非末题 → 下一题；末题 ↵ 提交 */}
                  {last ? (
                    <CornerDownLeft className="size-3.5" strokeWidth={2.2} />
                  ) : (
                    <ArrowRight className="size-3.5" strokeWidth={2.2} />
                  )}
                </button>
              ) : q.multiSelect && multiPicked.length ? (
                <button
                  onClick={() => commit(multiPicked)}
                  className="flex-none rounded-lg bg-primary px-3 py-1 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {last ? '提交' : '下一题'}
                </button>
              ) : (
                <button
                  onClick={() => commit(null)}
                  className="flex-none rounded-lg border border-border px-3 py-1 text-[13px] font-medium text-foreground hover:bg-muted"
                >
                  跳过
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// 检索步骤（v0.4.0 既有样式）：结果行点击展开命中列表 / 错误说明
function SearchToolRow({ item }: { item: Extract<TurnItem, { t: 'tool' }> }): React.JSX.Element {
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
            : r.interrupted
              ? '已中断'
              : '检索出错'
  const detail = r?.results?.length
    ? [...new Set(r.results.map((x) => `${x.file.replace(/\.md$/, '')}${x.heading ? ' › ' + x.heading : ''}`))]
    : r?.error
      ? [r.error]
      : r?.denied
        ? [r.denied]
        : r?.notice
          ? [r.notice]
          : r?.interrupted
            ? [r.interrupted]
            : []
  return (
    <div className="flex gap-2.5">
      <Dot tone={running ? 'running' : failed ? 'error' : 'neutral'} />
      <div className={cn('min-w-0 flex-1', PROCESS_ROW)}>
        {/* 调用行：整行同字体、同字号、同色，不再换等宽或改色 */}
        <div>检索(&quot;{String(item.args.query ?? '')}&quot;)</div>
        <button
          onClick={() => detail.length && setOpen((o) => !o)}
          className={cn(
            '-ml-1 flex items-center gap-2 rounded-md px-1 py-0.5',
            detail.length && 'transition-colors hover:bg-muted'
          )}
        >
          <span className={cn('text-muted-foreground/50', failed && 'text-destructive')}>⎿</span>
          {/* 真故障标红，对齐 Claude Code 工具失败的视觉 */}
          <span className={cn(failed && 'font-medium text-destructive')}>{summary}</span>
          {detail.length > 0 && (
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          )}
        </button>
        {open && (
          // 「-」无序列表，缩进到结果行文字之下体现父子；不用竖线
          <div className="mt-1 ml-5 flex flex-col gap-1">
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
    // 分组键带库：多库下不同库可能存在同名文档
    const byFile = new Map<string, { file: string; kbName: string; sources: SourceRef[] }>()
    for (const s of list) {
      const key = `${s.kbId}:${s.filePath}`
      let art = byFile.get(key)
      if (!art) {
        art = { file: s.filePath, kbName: s.kbName ?? '', sources: [] }
        byFile.set(key, art)
      }
      art.sources.push(s)
    }
    return [...byFile.values()]
  }, [list])
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 mt-2 duration-500">
      <div className="mb-1.5 text-[13px] font-medium text-muted-foreground">来源</div>
      {/* 带框的一列来源：每条显示完整相对路径，整行可点、悬停高亮；超宽尾部省略、悬停看全路径 */}
      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
        {articles.map((a) => (
          <button
            key={`${a.kbName}:${a.file}`}
            onClick={() => onOpen(a.file, a.sources)}
            title={a.file}
            className="group flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted"
          >
            <FileText className="size-4 flex-none text-muted-foreground" />
            <span className="truncate text-[13px] text-muted-foreground group-hover:text-foreground">
              {a.file.replace(/\.md$/, '')}
            </span>
            {a.kbName && (
              <span className="ml-auto flex-none rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {a.kbName}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageActions({
  content,
  onRetry,
  usage
}: {
  content: string
  onRetry?: () => void
  usage?: { input: number; output: number; cached: number }
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="-ml-1.5 flex items-center gap-1">
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
      {usage && <UsageChip usage={usage} />}
    </div>
  )
}

// 本轮用量（PRD Case 5）：按钮形态尾随复制 / 重新生成，悬停看输入（含缓存命中）与输出拆分
function UsageChip({ usage }: { usage: { input: number; output: number; cached: number } }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const total = usage.input + usage.output
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="grid h-8 cursor-default place-items-center rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted">
        {total.toLocaleString()} tokens
      </span>
      {open && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 min-w-[190px] rounded-xl border border-border bg-popover p-3 text-[12px] shadow-lg">
          <div className="flex justify-between gap-8">
            <span className="text-muted-foreground">输入</span>
            <span className="tabular-nums">{usage.input.toLocaleString()}</span>
          </div>
          {usage.cached > 0 && (
            <div className="mt-1.5 flex justify-between gap-8">
              <span className="pl-1 text-muted-foreground">└ 缓存命中</span>
              <span className="tabular-nums text-muted-foreground">{usage.cached.toLocaleString()}</span>
            </div>
          )}
          <div className="mt-1.5 flex justify-between gap-8">
            <span className="text-muted-foreground">输出</span>
            <span className="tabular-nums">{usage.output.toLocaleString()}</span>
          </div>
        </div>
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
        'flex items-center gap-3 rounded-lg border border-l-[3px] border-destructive/25 border-l-destructive bg-destructive/[0.04] px-3 py-2.5',
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
