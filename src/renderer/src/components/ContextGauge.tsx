// 上下文占用（018 Case 10）：输入框底部的环形进度圈 + 点开的详情面板。
// 面板样式照 WorkBuddy：大号百分比、已使用 x / y、堆叠条、各行色点；字段沿用产品方案 Case 10：
// 每个分类一行「名称 token 数 百分比」，压缩预留与空闲照列，0 值照常显示，最后是来源分组。
// 数据来自主进程算好的拆分（turn-done 带出，重开会话从会话行取），这里只画不算

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ContextUsage } from '../../../preload/index.d'
import { cn } from '@/lib/utils'

const COMPACT_RESERVE = 33_000 // 与主进程 budget.ts 同值：摘要输出预留 20000 + 缓冲 13000
const WARN_RATIO = 0.8 // 占用到触发线的这个比例，进度圈变警告色

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

interface Category {
  key: string
  label: string
  tokens: number
  color: string // 实心色点与堆叠条的颜色；hollow 时是描边色
  hollow?: boolean
  counted: boolean // 计入窗口（进堆叠条）；延迟加载不计
}

// 分类：内容类按 token 数降序，然后压缩预留与空闲，最后延迟加载；0 值照常显示
function categoriesOf(c: ContextUsage): Category[] {
  const content: Category[] = [
    { key: 'messages', label: '对话', tokens: c.messages, color: 'bg-primary', counted: true },
    { key: 'tools', label: '内置工具', tokens: c.builtinTools, color: 'bg-sky-500', counted: true },
    { key: 'mcp', label: 'MCP 工具', tokens: c.mcpTools, color: 'bg-emerald-500', counted: true },
    { key: 'skills', label: '技能', tokens: c.skills, color: 'bg-violet-500', counted: true },
    { key: 'system', label: '系统提示词', tokens: c.systemPrompt, color: 'bg-amber-500', counted: true }
  ].sort((a, b) => b.tokens - a.tokens)
  const used = content.reduce((s, x) => s + x.tokens, 0)
  const free = Math.max(0, c.window - used - COMPACT_RESERVE)
  return [
    ...content,
    { key: 'reserve', label: '压缩预留', tokens: COMPACT_RESERVE, color: 'bg-muted-foreground/40', counted: true },
    { key: 'free', label: '空闲', tokens: free, color: 'border-border', hollow: true, counted: true },
    {
      key: 'deferred',
      label: 'MCP 工具（延迟加载）',
      tokens: c.deferred.tokens,
      color: 'border-muted-foreground/50',
      hollow: true,
      counted: false
    }
  ]
}

function usedTokens(c: ContextUsage): number {
  return c.messages + c.builtinTools + c.mcpTools + c.skills + c.systemPrompt
}

const pct = (n: number, w: number): string => `${((n / w) * 100).toFixed(1)}%`

function Dot({ c }: { c: Pick<Category, 'color' | 'hollow'> }): React.JSX.Element {
  return (
    <span className={cn('size-2 flex-none rounded-full', c.hollow ? cn('border', c.color) : c.color)} />
  )
}

