import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  Check,
  BookOpen,
  Table2,
  TriangleAlert,
  Wrench,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'

// 工具菜单（Case 8）：勾选 = 本会话选用该 MCP 服务；连接状态就地显示（选用与状态一个载体）
export interface ServiceStatus {
  id: number
  name: string
  status: 'connected' | 'auth' | 'error'
}

export interface KbOption {
  id: number
  name: string
  ready: boolean
  building: boolean
  folderMissing: boolean
}
export interface KbSelEntry {
  id: number
  name: string
}

export interface ModelGroup {
  vendor: string
  name: string
  health: { ok: boolean; reason?: string }
  models: string[]
}

interface Props {
  model: string // vendor:model 引用
  models: ModelGroup[] // 按服务商分组
  onPickModel: (m: string) => void
  sending: boolean
  inputDisabled?: boolean // 等待授权中：输入框禁用，只能操作卡片或点停止
  askWaiting?: boolean // 提问卡等待中：输入框开放，发送 = 中断提问 + 开启新一轮
  value: string
  onChange: (v: string) => void
  chips?: import('../types').ChipRef[] // 待发送的表格行引用（013 Case 2），排在输入区上方
  onRemoveChip?: (idx: number) => void
  onSubmit: () => void
  onStop: () => void
  sessionUsage?: { input: number; output: number; cached: number } | null // 会话累计（正常轮次之和）
  kbOptions: KbOption[]
  kbSel: KbSelEntry[] // 本会话已选的库（锁定态含已移除库的快照名）
  kbLocked: boolean // 会话已定性（发过首条消息）
  onToggleKb: (id: number, name: string) => void
  services?: ServiceStatus[] // 已启用的外部服务及连接状态
  selectedServiceIds?: number[] // 本会话选用的服务（Case 8）
  onToggleService?: (id: number) => void
  onRetryServices?: () => void
  onOpenSettings?: () => void
}

