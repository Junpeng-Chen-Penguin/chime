// 上下文占用（018 Case 10）：输入框底部的环形进度圈 + 点开的详情面板。
// 面板形态照 WorkBuddy：大号百分比、已使用 x / y、堆叠条、各分类一行「色点 名称 百分比」，最后是来源分组。
// 数据来自主进程算好的拆分（turn-done 带出，重开会话从会话行取），这里只画不算

import { useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '../../../preload/index.d'
import { cn } from '@/lib/utils'

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

interface Category {
  key: string
  label: string
  tokens: number
  color: string
}

// 计入窗口的分类，按 token 数降序；为 0 的不显示
function categoriesOf(c: ContextUsage): Category[] {
  return [
    { key: 'messages', label: '对话', tokens: c.messages, color: 'bg-primary' },
    { key: 'tools', label: '内置工具', tokens: c.builtinTools, color: 'bg-sky-500' },
    { key: 'mcp', label: 'MCP 工具', tokens: c.mcpTools, color: 'bg-emerald-500' },
    { key: 'skills', label: '技能', tokens: c.skills, color: 'bg-violet-500' },
    { key: 'system', label: '系统提示词', tokens: c.systemPrompt, color: 'bg-amber-500' }
  ]
    .filter((x) => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
}

function usedTokens(c: ContextUsage): number {
  return c.messages + c.builtinTools + c.mcpTools + c.skills + c.systemPrompt
}

const pct = (n: number, w: number): string => `${((n / w) * 100).toFixed(1)}%`

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
  const r = 6
  const circ = 2 * Math.PI * r
  const cats = categoriesOf(context)
  return (
    <div ref={rootRef} className="group relative flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        title=""
        aria-label="上下文占用"
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
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
        </div>
      )}
      {open && (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[320px] rounded-xl border border-border bg-popover p-4 text-[12px] shadow-lg">
          <div className="text-[13px] font-medium">上下文窗口</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[28px] leading-none font-semibold tabular-nums">{pct(used, context.window)}</span>
            <span className="text-muted-foreground">
              已使用 {fmtTokens(shown)} / {fmtTokens(context.window)}
            </span>
          </div>
          {/* 堆叠条：只画计入窗口的分类，空闲留白 */}
          <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            {cats.map((c) => (
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
                <span className={cn('size-2 flex-none rounded-full', c.color)} />
                <span className="flex-1 text-foreground">{c.label}</span>
                <span className="tabular-nums text-muted-foreground">{pct(c.tokens, context.window)}</span>
              </div>
            ))}
            {/* 延迟加载的工具定义不占窗口，只报它省下的量 */}
            {context.deferred.tokens > 0 && (
              <div className="flex items-center gap-2">
                <span className="size-2 flex-none rounded-full border border-muted-foreground/50" />
                <span className="flex-1 text-foreground">MCP 工具（延迟加载）</span>
                <span className="tabular-nums text-muted-foreground">{fmtTokens(context.deferred.tokens)}</span>
              </div>
            )}
          </div>
          {/* 来源分组：点击展开 */}
          {(context.deferred.count > 0 || context.skillItems.length > 0) && (
            <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
              {context.deferred.count > 0 && (
                <Group
                  label="MCP 工具"
                  right={`${context.deferred.count} 个`}
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
                  right={`${context.skillItems.length} 个`}
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
  right: string
  open: boolean
  onToggle: () => void
  rows: { label: string; right: string }[]
}): React.JSX.Element {
  return (
    <div>
      <button onClick={p.onToggle} className="flex w-full items-center gap-2 rounded-md py-0.5 hover:bg-muted">
        <span className="w-2 text-muted-foreground">{p.open ? '⌄' : '›'}</span>
        <span className="flex-1 text-left text-foreground">{p.label}</span>
        <span className="tabular-nums text-muted-foreground">{p.right}</span>
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
