import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { X, Eye, EyeOff, Check, Loader2, Boxes, BookOpen, Plus, MoreHorizontal, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ConfirmDialog from './ConfirmDialog'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'detecting' | 'success' | 'error'
type Tab = 'provider' | 'kb'

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: 'provider', label: '模型服务', icon: Boxes },
  { key: 'kb', label: '知识库', icon: BookOpen }
]

interface Props {
  open: boolean
  onClose: () => void
  onSaved: (defaultModel: string) => void
}

export default function SettingsDialog({ open, onClose, onSaved }: Props): React.JSX.Element | null {
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [keyInput, setKeyInput] = useState('')
  const [keyMask, setKeyMask] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
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
    setTab('provider')
    setStatus('idle')
    setError('')
    setModels([])
    setKeyInput('')
    setShowKey(false)
    window.api.getProvider().then((p) => {
      if (cancelled) return
      setBaseUrl(p.baseUrl)
      setDefaultModel(p.defaultModel)
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
    await window.api.saveProvider({ baseUrl, defaultModel, apiKey: keyInput.trim() || null })
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
          <div className="text-[14px] font-semibold">设置</div>
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
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors',
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
            ) : (
              <>
                <div className="flex-1 overflow-y-auto px-6 py-6">
                  <Section title="平台">
                    <div className="flex items-center gap-2.5 rounded-lg border border-primary/40 bg-primary-soft px-3.5 py-2.5">
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

          <Section title="模型" hint="检测成功后自动获取，选择一个作为默认模型">
            {models.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-3.5 text-[13px] text-muted-foreground">
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
                        'flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left text-[14px] transition-colors',
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
  type KbInfo = import('../../../preload/index.d').KbInfo
  type KbProgress = import('../../../preload/index.d').KbProgress
  const [info, setInfo] = useState<KbInfo | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add')
  const [formName, setFormName] = useState('业务知识库')
  const [formPath, setFormPath] = useState('')
  const [formDone, setFormDone] = useState<number | null>(null) // 完成后的文档数提示
  const [progress, setProgress] = useState<KbProgress | null>(null)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const showFormRef = useRef(false)

  useEffect(() => {
    showFormRef.current = showForm
  }, [showForm])

  const reload = useCallback(() => {
    window.api.getKb().then(setInfo)
  }, [])

  useEffect(() => {
    reload()
    return window.api.onKbProgress((p) => {
      if (p.phase === 'error') {
        setProgress(null)
        setError(p.message || '处理失败')
        reload()
      } else if (p.phase === 'done') {
        setProgress(null)
        setError('')
        setWarning(p.warning || '')
        reload()
        // 表单内提交的：先显示成功，再回到列表
        if (showFormRef.current) {
          setFormDone(p.stats?.files ?? 0)
          setTimeout(() => {
            setShowForm(false)
            setFormDone(null)
          }, 1400)
        }
      } else {
        setError('')
        setProgress(p)
      }
    })
  }, [reload])

  const hasKb = !!info?.rootPath
  const busy = !!progress || !!info?.busy
  const ready = !!info?.indexedAt

  const openForm = (mode: 'add' | 'edit'): void => {
    setFormMode(mode)
    setFormName(mode === 'edit' ? (info?.name ?? '') : '业务知识库')
    setFormPath(mode === 'edit' ? (info?.rootPath ?? '') : '')
    setError('')
    setWarning('')
    setFormDone(null)
    setShowForm(true)
  }

  const submitForm = async (): Promise<void> => {
    setError('')
    // 编辑且只改了名称：即存即回，不重新导入
    if (formMode === 'edit' && formPath.trim() === info?.rootPath) {
      if (formName.trim() && formName.trim() !== info?.name) await window.api.kbRename(formName.trim())
      reload()
      setShowForm(false)
      return
    }
    const r = await window.api.kbBuild({ path: formPath.trim(), name: formName.trim() })
    if (!r.ok) setError(r.error || '路径无效')
    // 成功则留在表单内展示进度，完成后自动返回
  }

  const commitName = async (): Promise<void> => {
    setEditingName(false)
    const name = nameDraft.trim()
    if (name && name !== info?.name) {
      await window.api.kbRename(name)
      reload()
    }
  }

  const summaryText = ((): string | null => {
    const su = info?.lastSummary
    if (!su) return null
    if (su.updated === 0 && su.deleted === 0) return '上次同步：已是最新'
    const parts = [`更新 ${su.updated} 篇`, `删除 ${su.deleted} 篇`]
    if (su.skipped > 0) parts.push(`跳过 ${su.skipped} 篇`)
    return `上次同步：${parts.join(' · ')}`
  })()

  // 添加 / 编辑表单：提交后原地显示进度，完成提示成功再返回列表
  if (showForm) {
    const formBusy = !!progress || formDone !== null
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mb-5 text-[14px] font-semibold">
          {formMode === 'add' ? '添加知识库' : '编辑知识库'}
        </div>
        <Section title="名称">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={formBusy}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
          />
        </Section>
        <Section title="来源" hint="本版支持 git 仓库，后续扩展更多来源">
          <div className="flex h-10 w-full items-center justify-between rounded-lg border border-input bg-muted/40 px-3 text-[14px] text-muted-foreground">
            git 仓库（本地路径）
            <ChevronDown className="size-4 opacity-40" />
          </div>
        </Section>
        <Section
          title="仓库路径"
          hint={formMode === 'edit' ? '修改路径后提交，将按新内容重新导入全部文档' : '已 clone 到本机、手动 pull 得通的 git 仓库'}
        >
          <input
            value={formPath}
            onChange={(e) => setFormPath(e.target.value)}
            placeholder="/Users/you/docs-repo"
            disabled={formBusy}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-[13px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
          />
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
              {progress.phase === 'embedding' && progress.total
                ? `（${progress.current} / ${progress.total}）`
                : ''}
              {progress.phase === 'downloading-model' && progress.current ? `${progress.current}%` : ''}
            </StatusLine>
            {progress.file && (
              <div className="mt-1.5 truncate font-mono text-[11.5px] text-muted-foreground">
                {progress.file}
              </div>
            )}
          </>
        ) : (
          error && <StatusLine className="text-destructive">{error}</StatusLine>
        )}

        {!formBusy && (
          <div className="mt-6 flex justify-end gap-2.5">
            <Button variant="outline" onClick={() => setShowForm(false)} className="h-9">
              取消
            </Button>
            <Button onClick={submitForm} disabled={!formPath.trim()} className="h-9 px-5">
              {formMode === 'add' ? '添加' : '提交'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[13.5px] font-semibold">知识库</div>
        <Button
          variant="outline"
          onClick={() => openForm('add')}
          disabled={hasKb}
          title={hasKb ? '本版支持一个知识库' : undefined}
          className="h-8 gap-1 px-3 text-[13px]"
        >
          <Plus className="size-3.5" />
          添加知识库
        </Button>
      </div>

      {!hasKb ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-[14px] font-medium">还没有知识库</div>
          <div className="mt-1 text-[12.5px] text-muted-foreground">
            添加后可在对话中选用，基于其内容作答
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between">
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') setEditingName(false)
                }}
                className="h-7 rounded-md border border-ring bg-background px-2 text-[14px] font-semibold outline-none"
              />
            ) : (
              <button
                onClick={() => {
                  setNameDraft(info!.name)
                  setEditingName(true)
                }}
                title="点击重命名"
                className="-mx-1.5 rounded-md px-1.5 py-0.5 text-[14px] font-semibold transition-colors hover:bg-muted"
              >
                {info!.name}
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
              >
                <MoreHorizontal className="size-4" />
              </button>
              {menuOpen && (
                <div className="absolute top-[calc(100%+4px)] right-0 z-20 min-w-[140px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setMenuOpen(false)
                      openForm('edit')
                    }}
                    disabled={busy}
                    className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted disabled:opacity-40"
                  >
                    编辑
                  </button>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setMenuOpen(false)
                      setConfirmRemove(true)
                    }}
                    disabled={busy}
                    className="w-full rounded-lg px-2.5 py-2 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-40"
                  >
                    移除
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground" title={info!.rootPath}>
            git 仓库 · {info!.rootPath}
          </div>

          <div className="mt-3">
            {busy && progress ? (
              <>
                <StatusLine className="mt-0">
                  <Loader2 className="size-3.5 animate-spin" />
                  {KB_PHASE_TEXT[progress.phase] || '处理中…'}
                  {progress.phase === 'embedding' && progress.total
                    ? `（${progress.current} / ${progress.total}）`
                    : ''}
                </StatusLine>
                {progress.file && (
                  <div className="mt-1.5 truncate font-mono text-[11.5px] text-muted-foreground">
                    {progress.file}
                  </div>
                )}
              </>
            ) : ready ? (
              <>
                <StatusLine className="mt-0 text-emerald-600">
                  <Check className="size-3.5" />
                  {info!.files} 篇文档 · 最近更新{' '}
                  {new Date(info!.indexedAt!).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </StatusLine>
                {summaryText && (
                  <div className="mt-1 text-[12.5px] text-muted-foreground">{summaryText}</div>
                )}
              </>
            ) : (
              <StatusLine className="mt-0 text-destructive">{error || '尚未完成导入，可重试'}</StatusLine>
            )}
            {error && ready && <StatusLine className="text-destructive">{error}</StatusLine>}
            {warning && <StatusLine className="text-amber-600">{warning}</StatusLine>}
          </div>

          <div className="mt-3 flex justify-end">
            {ready || busy ? (
              <Button
                variant="outline"
                onClick={async () => {
                  setWarning('')
                  setError('')
                  const r = await window.api.kbRefresh()
                  if (!r.ok) setError(r.error || '同步失败')
                }}
                disabled={busy}
                className="h-8 px-4 text-[13px]"
              >
                同步
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => window.api.kbBuild({ path: info!.rootPath, name: info!.name })}
                disabled={busy}
                className="h-8 px-4 text-[13px]"
              >
                重试
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="移除知识库"
        body={`将移除「${info?.name ?? ''}」及其已导入的内容（不影响来源仓库本身）。确定移除？`}
        confirmText="移除"
        onConfirm={async () => {
          setConfirmRemove(false)
          await window.api.kbRemove()
          reload()
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
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
        <div className="text-[13.5px] font-semibold">{title}</div>
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
    <div className={cn('mt-2.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground', className)}>
      {children}
    </div>
  )
}