export function ContextGauge({ context }: { context: ContextUsage | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<'mcp' | 'skills' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  if (!context) return null
  // 已使用用实测（上一轮第一次请求的输入），拿不到时用估算合计；圆环与百分比按估算占窗口的比例
  const used = usedTokens(context)
  const shown = context.actualInput ?? used
  const ratio = Math.min(1, used / context.window)
  // 接近自动压缩（Case 10 Feature 1 功能点 5）：估算占用到触发线的 80% 时圈变警告色。
  // 阈值按触发线不按窗口：触发线占窗口的比例随模型变（1M 是 96.7%，128K 是 74.8%）
  const warn = used >= (context.window - COMPACT_RESERVE) * WARN_RATIO
  const r = 6
  const circ = 2 * Math.PI * r
  const cats = categoriesOf(context)
  return (
    <div ref={rootRef} className="group relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        title=""
        aria-label="上下文占用"
        className={cn(
          'grid size-7 place-items-center rounded-md transition-colors hover:bg-muted',
          warn ? 'text-amber-600' : 'text-muted-foreground'
        )}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={`${circ * ratio} ${circ}`}
            strokeLinecap="round"
          />
        </svg>
      </button>
      {/* 悬停提示：深色一行 */}
      {!open && (
        <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-20 hidden -translate-x-1/2 rounded-md bg-foreground px-2 py-1 text-[11px] whitespace-nowrap text-background group-hover:block">
          上下文 {fmtTokens(shown)} / {fmtTokens(context.window)} ({pct(used, context.window)})
          {warn ? '，接近自动压缩' : ''}
        </div>
      )}
      {/* 面板右边缘对齐进度圈、向左展开：进度圈在输入框右下，左对齐会被窗口右边缘裁掉 */}
      {open && (
        <div className="absolute right-0 bottom-[calc(100%+8px)] z-30 w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-popover p-4 text-[12px] shadow-lg">
          <div className="text-[13px] font-medium">上下文窗口</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[28px] leading-none font-semibold tabular-nums">{pct(used, context.window)}</span>
            <span className="text-muted-foreground">
              已使用 {fmtTokens(shown)} / {fmtTokens(context.window)}
            </span>
          </div>
          {/* 堆叠条：只画计入窗口的分类，空闲留白 */}
          <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {cats
              .filter((c) => c.counted && c.key !== 'free')
              .map((c) => (
                <div
                  key={c.key}
                  className={cn('h-full', c.color)}
                  style={{ width: `${(c.tokens / context.window) * 100}%` }}
                />
              ))}
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {cats.map((c) => (
              <div key={c.key} className="flex items-center gap-2">
                <Dot c={c} />
                <span className="flex-1 text-foreground">{c.label}</span>
                <span className="w-14 text-right tabular-nums text-muted-foreground">{fmtTokens(c.tokens)}</span>
                <span className="w-12 text-right tabular-nums text-muted-foreground">
                  {c.counted ? pct(c.tokens, context.window) : '—'}
                </span>
              </div>
            ))}
          </div>
          {/* 来源分组：第三列是条目数；点击展开。箭头占与色点同宽的格子，两列对齐 */}
          {(context.deferred.count > 0 || context.skillItems.length > 0) && (
            <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
              {context.deferred.count > 0 && (
                <Group
                  label="MCP 工具"
                  tokens={context.mcpTools + context.deferred.tokens}
                  count={context.deferred.count}
                  open={expanded === 'mcp'}
                  onToggle={() => setExpanded((v) => (v === 'mcp' ? null : 'mcp'))}
                  rows={context.deferred.byService.map((s) => ({
                    label: s.name,
                    right: `${s.count} 个工具`
                  }))}
                />
              )}
              {context.skillItems.length > 0 && (
                <Group
                  label="技能"
                  tokens={context.skills}
                  count={context.skillItems.length}
                  open={expanded === 'skills'}
                  onToggle={() => setExpanded((v) => (v === 'skills' ? null : 'skills'))}
                  rows={context.skillItems.map((s) => ({ label: s.name, right: fmtTokens(s.tokens) }))}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Group(p: {
  label: string
  tokens: number
  count: number
  open: boolean
  onToggle: () => void
  rows: { label: string; right: string }[]
}): React.JSX.Element {
  const Chevron = p.open ? ChevronDown : ChevronRight
  return (
    <div>
      <button
        onClick={p.onToggle}
        className="flex w-full items-center gap-2 rounded-md py-0.5 text-left hover:bg-muted"
      >
        <span className="grid size-2 flex-none place-items-center text-muted-foreground">
          <Chevron className="size-3" strokeWidth={2} />
        </span>
        <span className="flex-1 text-foreground">{p.label}</span>
        <span className="w-14 text-right tabular-nums text-muted-foreground">{fmtTokens(p.tokens)}</span>
        <span className="w-12 text-right tabular-nums text-muted-foreground">{p.count}</span>
      </button>
      {p.open && (
        <div className="mt-0.5 flex flex-col gap-0.5 pl-4">
          {p.rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2 text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="tabular-nums">{r.right}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
