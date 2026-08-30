import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Folder,
  TriangleAlert,
  Wrench,
  PanelLeft,
  PanelRight,
  ChevronRight,
  RotateCw,
  AlertCircle,
  ArrowDown,
  ArrowRight,
  CornerDownLeft,
  Copy,
  Check,
  FileText,
  Table,
  Table2,
  X
} from 'lucide-react'
import { cn, stripCitations } from '@/lib/utils'
import type { Msg } from '@/hooks/useChat'
import type {
  SourceRef,
  TurnItem,
  AskOutcomePayload,
  AskQuestionSpec
} from '../../../preload/index.d'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { Markdown } from './Markdown'
import { CallGroup, segmentItems } from './CallRow'
import Composer, {
  type KbOption,
  type KbSelEntry,
  type ModelGroup,
  type ServiceStatus,
  type WsSelector
} from './Composer'

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
  chips?: import('../types').ChipRef[] // 待发送的表格行引用（013 Case 2）
  onRemoveChip?: (idx: number) => void
  onSubmit: () => void
  onStop: () => void
  onRetry: () => void
  onRename: (title: string) => void
  model: string
  models: ModelGroup[]
  onPickModel: (m: string) => void
  kbOptions: KbOption[]
  kbSel: KbSelEntry[]
  agents: { id: number; name: string }[]
  agentSel: { id: number; name: string } | null
  agentLocked: boolean
  agentGone: boolean
  agentServiceIds: number[]
  onSelectAgent: (a: { id: number; name: string } | null) => void
  onManageAgents: () => void
  onManageServices: () => void
  onConfigureModel: () => void
  services: ServiceStatus[]
  selectedServiceIds: number[]
  onToggleService: (id: number) => void
  onRetryServices: () => void
  onOpenSettings: () => void
  onOpenSource: (file: string, sources: SourceRef[]) => void
  onRespondCard: (toolCallId: string, decision: 'approved' | 'denied' | 'always') => void
  onRespondAsk: (toolCallId: string, outcome: AskOutcomePayload) => void
  onOpenArtifact: (id: number, rows?: number[]) => void
  ws?: WsSelector // 工作空间选择器（015 Case 1）
  workPanelOpen?: boolean
  onToggleWorkPanel?: () => void // 工作面板常驻开关（右上角）
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
  chips,
  onRemoveChip,
  onRename,
  model,
  models,
  onPickModel,
  kbOptions,
  kbSel,
  agents,
  agentSel,
  agentLocked,
  agentGone,
  agentServiceIds,
  onSelectAgent,
  onManageAgents,
  onManageServices,
  onConfigureModel,
  services,
  selectedServiceIds,
  onToggleService,
  onRetryServices,
  onOpenSettings,
  onOpenSource,
  onRespondCard,
  onRespondAsk,
  onOpenArtifact,
  ws,
  workPanelOpen,
  onToggleWorkPanel
}: Props): React.JSX.Element {
  const empty = messages.length === 0
  const { scrollRef, onScroll, showJump, scrollToBottom } = useStickToBottom(messages, convId)
  // 超限检查计入引用的估算字数（013 Case 2）：不然发出去才发现超
  const chipChars = (chips ?? []).reduce((n, c) => n + (c.chars ?? 0), 0)
  const overLimit = input.length + chipChars > SEND_CHAR_LIMIT
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
      chips={chips}
      onRemoveChip={onRemoveChip}
      onOpenChip={(c) => onOpenArtifact(c.artifactId, c.rowIndexes)}
      onSubmit={() => {
        if (!overLimit) onSubmit()
      }}
      onStop={onStop}
      sessionUsage={sessionUsage}
      kbOptions={kbOptions}
      kbSel={kbSel}
      agents={agents}
      agentSel={agentSel}
      agentLocked={agentLocked}
      agentGone={agentGone}
      agentServiceIds={agentServiceIds}
      onSelectAgent={onSelectAgent}
      onManageAgents={onManageAgents}
      onManageServices={onManageServices}
      onConfigureModel={onConfigureModel}
      services={services}
      selectedServiceIds={selectedServiceIds}
      onToggleService={onToggleService}
      onRetryServices={onRetryServices}
      onOpenSettings={onOpenSettings}
      ws={ws}
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
        <div className="flex-1" />
        {/* 工作面板常驻开关（015 Case 1）：图标用「右侧面板」方向，与左侧边栏开关区分 */}
        {onToggleWorkPanel && (
          <button
            onClick={onToggleWorkPanel}
            title={workPanelOpen ? '收起工作面板' : '展开工作面板'}
            className={cn(
              'app-no-drag grid size-8 flex-none place-items-center rounded-md transition-colors hover:bg-black/5 hover:text-foreground',
              workPanelOpen ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            <PanelRight className="size-[18px]" />
          </button>
        )}
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
                      <UserMsg key={m.id} m={m} onOpenArtifact={onOpenArtifact} />
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
          // 输入法合成中的 Enter 是确认候选词，不该触发提交
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
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

// 用户消息：带引用时 chip 排在气泡上方（013 Case 2），样式同输入框上方、无移除钮；
// 点击打开对应制品并高亮当时引用的那几行
function UserMsg({
  m,
  onOpenArtifact
}: {
  m: Msg
  onOpenArtifact: (id: number, rows?: number[]) => void
}): React.JSX.Element {
  const refs = (m.items ?? []).filter((it): it is Extract<TurnItem, { t: 'ref' }> => it.t === 'ref')
  // 斜杠点名（015 Case 6，验收修订）：正文开头的「/技能名」原位置用文字颜色区分（不做标签框），
  // 悬停看发出时的简介快照；其余文字照常。技能之后删除或更新不回改——渲染件随消息落库
  const skill = (m.items ?? []).find(
    (it): it is Extract<TurnItem, { t: 'skillref' }> => it.t === 'skillref'
  )
  const slashLen = skill && m.content.startsWith(`/${skill.name}`) ? skill.name.length + 1 : 0
  return (
    <div className="flex flex-col items-end gap-1.5">
      {refs.length > 0 && (
        <div className="flex max-w-[82%] flex-wrap justify-end gap-1.5">
          {refs.map((r, i) => (
            <button
              key={i}
              onClick={() => onOpenArtifact(r.artifactId, r.rowIndexes)}
              title={r.title}
              className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2 py-1 text-[12px] transition-colors hover:bg-muted"
            >
              <Table2 className="size-3.5 flex-none text-muted-foreground" />
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="flex-none text-muted-foreground">{r.rowIndexes.length} 行</span>
            </button>
          ))}
        </div>
      )}
      <div className="max-w-[82%] rounded-[18px] bg-[#f0f0ee] px-4 py-2.5 text-[16px] leading-[1.7] break-words whitespace-pre-wrap text-foreground select-text">
        {slashLen ? (
          <>
            <span title={skill!.desc} className="text-primary">
              {m.content.slice(0, slashLen)}
            </span>
            {m.content.slice(slashLen)}
          </>
        ) : (
          m.content
        )}
      </div>
    </div>
  )
}

// 状态行（016 Case 12）：转圈 + 耗时 + 按当前动作的文案，一轮里常驻；
// 文案按引擎事件对应不随时间轮播，耗时超 60 秒转分秒（codex 的 fmt_elapsed_compact 格式）
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// 四档文案（Case 12 功能点 2）：间隙一律归「等待回应」——请求刚发出，或上一段结束下一段没开始
function statusLabel(items: TurnItem[], tailOpen: boolean | undefined): string {
  const last = items[items.length - 1]
  if (!last) return '等待回应'
  if (last.t === 'reasoning' && tailOpen) return '思考中'
  if (last.t === 'tool' && last.result === undefined) return '执行工具'
  if (last.t === 'text' && tailOpen) return '回答中'
  return '等待回应'
}

function ProgressIndicator({
  timer,
  label
}: {
  timer: { acc: number; since: number | null }
  label: string
}): React.JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = timer.acc + (timer.since !== null ? Date.now() - timer.since : 0)
  return (
    <div className="mt-1 flex items-center gap-2.5 text-[14px]">
      <span className="size-4 flex-none animate-spin rounded-full border-2 border-primary border-t-transparent" />
      <span className="text-muted-foreground">{fmtElapsed(elapsed)}</span>
      <span className="text-muted-foreground/50">·</span>
      <span className="text-shimmer">{label}</span>
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
  onRespondCard: (toolCallId: string, decision: 'approved' | 'denied' | 'always') => void
  onOpenArtifact: (id: number) => void
}): React.JSX.Element {
  const streaming = m.status === 'streaming'
  const finished = m.status === 'done' || m.status === 'stopped' || m.status === 'interrupted'
  const items = m.items ?? []
  // 状态行的计时（016 Case 12）：累计值放消息层——弹卡时状态行整个卸载，放它自己里面会清零。
  // 等卡期间暂停（等待是用户的时间），回应后接着走；只在内存，不落库
  const timerRef = useRef<{ acc: number; since: number | null }>({ acc: 0, since: null })
  // 卡片排队（授权 + 提问共用一条队列）：队首是授权卡时挂在调用行下方；队首是提问卡时悬浮于输入框上方（由 ChatArea 渲染）
  const pendingIdx = streaming
    ? items.findIndex(
        (it) => it.t === 'tool' && (it.auth === 'pending' || it.ask?.state === 'pending')
      )
    : -1
  const pendingIsAuth =
    pendingIdx >= 0 && (items[pendingIdx] as Extract<TurnItem, { t: 'tool' }>).auth === 'pending'
  if (streaming && pendingIdx < 0 && timerRef.current.since === null) {
    timerRef.current.since = Date.now()
  } else if ((!streaming || pendingIdx >= 0) && timerRef.current.since !== null) {
    timerRef.current.acc += Date.now() - timerRef.current.since
    timerRef.current.since = null
  }

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
    // 016 验收修订：右边缘与用户气泡对齐（原来右侧留 40px 缩进，产品负责人定去掉）
    <div className="flex flex-col gap-2 text-foreground select-text">
      {segmentItems(items).map((seg) => {
        if (seg.kind === 'calls') {
          // 一组连续调用行（016 Case 5/6）：三段式一行，正常答完后折成「执行 N 个步骤」；
          // 授权卡挂在组末尾（Case 7），不夹在调用行中间
          const authIdx = seg.indices.indexOf(pendingIdx)
          return (
            <CallGroup
              key={seg.base}
              items={seg.items}
              baseIndex={seg.base}
              streaming={streaming}
              collapsed={m.status === 'done' && !!answer && seg.items.length > 1}
              lastRunningIdx={streaming ? items.length - 1 : -1}
            >
              {authIdx >= 0 && pendingIsAuth && (
                <AuthCard
                  key={(items[pendingIdx] as Extract<TurnItem, { t: 'tool' }>).id}
                  item={items[pendingIdx] as Extract<TurnItem, { t: 'tool' }>}
                  onRespond={onRespondCard}
                />
              )}
            </CallGroup>
          )
        }
        const it = seg.item
        const i = seg.idx
        switch (it.t) {
          case 'text':
            // 模型的话一律正文样式（Markdown），不因后续步骤回溯降级——中途回复也是给用户看的内容
            return (
              <AnswerRow key={i} text={it.text} streaming={streaming && i === items.length - 1} />
            )
          case 'artifact':
            // 制品卡：Chime 渲染，卡本身就是这次调用的展示（成果即过程）。
            // 可点性靠样式表达（悬停浮起 + 右侧箭头），不写操作说明文案
            return (
              // 制品卡（016 Case 9）：与正文同宽 656px，图标与标题靠左、行数与箭头靠右
              <button
                key={i}
                onClick={() => onOpenArtifact(it.id)}
                className="group flex w-full items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all hover:border-ring/50 hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              >
                <span className="grid size-9 flex-none place-items-center rounded-lg bg-primary/10">
                  <Table className="size-[18px] text-primary" />
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[14px] font-medium text-foreground"
                  title={it.title}
                >
                  {it.title}
                </span>
                {/* 类型由图标表达，文字只补图标说不了的信息（规模） */}
                <span className="flex-none text-[12px] text-muted-foreground">{it.rowCount} 行</span>
                <ChevronRight className="size-4 flex-none text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
              </button>
            )
          case 'compaction':
            // 压缩分界线（016 Case 11）：虚线嵌文字；省下多少估不出时只放一个圆点
            return (
              <div key={i} className="my-3 flex w-full items-center gap-3">
                <div className="min-w-[24px] flex-1 border-t border-dashed border-border" />
                {it.savedTokens ? (
                  <span className="flex-none text-[12px] text-muted-foreground">
                    已压缩上下文，节省约 {it.savedTokens.toLocaleString()} tokens
                  </span>
                ) : (
                  <span className="size-1.5 flex-none rounded-full bg-muted-foreground/50" />
                )}
                <div className="min-w-[24px] flex-1 border-t border-dashed border-border" />
              </div>
            )
          case 'boundary':
            // 016 Case 11：工具上限的边界行去掉（信息并进失败的调用行）；error 边界由错误卡呈现
            return null
          default:
            return null // sources 在回答之后统一渲染（历史数据里可能残留已废弃的 item 类型，一并静默跳过）
        }
      })}
      {/* 整轮进度指示：挂在当前助手消息末尾，紧随已有内容——无内容时就贴着用户消息，不留空隙。
          等待授权期间没有请求在跑，不显示进度指示 */}
      {streaming && pendingIdx < 0 && (
        <ProgressIndicator timer={timerRef.current} label={statusLabel(items, m.tailOpen)} />
      )}
      {/* 结束原因统一排在页脚之前（016 Case 14 功能点 7）：停止 / 退出中断 / 错误卡 */}
      {m.status === 'stopped' && <PlainRow text="你停止了这次回答，需要继续可以直接说" />}
      {m.status === 'interrupted' && <PlainRow text="本轮在应用退出时被中断" />}
      {m.status === 'error' && hasBody && (
        <ErrorCard text={m.error ?? '请求中断，请重试'} onRetry={isLast ? onRetry : undefined} />
      )}
      {!streaming && sources && sources.list.length > 0 && (
        <SourcesFooter list={sources.list} onOpen={onOpenSource} />
      )}
      {/* 页脚（Case 14 功能点 5）：四种结束方式一视同仁，出错也出复制；
          重新生成仅末轮，出错轮不出（入口在错误卡）；用量拿得到就显示（停止轮是已完成各步合计） */}
      {(finished || (m.status === 'error' && hasBody)) && (answer || isLast) && (
        <MessageActions
          content={answer ? stripCitations(answer, false) : ''}
          onRetry={isLast && m.status !== 'error' ? onRetry : undefined}
          usage={m.usage}
        />
      )}
    </div>
  )
}

// 过程层统一尺度：14px、弱化色；类型区分只靠行首标记，不靠字号变化
const PROCESS_ROW = 'text-[14px] leading-[1.7] text-muted-foreground'

// 元素行首的圆点。tone：单步状态点 + 中性缺省（对齐 14px 首行光学中心）；queued = 空心（排队中）
function Dot({
  tone = 'neutral'
}: {
  tone?: 'neutral' | 'running' | 'error' | 'queued'
}): React.JSX.Element {
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

// 授权决策条（011 Case 4 瘦身）：信息在工具行显示一次（title＋参数），这里只剩决策——
// 一句问句＋允许/拒绝，不重复工具名与参数、不显示工具描述全文（描述是给模型读的材料）
function AuthCard({
  item,
  onRespond
}: {
  item: Extract<TurnItem, { t: 'tool' }>
  onRespond: (toolCallId: string, decision: 'approved' | 'denied' | 'always') => void
}): React.JSX.Element {
  const respond = (d: 'approved' | 'denied' | 'always'): void => {
    if (item.id) onRespond(item.id, d)
  }
  // 016 Case 7：纵向四段（图标问句、说明、对象、按钮），与正文同宽、不缩进；
  // 四种卡各自的图标与问句见产品方案功能点 6，按钮序固定「拒绝、总是允许、允许」
  const fs = item.fsCard
  const fname = fs?.path?.split('/').filter(Boolean).pop() ?? ''
  const isWrite = fs?.mode === 'write'
  const overwrite = isWrite && fs?.op === '覆盖'
  const Icon = fs?.mode === 'ws-request' ? Folder : overwrite ? TriangleAlert : isWrite ? FileText : Wrench
  const wsName = (fs?.dirs ?? []).map((d) => d.split('/').filter(Boolean).pop() ?? d).join('、')
  const question: ReactNode =
    fs?.mode === 'ws-request' ? (
      <>
        允许访问工作空间「<span className="font-semibold">{wsName}</span>」吗？
      </>
    ) : isWrite ? (
      <>
        允许{fs?.op === '覆盖' ? '覆盖已有文件' : fs?.op === '新建' ? '新建文件' : '修改文件'}「
        <span className="font-semibold">{fname}</span>」吗？
      </>
    ) : (
      <>
        允许执行「<span className="font-semibold">{item.display ?? item.name}</span>」吗？
      </>
    )
  const objectPath = fs?.mode === 'ws-request' ? (fs.dirs ?? []).join('\n') : fs?.path
  // 「总是允许」记的是目录：悬停说清记住哪个目录、只在本会话内有效
  const alwaysDir = fs?.path ? fs.path.split('/').slice(0, -1).join('/') : ''
  const btn = 'rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors'
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 mt-1 flex w-full flex-col gap-3 rounded-xl border border-border bg-background px-4 py-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_16px_-4px_rgba(0,0,0,0.08)] duration-200">
      <div className="flex items-center gap-2.5 text-[14px] font-medium text-foreground">
        <Icon
          className={cn('size-4 flex-none', overwrite ? 'text-destructive' : 'text-muted-foreground')}
        />
        <span className="min-w-0">{question}</span>
      </div>
      {overwrite && (
        <div className="text-[13px] text-muted-foreground">
          这个文件已存在，覆盖后原内容不可恢复
        </div>
      )}
      {objectPath && (
        <div className="rounded-lg bg-muted/50 px-3 py-2 font-mono text-[12px] break-all whitespace-pre-wrap text-muted-foreground select-text">
          {objectPath}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => respond('denied')}
          className={cn(btn, 'border border-border text-foreground hover:bg-muted')}
        >
          拒绝
        </button>
        {isWrite && (
          <button
            onClick={() => respond('always')}
            title={alwaysDir ? `记住目录 ${alwaysDir}，本会话内该目录下的写入不再询问` : undefined}
            className={cn(btn, 'border border-border text-foreground hover:bg-muted')}
          >
            总是允许此目录
          </button>
        )}
        <button
          onClick={() => respond('approved')}
          className={cn(btn, 'bg-primary text-primary-foreground hover:bg-primary/90')}
        >
          允许
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
  const [focusIdx, setFocusIdx] = useState(0) // 键盘焦点行（016 Case 8 功能点 3/4）

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

  // 键盘接管（016 Case 8 功能点 3）：数字键直接选中，上下移动焦点，回车选定焦点行，
  // 左右切题，Esc 放弃整卡。输入框（其他行、主输入框）里打字不劫持
  useEffect(() => {
    const opts = q ? dedupe(q.options) : []
    const h = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape' && item.id) onRespond(item.id, { kind: 'declined' })
        return
      }
      const pick = (i: number): void => {
        if (i < 0 || i >= opts.length) return
        if (q.multiSelect) {
          const label = opts[i].label
          const set = multiPicked.includes(label)
            ? multiPicked.filter((x) => x !== label)
            : [...multiPicked, label]
          const next = [...answers]
          next[qIdx] = set
          setAnswers(next)
        } else {
          commit(opts[i].label)
        }
      }
      if (e.key === 'Escape' && item.id) onRespond(item.id, { kind: 'declined' })
      else if (/^[1-9]$/.test(e.key)) pick(Number(e.key) - 1)
      else if (e.key === 'ArrowDown') setFocusIdx((f) => Math.min(f + 1, opts.length - 1))
      else if (e.key === 'ArrowUp') setFocusIdx((f) => Math.max(f - 1, 0))
      else if (e.key === 'ArrowRight') setQIdx((i) => Math.min(i + 1, questions.length - 1))
      else if (e.key === 'ArrowLeft') setQIdx((i) => Math.max(i - 1, 0))
      else if (e.key === 'Enter') pick(focusIdx)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })
  useEffect(() => setFocusIdx(0), [qIdx]) // 切题重置焦点

  if (!q) return <></>
  return (
    <div className="flex-none pt-2">
      <div className="mx-auto w-full max-w-[840px] px-8">
        <div className="flex max-h-[45vh] flex-col rounded-2xl border border-input bg-background px-5 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_28px_-8px_rgba(0,0,0,0.14)]">
          {/* 标题行：问题（多选题带标签）+ 进度切换 + 放弃整卡 */}
          <div className="flex min-h-0 flex-none items-start gap-3">
            <div className="min-w-0 flex-1 overflow-y-auto text-[14px] font-medium text-foreground [max-height:calc(45vh-260px)] [min-height:44px]">
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
          <div className="mt-3 flex flex-none flex-col gap-1.5">
            {dedupe(q.options).map((op, i) => {
              const picked = q.multiSelect ? multiPicked.includes(op.label) : cur === op.label
              return (
                <button
                  key={i}
                  disabled={!!other}
                  onClick={() => {
                    if (q.multiSelect) {
                      const set = picked
                        ? multiPicked.filter((x) => x !== op.label)
                        : [...multiPicked, op.label]
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
                    !picked && i === focusIdx && 'border-ring', // 键盘焦点行（016 Case 8）
                    other && 'cursor-default opacity-40'
                  )}
                >
                  <span
                    className={cn(
                      'grid size-5 flex-none place-items-center text-[12px]',
                      q.multiSelect ? 'rounded-md' : 'rounded-full',
                      // 悬停时行底变灰，徽标换白底避免融进背景
                      picked
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground group-hover:bg-background'
                    )}
                  >
                    {q.multiSelect && picked ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-[14px] text-foreground"
                    title={op.label}
                  >
                    {op.label}
                  </span>
                  {!q.multiSelect && !other && (
                    // 去向常驻显示（016 Case 8 功能点 4）：非末题 → 进下一题；末题 ↵ 提交
                    <span className="flex-none text-muted-foreground/50">
                      {last ? (
                        <CornerDownLeft className="size-4" />
                      ) : (
                        <ArrowRight className="size-4" />
                      )}
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
// 最终回答：正文直接起排、不带行首标记（回答是交付主体，与带标记的过程行分层，
// 也避免与正文里的无序列表圆点混淆）；隐去 [n] 角标（引用关系保留，供来源清单与侧板）。
// token 到达即渲染，不做逐字平滑——平滑的帧节奏与贴底节奏不同步，是滚动抖动的根源。
function AnswerRow({ text, streaming }: { text: string; streaming: boolean }): React.JSX.Element {
  const content = useMemo(() => stripCitations(text, streaming), [text, streaming])
  return (
    <div className="pt-1">
      <Markdown text={content} streaming={streaming} />
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
function UsageChip({
  usage
}: {
  usage: { input: number; output: number; cached: number }
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const total = usage.input + usage.output
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
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
              <span className="tabular-nums text-muted-foreground">
                {usage.cached.toLocaleString()}
              </span>
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
