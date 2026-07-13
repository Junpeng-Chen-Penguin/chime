import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, Check, BookOpen, X, TriangleAlert, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

// 工具菜单（Case 8）：勾选 = 本会话选用该 MCP 服务；连接状态就地显示（选用与状态一个载体）
export interface ServiceStatus {
  id: number
  name: string
  status: 'connected' | 'auth' | 'error'
}

function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd
      style={{ fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}
      className="inline-grid h-4 min-w-4 place-items-center rounded border border-border bg-muted px-1 text-[11px] leading-none text-muted-foreground"
    >
      {children}
    </kbd>
  )
}

export type KbState = 'none' | 'busy' | 'ready'

interface Props {
  model: string
  models: string[]
  onPickModel: (m: string) => void
  sending: boolean
  inputDisabled?: boolean // 等待授权中：输入框禁用，只能操作卡片或点停止
  askWaiting?: boolean // 提问卡等待中：输入框开放，发送 = 中断提问 + 开启新一轮
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onStop: () => void
  kbState: KbState
  kbName: string
  kbSelected: boolean
  kbLocked: boolean // 会话已定性（发过首条消息）
  onToggleKb: () => void
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
  onSubmit,
  onStop,
  kbState,
  kbName,
  kbSelected,
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
  const selectedDown = svcList.filter((s) => selectedIds.includes(s.id) && s.status !== 'connected').length
  const anyDown = svcList.some((s) => s.status !== 'connected')

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [value])

  // 提问卡等待中输入框开放：有内容时可发送（中断提问、开新一轮），空时右下仍是停止
  const canSend = value.trim().length > 0 && (!sending || askWaiting)
  const kbDisabledHint =
    kbState === 'none'
      ? '尚无知识库，请到「设置 › 知识库」添加'
      : kbState === 'busy'
        ? '知识库更新中，暂不可选用'
        : '会话已开始，不可再更改'

  return (
    // 输入框比对话流宽（840 > 内容 760），像托着对话；带柔和阴影浮起，不再是单纯描边
    <div className="flex-none pt-2 pb-4">
      <div className="mx-auto w-full max-w-[840px] px-8">
        <div className="rounded-2xl border border-input bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_28px_-8px_rgba(0,0,0,0.14)] transition focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15">
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
            placeholder={inputDisabled ? '等待授权中，请先处理上方卡片' : askWaiting ? '或直接回复……' : 'Chime in…'}
            className="block max-h-40 w-full resize-none bg-transparent px-5 pt-4 pb-2.5 text-[14px] leading-[1.6] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <div className="flex items-center justify-between px-3 pb-3">
            {/* 左下：知识库控件 + 服务状态标识（全部正常时不显示） */}
            <div className="flex items-center gap-1">
            {kbSelected ? (
              <span
                className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted"
                title={kbLocked ? '本会话基于该知识库回答' : '已选用知识库'}
              >
                <BookOpen className="size-4 text-muted-foreground" />
                {kbName}
                {!kbLocked && (
                  <button
                    onClick={onToggleKb}
                    title="取消选用"
                    className="grid size-4 place-items-center rounded-full text-muted-foreground opacity-50 transition-opacity hover:opacity-100"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </span>
            ) : (
              <div className="relative">
                <button
                  onClick={kbState === 'ready' && !kbLocked ? () => setKbMenuOpen((v) => !v) : undefined}
                  onBlur={() => setTimeout(() => setKbMenuOpen(false), 120)}
                  title={kbState === 'ready' && !kbLocked ? '选择知识库' : kbDisabledHint}
                  className={cn(
                    'grid size-8 place-items-center rounded-lg transition-colors',
                    kbState === 'ready' && !kbLocked
                      ? 'cursor-pointer text-muted-foreground hover:bg-muted'
                      : 'cursor-not-allowed text-muted-foreground/50'
                  )}
                >
                  <BookOpen className="size-4" />
                </button>
                {kbMenuOpen && (
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 min-w-[220px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                      选择知识库（本会话内生效）
                    </div>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault()
                        onToggleKb()
                        setKbMenuOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                    >
                      <BookOpen className="size-3.5 flex-none text-muted-foreground" />
                      <span>{kbName}</span>
                    </button>
                  </div>
                )}
              </div>
            )}

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
                              picked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
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
                            {s.status === 'connected' ? '已连接' : s.status === 'auth' ? '认证失效' : '连接失败'}
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
                  {model}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
                {menuOpen && models.length > 0 && (
                  <div className="absolute right-0 bottom-[calc(100%+8px)] z-20 min-w-[220px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                    <div className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                      切换模型（仅当前会话）
                    </div>
                    {models.map((m) => (
                      <button
                        key={m}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          onPickModel(m)
                          setMenuOpen(false)
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                      >
                        <span className="flex w-3.5 flex-none justify-center">
                          {m === model && <Check className="size-3.5 text-primary" />}
                        </span>
                        <span>{m}</span>
                      </button>
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
                    canSend ? 'bg-primary hover:bg-primary/90' : 'cursor-default bg-primary/35'
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Chime 可能会出错，请核对重要信息</span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>⏎</Kbd>Enter 发送
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>⇧</Kbd>
            <Kbd>⏎</Kbd>Shift+Enter 换行
          </span>
        </div>
      </div>
    </div>
  )
}
