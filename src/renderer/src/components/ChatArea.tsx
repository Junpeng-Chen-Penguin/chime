import { useMemo, useState, type ReactNode } from 'react'
import {
  PanelLeft,
  ChevronRight,
  RotateCw,
  Loader2,
  AlertCircle,
  ArrowDown,
  Copy,
  Check,
  CircleCheck,
  Sparkles
} from 'lucide-react'
import { cn, stripCitations } from '@/lib/utils'
import type { Msg } from '@/hooks/useChat'
import type { SourceRef } from '../../../preload/index.d'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useSmoothText } from '@/hooks/useSmoothText'
import { Markdown } from './Markdown'
import Composer, { type KbState } from './Composer'

interface Props {
  title: string
  convId: string
  collapsed: boolean
  onExpand: () => void
  messages: Msg[]
  sending: boolean
  input: string
  onInput: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  onRetry: (msgId: string) => void
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

  return (
    <div className="flex h-full min-w-[480px] flex-1 flex-col overflow-hidden rounded-[12px] border border-black/[0.05] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_14px_rgba(0,0,0,0.07)]">
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
                    <AssistantMsg key={m.id} m={m} onRetry={() => onRetry(m.id)} onOpenSource={onOpenSource} />
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

      <Composer
        model={model}
        models={models}
        onPickModel={onPickModel}
        sending={sending}
        value={input}
        onChange={onInput}
        onSubmit={onSubmit}
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

function AssistantMsg({
  m,
  onRetry,
  onOpenSource
}: {
  m: Msg
  onRetry: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  const streaming = m.status === 'streaming'
  const finished = m.status === 'done' || m.status === 'stopped'
  // 正文隐去引用标记（引用关系保留于 m.content 与 sources，用于来源清单与侧板高亮）
  const displayRaw = useMemo(() => stripCitations(m.content, streaming), [m.content, streaming])
  const content = useSmoothText(displayRaw, streaming)

  // 处理过程时间线：知识库步骤 + 模型思考统一进一条时间线（思考插在「生成回复」前）
  const dispSteps = useMemo<DispStep[]>(() => {
    const base: DispStep[] = (m.steps ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      detail: s.detail,
      state: s.done ? 'done' : 'pending'
    }))
    if (m.reasoning) {
      const think: DispStep = {
        key: 'think',
        label: '思考',
        detail: m.thinkMs != null ? `${(m.thinkMs / 1000).toFixed(1)}s` : undefined,
        state: !!m.content || !streaming ? 'done' : 'pending',
        expand: m.reasoning
      }
      const gi = base.findIndex((s) => s.key === 'generate')
      if (gi >= 0) base.splice(gi, 0, think)
      else base.push(think)
    }
    // 流式中：第一个未完成的步骤为进行中，其后为待办；结束后全部完成
    let running = false
    return base.map((s) => {
      if (s.state === 'done') return s
      if (streaming && !running) {
        running = true
        return { ...s, state: 'running' }
      }
      return { ...s, state: streaming ? 'pending' : 'done' }
    })
  }, [m.steps, m.reasoning, m.thinkMs, m.content, streaming])

  // 引用按文章（文件）归并；每篇携带其被引用的片段（原文快照），供侧板定位高亮
  const { cited, articles } = useMemo(() => {
    const arts: { file: string; sources: SourceRef[] }[] = []
    if (!m.sources?.length) return { cited: false, articles: arts }
    const byN = new Map(m.sources.map((s) => [s.n, s]))
    const byFile = new Map<string, { file: string; sources: SourceRef[] }>()
    const add = (s: SourceRef): void => {
      let art = byFile.get(s.filePath)
      if (!art) {
        art = { file: s.filePath, sources: [] }
        byFile.set(s.filePath, art)
        arts.push(art)
      }
      if (!art.sources.includes(s)) art.sources.push(s)
    }
    let hasCited = false
    for (const match of m.content.matchAll(/\[(\d+)\]/g)) {
      const s = byN.get(+match[1])
      if (!s) continue
      hasCited = true
      add(s)
    }
    if (!hasCited) for (const s of m.sources) add(s) // 降级：模型没打标记，列全部（按文章去重）
    return { cited: hasCited, articles: arts }
  }, [m.content, m.sources])

  // 一开始就失败、没有任何内容 → 单独一张错误卡片
  if (m.status === 'error' && !m.content && !m.reasoning) {
    return <ErrorCard text={m.error ?? '请求中断，请重试'} onRetry={onRetry} />
  }
  return (
    <div className="text-[16px] text-foreground select-text">
      {dispSteps.length > 0 && <ProcessBlock steps={dispSteps} streaming={streaming} />}
      {content ? (
        <Markdown text={content} streaming={streaming} />
      ) : streaming && dispSteps.length === 0 ? (
        <Markdown text="" streaming />
      ) : null}
      {!streaming && articles.length > 0 && (
        <SourcesFooter articles={articles} cited={cited} onOpen={onOpenSource} />
      )}
      {finished && (m.content || m.reasoning) && (
        <MessageActions content={displayRaw} onRetry={onRetry} />
      )}
      {m.status === 'error' && (m.content || m.reasoning) && (
        <ErrorCard className="mt-3" text={m.error ?? '请求中断，请重试'} onRetry={onRetry} />
      )}
    </div>
  )
}

// 处理过程：折叠态一行（进行中显示当前步骤；完成后为「已思考 · Xs」星星样式），
// 点开为 Claude 式时间线——每步一个对应图标、竖线相连，思考内容直接展开在步骤下方。不落库。
interface DispStep {
  key: string
  label: string
  detail?: string
  state: 'done' | 'running' | 'pending'
  expand?: string
}

function ProcessBlock({ steps, streaming }: { steps: DispStep[]; streaming: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const running = steps.find((s) => s.state === 'running')
  const thinkStep = steps.find((s) => s.key === 'think')
  const headLabel =
    streaming && running
      ? `正在${running.label}…`
      : thinkStep?.detail
        ? `已思考 · ${thinkStep.detail}`
        : (steps.find((s) => s.key === 'retrieve')?.detail ?? '处理过程')
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="-ml-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted"
      >
        {streaming && running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
        <span>{headLabel}</span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col">
          {/* 只显示已到达的步骤：未开始的不出现，「完成」仅在结束后出现 */}
          {[
            ...steps.filter((s) => s.state !== 'pending'),
            ...(streaming ? [] : [{ key: 'end', label: '完成', state: 'done' } as DispStep])
          ].map((s, i, all) => (
            <div key={s.key} className="flex gap-2.5">
              <div className="flex flex-col items-center self-stretch">
                <span className="grid size-6 flex-none place-items-center text-muted-foreground">
                  {s.state === 'running' ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <CircleCheck className="size-3.5" />
                  )}
                </span>
                {i < all.length - 1 && <span className="w-px min-h-2 flex-1 bg-border" />}
              </div>
              <div
                className={cn(
                  'min-w-0 flex-1 pt-0.5 text-[13px] leading-[1.6] text-muted-foreground',
                  i < all.length - 1 && 'pb-3.5'
                )}
              >
                {s.label}
                {s.detail && ` · ${s.detail}`}
                {s.expand && <div className="mt-1.5 leading-[1.7] whitespace-pre-wrap">{s.expand}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// 来源清单：回答完成后展示，以文章（文件）为单位去重；只列被引用的，模型没打标记时降级列全部。
// 条目可点击 → 侧板打开该文档并定位高亮被引用片段
function SourcesFooter({
  articles,
  cited,
  onOpen
}: {
  articles: { file: string; sources: SourceRef[] }[]
  cited: boolean
  onOpen: (file: string, sources: SourceRef[]) => void
}): React.JSX.Element {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 mt-3 border-t border-border pt-2.5 duration-500">
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">
        {cited ? '来源' : '参考来源'}
      </div>
      <div className="flex flex-col">
        {articles.map((a) => (
          <button
            key={a.file}
            onClick={() => onOpen(a.file, a.sources)}
            title="点击查看原文"
            className="flex items-center gap-2 py-0.5 text-left text-[12.5px] leading-[1.8] text-primary hover:underline"
          >
            <span className="size-[5px] flex-none rounded-full bg-primary/50" />
            <span className="truncate">{a.file.replace(/\.md$/, '')}</span>
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
  onRetry: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="-ml-1.5 mt-2.5 flex items-center gap-0.5">
      {content && (
        <ActionBtn title={copied ? '已复制' : '复制'} onClick={copy}>
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </ActionBtn>
      )}
      <ActionBtn title="重新生成" onClick={onRetry}>
        <RotateCw className="size-4" />
      </ActionBtn>
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
  onRetry: () => void
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
      <span className="flex-1 text-[13.5px] text-foreground">{text}</span>
      <button
        onClick={onRetry}
        className="flex flex-none items-center gap-1.5 rounded-md border border-destructive/30 px-2.5 py-1 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
      >
        <RotateCw className="size-3.5" />
        重试
      </button>
    </div>
  )
}