export default function Composer({
  model,
  models,
  onPickModel,
  sending,
  inputDisabled,
  askWaiting,
  value,
  onChange,
  chips,
  onRemoveChip,
  onSubmit,
  onStop,
  sessionUsage,
  kbOptions,
  kbSel,
  kbLocked,
  onToggleKb,
  services,
  selectedServiceIds,
  onToggleService,
  onRetryServices,
  onOpenSettings
}: Props): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [kbMenuOpen, setKbMenuOpen] = useState(false)
  const [svcMenuOpen, setSvcMenuOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const svcList = services ?? []
  const selectedIds = selectedServiceIds ?? []
  const selectedDown = svcList.filter(
    (s) => selectedIds.includes(s.id) && s.status !== 'connected'
  ).length
  const anyDown = svcList.some((s) => s.status !== 'connected')

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
    // 未到最大高度时隐藏滚动条：自动变高下 scrollHeight 与设定高度存在亚像素差，默认 auto 会画出空滚动条
    ta.style.overflowY = ta.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [value])

  // 提问卡等待中输入框开放：有内容时可发送（中断提问、开新一轮），空时右下仍是停止
  const canSend = value.trim().length > 0 && (!sending || askWaiting)
  // 库状态三档（PRD Case 3）：红 = 不可用（已移除 / 尚未构建），黄 = 文件夹不可用（仍可检索），绿 = 正常
  const optById = new Map(kbOptions.map((o) => [o.id, o]))
  const kbStatusOf = (sel: KbSelEntry): { dot: 'red' | 'amber' | 'green'; text: string } => {
    const o = optById.get(sel.id)
    if (!o) return { dot: 'red', text: '已移除' }
    if (!o.ready) return { dot: 'red', text: '尚未构建' }
    if (o.folderMissing) return { dot: 'amber', text: '文件夹不可用' }
    if (o.building) return { dot: 'green', text: '构建中' }
    return { dot: 'green', text: '可用' }
  }
  // 控件报警只算红档：黄档还答得出问题（PRD Case 3 功能点 3）
  const kbUnavailable = kbSel.filter((s) => kbStatusOf(s).dot === 'red').length
  const kbAnyIssue =
    kbSel.some((s) => kbStatusOf(s).dot !== 'green') || kbOptions.some((o) => !o.ready)

  return (
    // 输入框比对话流宽（840 > 内容 760），像托着对话；带柔和阴影浮起，不再是单纯描边
    <div className="flex-none pt-2 pb-4">
      <div className="mx-auto w-full max-w-[840px] px-8">
        <div className="rounded-2xl border border-input bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_28px_-8px_rgba(0,0,0,0.14)] transition focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15">
          {/* 待发送的表格行引用（013 Case 2）：横排、放不下换行；序号即数组下标+1，
              与发给模型的引用块序号一致。点击回看（模块三）尚未接上 */}
          {!!chips?.length && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {chips.map((c, i) => (
                <span
                  key={i}
                  className="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-border bg-muted/60 py-1 pr-1 pl-2 text-[12px]"
                >
                  <Table2 className="size-3.5 flex-none text-muted-foreground" />
                  <span className="flex-none text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 truncate" title={c.title}>
                    {c.title}
                  </span>
                  <span className="flex-none text-muted-foreground">{c.rowIndexes.length} 行</span>
                  <button
                    onClick={() => onRemoveChip?.(i)}
                    title="移除引用"
                    className="grid size-4.5 flex-none place-items-center rounded text-muted-foreground hover:bg-black/10 hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            value={value}
            disabled={inputDisabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              // 输入法合成中（选拼音/英文候选词）的 Enter 是确认候选，不该触发发送
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSubmit()
              }
            }}
            placeholder={
              inputDisabled
                ? '等待授权中，请先处理上方卡片'
                : askWaiting
                  ? '或直接回复……'
                  : 'Chime in…'
            }
            className="block max-h-40 w-full resize-none bg-transparent px-5 pt-4 pb-2.5 text-[14px] leading-[1.6] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between px-3 pb-3">
            {/* 左下：知识库控件（多选）+ 服务状态标识（全部正常时不显示） */}
            <div className="flex items-center gap-1">
              <div className="relative">
                <button
                  onClick={
                    kbOptions.length || kbSel.length ? () => setKbMenuOpen((v) => !v) : undefined
                  }
                  onBlur={() => setTimeout(() => setKbMenuOpen(false), 120)}
                  title={
                    kbOptions.length === 0 && kbSel.length === 0
                      ? '尚无知识库，请到「设置 › 知识库」添加'
                      : kbLocked
                        ? '本会话选用的知识库'
                        : '选择知识库'
                  }
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors',
                    kbOptions.length || kbSel.length
                      ? 'cursor-pointer text-muted-foreground hover:bg-muted'
                      : 'cursor-not-allowed text-muted-foreground/50',
                    kbSel.length === 0 && 'px-1.5'
                  )}
                >
                  {kbUnavailable > 0 ? (
                    <>
                      <TriangleAlert className="size-3.5" />
                      {kbUnavailable} 个知识库不可用
                    </>
                  ) : (
                    <>
                      <BookOpen className="size-4" />
                      {kbSel.length > 0 && kbSel.length}
                    </>
                  )}
                </button>
                {kbMenuOpen && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[260px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                      {kbLocked ? '本会话选用的知识库' : '选择知识库'}
                    </div>
                    {/* 已移除的库（锁定态快照）排在最前，只读展示 */}
                    {kbSel
                      .filter((sel) => !optById.has(sel.id))
                      .map((sel) => (
                        <div
                          key={`gone-${sel.id}`}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] opacity-60"
                        >
                          <span className="grid size-5 flex-none place-items-center rounded-md border border-border bg-muted">
                            <Check className="size-3.5" strokeWidth={3} />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{sel.name}</span>
                          <span className="size-1.5 flex-none rounded-full bg-destructive" />
                          <span className="flex-none text-[12px] text-muted-foreground">
                            已移除
                          </span>
                        </div>
                      ))}
                    {kbOptions.map((o) => {
                      const picked = kbSel.some((sel) => sel.id === o.id)
                      const st = kbStatusOf({ id: o.id, name: o.name })
                      const disabled = kbLocked || (!o.ready && !picked)
                      return (
                        <button
                          key={o.id}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            if (!disabled) onToggleKb(o.id, o.name)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                            disabled ? 'cursor-default opacity-60' : 'hover:bg-muted'
                          )}
                        >
                          {/* 方形勾选框 = 多选（与 MCP 服务菜单同款） */}
                          <span
                            className={cn(
                              'grid size-5 flex-none place-items-center rounded-md border',
                              picked
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border'
                            )}
                          >
                            {picked && <Check className="size-3.5" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{o.name}</span>
                          <span
                            className={cn(
                              'size-1.5 flex-none rounded-full',
                              st.dot === 'green'
                                ? 'bg-emerald-600'
                                : st.dot === 'amber'
                                  ? 'bg-amber-500'
                                  : 'bg-destructive'
                            )}
                          />
                          <span className="flex-none text-[12px] text-muted-foreground">
                            {st.text}
                          </span>
                        </button>
                      )
                    })}
                    {kbAnyIssue && (
                      <div className="mt-1 border-t border-border px-1 pt-1.5">
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setKbMenuOpen(false)
                            onOpenSettings?.()
                          }}
                          className="w-full rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted"
                        >
                          前往设置
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {svcList.length > 0 && (
                <div className="relative">
                  <button
                    onClick={() => setSvcMenuOpen((v) => !v)}
                    onBlur={() => setTimeout(() => setSvcMenuOpen(false), 120)}
                    title="本会话选用的 MCP 服务"
                    className={cn(
                      'flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted',
                      selectedDown === 0 && selectedIds.length === 0 && 'px-1.5'
                    )}
                  >
                    {selectedDown > 0 ? (
                      <>
                        <TriangleAlert className="size-3.5" />
                        {selectedDown} 个服务不可用
                      </>
                    ) : (
                      <>
                        <Wrench className="size-4" />
                        {selectedIds.length > 0 && selectedIds.length}
                      </>
                    )}
                  </button>
                  {svcMenuOpen && (
                    <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[280px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                      <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                        本会话选用的 MCP 服务
                      </div>
                      {svcList.map((s) => {
                        const picked = selectedIds.includes(s.id)
                        return (
                          <button
                            key={s.id}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              onToggleService?.(s.id)
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                          >
                            {/* 方形勾选框 = 多选（与提问卡多选同款；圆形留给单选） */}
                            <span
                              className={cn(
                                'grid size-5 flex-none place-items-center rounded-md border',
                                picked
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-border'
                              )}
                            >
                              {picked && <Check className="size-3.5" strokeWidth={3} />}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{s.name}</span>
                            <span
                              className={cn(
                                'size-1.5 flex-none rounded-full',
                                s.status === 'connected' ? 'bg-emerald-600' : 'bg-destructive'
                              )}
                            />
                            <span className="flex-none text-[12px] text-muted-foreground">
                              {s.status === 'connected'
                                ? '已连接'
                                : s.status === 'auth'
                                  ? '认证失效'
                                  : '连接失败'}
                            </span>
                          </button>
                        )
                      })}
                      <div className="mt-1 flex gap-1 border-t border-border px-1 pt-1.5">
                        {anyDown && (
                          <button
                            onMouseDown={(e) => {
                              e.preventDefault()
                              onRetryServices?.()
                            }}
                            className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted"
                          >
                            重试连接
                          </button>
                        )}
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setSvcMenuOpen(false)
                            onOpenSettings?.()
                          }}
                          className="flex-1 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-muted"
                        >
                          前往设置
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 右下：模型选择（模型名 + ▾）+ 发送 */}
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted"
                >
                  {model.includes(':') ? model.slice(model.indexOf(':') + 1) : model}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
                {menuOpen && models.length > 0 && (
                  <div className="absolute right-0 bottom-[calc(100%+8px)] z-20 min-w-[220px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    {models.map((g) => (
                      <div key={g.vendor}>
                        <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                          {g.name}
                          {!g.health.ok && <TriangleAlert className="size-3 text-amber-500" />}
                        </div>
                        {g.models.map((m) => {
                          const ref = `${g.vendor}:${m}`
                          return (
                            <button
                              key={ref}
                              onMouseDown={(e) => {
                                e.preventDefault()
                                onPickModel(ref)
                                setMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                            >
                              <span className="flex w-3.5 flex-none justify-center">
                                {ref === model && <Check className="size-3.5 text-primary" />}
                              </span>
                              <span>{m}</span>
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {sending && !(askWaiting && value.trim()) ? (
                <button
                  onClick={onStop}
                  title="停止生成"
                  className="grid size-8 place-items-center rounded-lg bg-foreground text-background transition-colors hover:bg-foreground/85"
                >
                  <span className="size-2.5 rounded-[2px] bg-background" />
                </button>
              ) : (
                <button
                  onClick={onSubmit}
                  disabled={!canSend}
                  title="发送"
                  className={cn(
                    'grid size-8 place-items-center rounded-lg text-primary-foreground transition-colors',
                    canSend ? 'bg-primary hover:bg-primary/90' : 'cursor-default bg-primary/50'
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
        </div>
        {/* 会话累计用量（PRD Case 5）：左对齐，悬停看拆分；无正常轮次时不显示 */}
        {sessionUsage && (
          <div className="group relative mt-2 inline-block text-[11px] text-muted-foreground">
            <span className="cursor-default">
              本次会话消耗 {(sessionUsage.input + sessionUsage.output).toLocaleString()} tokens
            </span>
            <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 hidden min-w-[190px] rounded-xl border border-border bg-popover p-3 text-[12px] shadow-lg group-hover:block">
              <div className="flex justify-between gap-8">
                <span className="text-muted-foreground">输入</span>
                <span className="tabular-nums">{sessionUsage.input.toLocaleString()}</span>
              </div>
              {sessionUsage.cached > 0 && (
                <div className="mt-1.5 flex justify-between gap-8">
                  <span className="pl-1 text-muted-foreground">└ 缓存命中</span>
                  <span className="tabular-nums text-muted-foreground">
                    {sessionUsage.cached.toLocaleString()}
                  </span>
                </div>
              )}
              <div className="mt-1.5 flex justify-between gap-8">
                <span className="text-muted-foreground">输出</span>
                <span className="tabular-nums">{sessionUsage.output.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
