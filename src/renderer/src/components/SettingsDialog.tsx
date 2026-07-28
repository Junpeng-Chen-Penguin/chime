import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { X, Eye, EyeOff, Check, Loader2, Boxes, BookOpen, Plus, MoreHorizontal, Wrench, Search, MessageCircleQuestion, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ConfirmDialog from './ConfirmDialog'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'detecting' | 'success' | 'error'
type Tab = 'provider' | 'kb' | 'mcp'

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: 'provider', label: '模型服务', icon: Boxes },
  { key: 'kb', label: '知识库', icon: BookOpen },
  { key: 'mcp', label: '工具', icon: Wrench }
]

interface Props {
  open: boolean
  onClose: () => void
  onSaved: (defaultModel: string) => void
  initialTab?: Tab // 外部入口直达分区（如输入框服务状态面板的「前往设置」）
}

export default function SettingsDialog({ open, onClose, onSaved, initialTab }: Props): React.JSX.Element | null {
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [keyInput, setKeyInput] = useState('')
  const [keyMask, setKeyMask] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultWindow, setDefaultWindow] = useState('65536')
  const [tab, setTab] = useState<Tab>('provider')

  const runDetect = useCallback(
    async (keyOverride?: string | null) => {
      const apiKey = keyOverride !== undefined ? keyOverride : keyInput.trim() || null
      setStatus('detecting')
      setError('')
      const r = await window.api.detect({ baseUrl, apiKey })
      if (r.ok && r.models) {
        setModels(r.models)
        setStatus('success')
        setDefaultModel((prev) => (prev && r.models!.includes(prev) ? prev : r.models![0]))
      } else {
        setModels([])
        setStatus('error')
        setError(r.error || '连接失败')
      }
    },
    [baseUrl, keyInput]
  )

  // 打开时载入配置；已配过则自动检测拉取模型
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setTab(initialTab ?? 'provider')
    setStatus('idle')
    setError('')
    setModels([])
    setKeyInput('')
    setShowKey(false)
    window.api.getProvider().then((p) => {
      if (cancelled) return
      setBaseUrl(p.baseUrl)
      setDefaultModel(p.defaultModel)
      setDefaultWindow(String(p.defaultWindow))
      setKeyMask(p.keyMask)
      setHasKey(p.hasKey)
      if (p.hasKey) runDetect(null)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])

  if (!open) return null

  const save = async (): Promise<void> => {
    await window.api.saveProvider({
      baseUrl,
      defaultModel,
      apiKey: keyInput.trim() || null,
      defaultWindow: Math.max(4096, parseInt(defaultWindow, 10) || 65536)
    })
    onSaved(defaultModel)
    onClose()
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[560px] max-h-[88vh] w-[780px] flex-col overflow-hidden rounded-2xl bg-background shadow-2xl"
      >
        <div className="flex h-14 flex-none items-center justify-between border-b border-border px-5">
          <div className="text-[15px] font-semibold">设置</div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[168px] flex-none flex-col gap-1 border-r border-border p-3">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                  tab === key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            {tab === 'kb' ? (
              <KbPanel />
            ) : tab === 'mcp' ? (
              <ToolsPanel initialSub={initialTab === 'mcp' ? 'mcp' : 'builtin'} />
            ) : (
              <>
                <div className="flex-1 overflow-y-auto px-6 py-6">
                  <Section title="平台">
                    <div className="flex items-center gap-2.5 rounded-lg border border-primary/40 bg-primary-soft px-3 py-2.5">
                      <span className="grid size-6 flex-none place-items-center rounded-md bg-primary text-[12px] font-semibold text-primary-foreground">
                        D
                      </span>
                      <span className="text-[14px]">DeepSeek</span>
                    </div>
                  </Section>
                  <Section title="API 密钥">
            <div className="flex gap-2.5">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={hasKey ? keyMask : 'sk-...'}
                  className="h-10 w-full rounded-lg border border-input bg-background pr-10 pl-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
                />
                <button
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <Button onClick={() => runDetect()} disabled={status === 'detecting'} className="h-10 px-5">
                检测
              </Button>
            </div>
            {status === 'detecting' && (
              <StatusLine>
                <Loader2 className="size-3.5 animate-spin" />
                正在检测连接…
              </StatusLine>
            )}
            {status === 'success' && (
              <StatusLine className="text-emerald-600">
                <Check className="size-3.5" />
                连接成功，已获取可用模型
              </StatusLine>
            )}
            {status === 'error' && <StatusLine className="text-destructive">{error}</StatusLine>}
          </Section>

          <Section title="服务地址">
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
            />
          </Section>

          <Section title="上下文窗口" hint="未能自动识别窗口大小的模型按此值估算（token 数）">
            <input
              type="number"
              value={defaultWindow}
              onChange={(e) => setDefaultWindow(e.target.value)}
              className="h-10 w-[200px] rounded-lg border border-input bg-background px-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
            />
          </Section>

          <Section title="模型" hint="检测成功后自动获取，选择一个作为默认模型">
            {models.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
                {status === 'detecting' ? '正在获取模型列表…' : '检测成功后在这里选择默认模型'}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {models.map((m) => {
                  const sel = m === defaultModel
                  return (
                    <button
                      key={m}
                      onClick={() => setDefaultModel(m)}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-3 text-left text-[14px] transition-colors',
                        sel ? 'border-primary/40 bg-primary-soft' : 'border-border hover:bg-muted'
                      )}
                    >
                      <span
                        className={cn(
                          'grid size-[18px] flex-none place-items-center rounded-full border',
                          sel ? 'border-primary' : 'border-muted-foreground/40'
                        )}
                      >
                        {sel && <span className="size-2.5 rounded-full bg-primary" />}
                      </span>
                      <span className="flex-1">{m}</span>
                      {sel && (
                        <span className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                          默认
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </Section>
                </div>

                <div className="flex h-16 flex-none items-center justify-end gap-2.5 border-t border-border px-6">
                  <Button variant="outline" onClick={onClose} className="h-9">
                    取消
                  </Button>
                  <Button onClick={save} disabled={!hasKey && !keyInput.trim()} className="h-9 px-5">
                    保存
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const KB_PHASE_TEXT: Record<string, string> = {
  pulling: '获取最新内容…',
  scanning: '检查内容变动…',
  'downloading-model': '首次准备：下载本地模型…',
  embedding: '导入文档…'
}

function KbPanel(): React.JSX.Element {
  type KbCard = import('../../../preload/index.d').KbCard
  type KbProgress = import('../../../preload/index.d').KbProgress
  const [cards, setCards] = useState<KbCard[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null) // null = 新建
  const [formName, setFormName] = useState('')
  const [formIntro, setFormIntro] = useState('')
  const [formPath, setFormPath] = useState('')
  const [formError, setFormError] = useState('')
  const [formDone, setFormDone] = useState<number | null>(null)
  const [progress, setProgress] = useState<KbProgress | null>(null) // 当前构建进度（全局互斥，同时只有一个）
  const [errors, setErrors] = useState<Record<number, string>>({}) // 库 id → 上次构建失败原因（内存态）
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<KbCard | null>(null)
  const [confirmBuild, setConfirmBuild] = useState<{ card: KbCard; deleted: number; kept: number } | null>(null)
  const showFormRef = useRef(false)

  useEffect(() => {
    showFormRef.current = showForm
  }, [showForm])

  const reload = useCallback(() => {
    window.api.kbList().then(setCards)
  }, [])

  useEffect(() => {
    reload()
    return window.api.onKbProgress((p) => {
      if (p.phase === 'error') {
        setProgress(null)
        if (p.kbId !== undefined) setErrors((m) => ({ ...m, [p.kbId!]: p.message || '构建失败' }))
        if (showFormRef.current) setFormError(p.message || '构建失败')
        reload()
      } else if (p.phase === 'done') {
        setProgress(null)
        if (p.kbId !== undefined)
          setErrors((m) => {
            const { [p.kbId!]: _drop, ...rest } = m
            return rest
          })
        reload()
        if (showFormRef.current) {
          setFormDone(p.stats?.files ?? 0)
          setTimeout(() => {
            setShowForm(false)
            setFormDone(null)
          }, 1400)
        }
      } else {
        setProgress(p)
      }
    })
  }, [reload])

  const anyBuilding = !!progress || cards.some((c) => c.building)

  const openForm = (card: KbCard | null): void => {
    setEditingId(card?.id ?? null)
    setFormName(card?.name ?? '')
    setFormIntro(card?.intro ?? '')
    setFormPath(card?.rootPath ?? '')
    setFormError('')
    setFormDone(null)
    setShowForm(true)
  }

  const submitForm = async (): Promise<void> => {
    setFormError('')
    if (editingId !== null) {
      const r = await window.api.kbUpdate({ id: editingId, name: formName.trim(), intro: formIntro.trim(), path: formPath.trim() })
      if (!r.ok) {
        setFormError(r.error || '保存失败')
        return
      }
      if (!r.rebuilt) {
        reload()
        setShowForm(false)
      }
      // 路径改了：留在表单内看重建进度，done 后自动返回
      return
    }
    const r = await window.api.kbAdd({ name: formName.trim(), intro: formIntro.trim(), path: formPath.trim() })
    if (!r.ok) setFormError(r.error || '创建失败')
    // 成功则留在表单内展示首次构建进度，完成后自动返回
  }

  const pickFolder = async (): Promise<void> => {
    const p = await window.api.kbPickFolder()
    if (p) setFormPath(p)
  }

  const startBuild = async (card: KbCard, force = false): Promise<void> => {
    setErrors((m) => {
      const { [card.id]: _drop, ...rest } = m
      return rest
    })
    const r = await window.api.kbBuild({ id: card.id, force })
    if (!r.ok && r.confirmRequired) {
      setConfirmBuild({ card, ...r.confirmRequired })
    } else if (!r.ok && r.error) {
      setErrors((m) => ({ ...m, [card.id]: r.error! }))
    }
  }

  // ── 表单（新建 / 编辑共用）──
  if (showForm) {
    const formBusy = !!progress || formDone !== null
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-5 text-[15px] font-semibold">{editingId === null ? '新建知识库' : '编辑知识库'}</div>
        <Section title="名称 *">
          <input value={formName} onChange={(e) => setFormName(e.target.value)} disabled={formBusy} className={INPUT_CLS} />
        </Section>
        <Section title="简介 *" hint="模型据此判断问题该不该查这个库">
          <textarea
            value={formIntro}
            onChange={(e) => setFormIntro(e.target.value)}
            disabled={formBusy}
            rows={3}
            placeholder="例：本库收录计费、授权、开通等业务规则与流程，覆盖 A / B 项目"
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-[14px] leading-[1.6] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
          />
        </Section>
        <Section title="文件夹 *" hint={editingId !== null ? '修改后将按新文件夹重新构建' : undefined}>
          <div className="flex gap-2.5">
            <input
              value={formPath}
              onChange={(e) => setFormPath(e.target.value)}
              placeholder="/Users/you/docs"
              disabled={formBusy}
              className="h-10 w-full flex-1 rounded-lg border border-input bg-background px-3 font-mono text-[13px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
            />
            <Button variant="outline" onClick={pickFolder} disabled={formBusy} className="h-10 px-4">
              选择
            </Button>
          </div>
        </Section>

        {formDone !== null ? (
          <StatusLine className="text-emerald-600">
            <Check className="size-3.5" />
            已完成，共 {formDone} 篇文档
          </StatusLine>
        ) : progress ? (
          <>
            <StatusLine>
              <Loader2 className="size-3.5 animate-spin" />
              {KB_PHASE_TEXT[progress.phase] || '处理中…'}
              {progress.phase === 'embedding' && progress.total ? `（${progress.current} / ${progress.total}）` : ''}
              {progress.phase === 'downloading-model' && progress.current ? `${progress.current}%` : ''}
            </StatusLine>
            {progress.file && (
              <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{progress.file}</div>
            )}
          </>
        ) : (
          formError && <StatusLine className="text-destructive">{formError}</StatusLine>
        )}

        {!formBusy && (
          <div className="mt-6 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setShowForm(false)} className="h-9">
              取消
            </Button>
            <Button
              onClick={submitForm}
              disabled={!formPath.trim() || !formName.trim() || !formIntro.trim()}
              className="h-9 px-5"
            >
              {editingId === null ? '创建' : '保存'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ── 卡片状态机（PRD Case 1 功能点 5）──
  const cardStatus = (
    c: KbCard
  ): { line: ReactNode; btn: { label: string; onClick: () => void; disabled?: boolean } | null } => {
    if (c.building && progress) {
      return {
        line: (
          <>
            <StatusLine className="mt-0">
              <Loader2 className="size-3.5 animate-spin" />
              {KB_PHASE_TEXT[progress.phase] || '处理中…'}
              {progress.phase === 'embedding' && progress.total ? `（${progress.current} / ${progress.total}）` : ''}
            </StatusLine>
            {progress.file && (
              <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{progress.file}</div>
            )}
          </>
        ),
        btn: null
      }
    }
    const err = errors[c.id]
    if (c.changes?.folderMissing) {
      return {
        line: (
          <StatusLine className="mt-0 text-destructive">
            文件夹不可用：<span className="font-mono text-[11px]">{c.rootPath}</span>
          </StatusLine>
        ),
        btn: { label: '重新指定文件夹', onClick: () => openForm(c), disabled: anyBuilding }
      }
    }
    if (err || !c.indexedAt) {
      return {
        line: <StatusLine className="mt-0 text-destructive">{err || '尚未完成构建，可重试'}</StatusLine>,
        btn: { label: '重试', onClick: () => startBuild(c), disabled: anyBuilding }
      }
    }
    if (c.changes?.needsFullRebuild) {
      return {
        line: <StatusLine className="mt-0 text-amber-600">切块规则已更新，需重建全部文档</StatusLine>,
        btn: { label: '重建全部', onClick: () => startBuild(c), disabled: anyBuilding }
      }
    }
    const pending = c.changes ? c.changes.added + c.changes.changed + c.changes.deleted : 0
    const time = new Date(c.indexedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
    if (pending > 0) {
      return {
        line: (
          <StatusLine className="mt-0">
            {c.files} 篇文档 · {pending} 个文件有改动，待构建
          </StatusLine>
        ),
        btn: { label: '构建变更', onClick: () => startBuild(c), disabled: anyBuilding }
      }
    }
    return {
      line: (
        <StatusLine className="mt-0 text-emerald-600">
          <Check className="size-3.5" />
          {c.files} 篇文档 · 最近构建 {time} · 已是最新
        </StatusLine>
      ),
      btn: { label: '构建变更', onClick: () => {}, disabled: true }
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[15px] font-semibold">知识库</div>
        <Button variant="outline" onClick={() => openForm(null)} className="h-8 gap-1 px-3 text-[13px]">
          <Plus className="size-3.5" />
          添加知识库
        </Button>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-[14px] font-medium">还没有知识库</div>
          <div className="mt-1 text-[12px] text-muted-foreground">添加后可在对话中选用，基于其内容作答</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((c) => {
            const st = cardStatus(c)
            return (
              <div key={c.id} className="rounded-xl border border-border p-4">
                <div className="flex items-center justify-between">
                  <span className="truncate text-[14px] font-semibold">{c.name}</span>
                  <div className="relative">
                    <button
                      onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                      onBlur={() => setTimeout(() => setMenuFor(null), 120)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                    {menuFor === c.id && (
                      <div className="absolute top-[calc(100%+4px)] right-0 z-20 min-w-[140px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setMenuFor(null)
                            openForm(c)
                          }}
                          disabled={c.building}
                          className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted disabled:opacity-40"
                        >
                          编辑
                        </button>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setMenuFor(null)
                            setConfirmRemove(c)
                          }}
                          disabled={c.building}
                          className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
                        >
                          移除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {c.intro && <div className="mt-1.5 text-[12px] leading-[1.7] text-muted-foreground">{c.intro}</div>}
                <div className="mt-3">{st.line}</div>
                {st.btn && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="outline"
                      onClick={st.btn.onClick}
                      disabled={st.btn.disabled}
                      title={st.btn.disabled && anyBuilding && !c.building ? '等待当前构建完成' : undefined}
                      className="h-8 px-4 text-[13px]"
                    >
                      {st.btn.label}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        title="移除知识库"
        body={`将移除「${confirmRemove?.name ?? ''}」及其已导入的内容（不影响文件夹内的文件）。确定移除？`}
        confirmText="移除"
        onConfirm={async () => {
          if (confirmRemove) await window.api.kbRemove(confirmRemove.id)
          setConfirmRemove(null)
          reload()
        }}
        onCancel={() => setConfirmRemove(null)}
      />
      <ConfirmDialog
        open={!!confirmBuild}
        title="确认构建"
        body={`本次构建将清除 ${confirmBuild?.deleted ?? 0} 篇文档、保留 ${confirmBuild?.kept ?? 0} 篇——文件夹里的大批文档已被删除。清除后不可恢复，确定继续？`}
        confirmText="继续构建"
        onConfirm={async () => {
          if (confirmBuild) await startBuild(confirmBuild.card, true)
          setConfirmBuild(null)
        }}
        onCancel={() => setConfirmBuild(null)}
      />
    </div>
  )
}


// ── MCP 服务分区：卡片只读展示，新建与编辑走同一套表单（延续知识库设置的交互）──────

const INPUT_CLS =
  'h-10 w-full rounded-lg border border-input bg-background px-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50'

// 工具分区：顶部子页签（内置工具 / MCP 服务）——内置再多也不挤压 MCP 的直达入口（Cherry Studio 同构）。
// 「前往设置」深链时落 MCP 页签，正常导航默认落内置工具
function ToolsPanel({ initialSub }: { initialSub: 'builtin' | 'mcp' }): React.JSX.Element {
  const [sub, setSub] = useState<'builtin' | 'mcp'>(initialSub)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none gap-1 px-6 pt-4">
        {(['builtin', 'mcp'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setSub(k)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-[14px] transition-colors',
              sub === k ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {k === 'builtin' ? '内置工具' : 'MCP 服务'}
          </button>
        ))}
      </div>
      {sub === 'builtin' ? <BuiltinToolsPane /> : <McpPanel />}
    </div>
  )
}

// 内置工具：只展示（图标 + 名称 + 一句话用途），无开关无配置——核心体验不属于「可要可不要」；
// 取数等内部支撑工具不进列表（用户无感知也无需决策）
const BUILTIN_TOOLS = [
  { icon: Search, name: '知识库检索', desc: '在你选用的知识库中查找业务资料' },
  { icon: MessageCircleQuestion, name: '向你提问', desc: '缺少关键信息时弹出选择卡片让你定夺' },
  { icon: Table2, name: '生成表格', desc: '成批数据整理成表格，在侧板查看全貌' }
]

function BuiltinToolsPane(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="rounded-lg border border-border">
        {BUILTIN_TOOLS.map((t, i) => (
          <div key={t.name} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
            <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted">
              <t.icon className="size-4 text-muted-foreground" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{t.name}</div>
              <div className="mt-1 text-[13px] text-muted-foreground">{t.desc}</div>
            </div>
            <span className="flex-none text-[12px] text-muted-foreground">默认开启</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function McpPanel(): React.JSX.Element {
  type McpServiceInfo = import('../../../preload/index.d').McpServiceInfo
  type McpTestResult = import('../../../preload/index.d').McpTestResult
  const [list, setList] = useState<McpServiceInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<McpServiceInfo | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<McpServiceInfo | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)
  // 表单态
  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formEnabled, setFormEnabled] = useState(true)
  const [headersText, setHeadersText] = useState('')
  const [headersOriginal, setHeadersOriginal] = useState('') // 编辑时的打码原文：文本没动 = 沿用已存认证
  const [formError, setFormError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(() => {
    window.api.mcpList().then(setList)
  }, [])
  useEffect(() => {
    reload()
    return window.api.onMcpStatus(reload)
  }, [reload])

  const openForm = (svc: McpServiceInfo | null): void => {
    setEditing(svc)
    setFormName(svc?.name ?? '')
    setFormUrl(svc?.url ?? '')
    setFormEnabled(svc?.enabled ?? true)
    const text = svc
      ? Object.entries(svc.headersMasked)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      : ''
    setHeadersText(text)
    setHeadersOriginal(text)
    setFormError('')
    setTestResult(null)
    setShowForm(true)
  }

  // 认证请求头解析：一行一条「名=值」。编辑时文本没动 = 沿用已存（null，与模型服务密钥同一约定）；
  // 动了则须全部重填（打码字符出现在值里即视为没填完整）
  const parseHeaders = ():
    | { ok: true; value: Record<string, string> | null }
    | { ok: false; error: string } => {
    if (editing && headersText === headersOriginal) return { ok: true, value: null }
    const out: Record<string, string> = {}
    for (const line of headersText.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const i = t.indexOf('=')
      if (i <= 0) return { ok: false, error: `这一行看不懂：「${t.slice(0, 30)}」。每行一条，写成 请求头名=值` }
      const v = t.slice(i + 1).trim()
      if (v.includes('•')) return { ok: false, error: '认证值不完整：修改请求头时，值需要全部重新填写' }
      out[t.slice(0, i).trim()] = v
    }
    return { ok: true, value: out }
  }

  const runTest = async (): Promise<void> => {
    const parsed = parseHeaders()
    if (!parsed.ok) {
      setFormError(parsed.error)
      return
    }
    setFormError('')
    setTesting(true)
    setTestResult(null)
    const r = await window.api.mcpTest({ id: editing?.id, url: formUrl.trim(), headers: parsed.value })
    setTestResult(r)
    setTesting(false)
  }

  const submit = async (): Promise<void> => {
    const parsed = parseHeaders()
    if (!parsed.ok) {
      setFormError(parsed.error)
      return
    }
    setFormError('')
    setSaving(true)
    await window.api.mcpSave({
      id: editing?.id,
      name: formName.trim(),
      url: formUrl.trim(),
      headers: parsed.value,
      enabled: formEnabled
    })
    setSaving(false)
    setShowForm(false)
    reload()
  }

  if (showForm) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-5 text-[15px] font-semibold">{editing ? '编辑服务' : '新建服务'}</div>
        <Section title="名称 *">
          <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="例：计费系统" className={INPUT_CLS} />
        </Section>
        <Section title="服务地址 *">
          <input
            value={formUrl}
            onChange={(e) => setFormUrl(e.target.value)}
            placeholder="https://…/mcp"
            className={cn(INPUT_CLS, 'font-mono text-[13px]')}
          />
        </Section>
        <Section
          title="认证请求头"
          hint={editing ? '值已打码；没改动就沿用已保存的，改动则值需全部重填' : '服务方要求的请求头，一行一条'}
        >
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={3}
            placeholder={'Authorization=Bearer <token>'}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[13px] leading-[1.6] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
          />
        </Section>
        <Section title="启用" hint="保存即生效；想先配置后启用，关掉再保存">
          <SwitchBtn on={formEnabled} onToggle={() => setFormEnabled((v) => !v)} />
        </Section>

        {formError && <StatusLine className="text-destructive">{formError}</StatusLine>}
        {testing && (
          <StatusLine>
            <Loader2 className="size-3.5 animate-spin" />
            正在连接服务…
          </StatusLine>
        )}
        {testResult?.ok && (
          <StatusLine className="text-emerald-600">
            <Check className="size-3.5" />
            连接成功，发现 {testResult.toolNames!.length} 个工具：{testResult.toolNames!.join('、')}
          </StatusLine>
        )}
        {testResult && !testResult.ok && (
          <StatusLine className="text-destructive">
            {testResult.auth
              ? '认证失败，请检查认证请求头'
              : '连接失败，请检查服务地址，以及公司网络 / VPN 是否可用'}
          </StatusLine>
        )}

        <div className="mt-6 flex items-center justify-between">
          <Button variant="outline" onClick={runTest} disabled={testing || !formUrl.trim()} className="h-9">
            测试连接
          </Button>
          <div className="flex gap-2.5">
            <Button variant="outline" onClick={() => setShowForm(false)} className="h-9">
              取消
            </Button>
            <Button onClick={submit} disabled={saving || !formName.trim() || !formUrl.trim()} className="h-9 px-5">
              保存
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      {/* 分区名由子页签承担，此处只留操作（同一信息只出现一次） */}
      <div className="mb-4 flex items-center justify-end">
        <Button variant="outline" onClick={() => openForm(null)} className="h-8 gap-1 px-3 text-[13px]">
          <Plus className="size-3.5" />
          添加服务
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-[14px] font-medium">还没有 MCP 服务</div>
          <div className="mt-1 text-[12px] text-muted-foreground">添加后模型可在对话中调用它的工具</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((svc) => (
            <div key={svc.id} className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[14px] font-semibold">{svc.name}</span>
                  <span className="flex-none rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    MCP
                  </span>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  <SwitchBtn
                    on={svc.enabled}
                    onToggle={async () => {
                      await window.api.mcpSave({
                        id: svc.id,
                        name: svc.name,
                        url: svc.url,
                        headers: null,
                        enabled: !svc.enabled
                      })
                      reload()
                    }}
                  />
                  <div className="relative">
                    <button
                      onClick={() => setMenuFor((v) => (v === svc.id ? null : svc.id))}
                      onBlur={() => setTimeout(() => setMenuFor(null), 120)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                    {menuFor === svc.id && (
                      <div className="absolute top-[calc(100%+4px)] right-0 z-20 min-w-[140px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setMenuFor(null)
                            openForm(svc)
                          }}
                          className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                        >
                          编辑
                        </button>
                        <button
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setMenuFor(null)
                            setConfirmDelete(svc)
                          }}
                          className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10"
                        >
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-2">
                {!svc.enabled ? (
                  <StatusLine className="mt-0">已停用</StatusLine>
                ) : svc.status === 'connected' ? (
                  <StatusLine className="mt-0 text-emerald-600">
                    <Check className="size-3.5" />
                    已连接 · {svc.toolCount} 个工具
                  </StatusLine>
                ) : svc.status === 'auth' ? (
                  <StatusLine className="mt-0 text-destructive">认证失效，请更新认证请求头</StatusLine>
                ) : (
                  <StatusLine className="mt-0 text-destructive">
                    连接失败，请检查服务地址，以及公司网络 / VPN 是否可用
                  </StatusLine>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="删除服务"
        body={`将删除「${confirmDelete?.name ?? ''}」。历史会话的调用记录会保留；新对话不再带它的工具。确定删除？`}
        confirmText="删除"
        onConfirm={async () => {
          const id = confirmDelete!.id
          setConfirmDelete(null)
          await window.api.mcpDelete(id)
          reload()
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

// 启停开关（胶囊型），与卡片状态行搭配使用
function SwitchBtn({ on, onToggle }: { on: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      title={on ? '停用' : '启用'}
      className={cn(
        'relative h-5 w-9 flex-none rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-muted-foreground/25'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]',
          on ? 'left-[18px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-7 last:mb-0">
      <div className="mb-2.5 flex items-baseline gap-2">
        <div className="flex-none whitespace-nowrap text-[13px] font-semibold">{title}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function StatusLine({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('mt-2.5 flex items-center gap-1.5 text-[12px] text-muted-foreground', className)}>
      {children}
    </div>
  )
}
