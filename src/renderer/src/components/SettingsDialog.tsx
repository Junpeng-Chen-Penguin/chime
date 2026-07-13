import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { X, Eye, EyeOff, Check, Loader2, Boxes, BookOpen, Plus, MoreHorizontal, ChevronDown, Wrench, Search, MessageCircleQuestion, Table2 } from 'lucide-react'
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
  type KbInfo = import('../../../preload/index.d').KbInfo
  type KbProgress = import('../../../preload/index.d').KbProgress
  const [info, setInfo] = useState<KbInfo | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formMode, setFormMode] = useState<'add' | 'edit'>('add')
  const [formName, setFormName] = useState('业务知识库')
  const [formIntro, setFormIntro] = useState('')
  const [formPath, setFormPath] = useState('')
  const [formDone, setFormDone] = useState<number | null>(null) // 完成后的文档数提示
  const [progress, setProgress] = useState<KbProgress | null>(null)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
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
    setFormIntro(mode === 'edit' ? (info?.intro ?? '') : '')
    setFormPath(mode === 'edit' ? (info?.rootPath ?? '') : '')
    setError('')
    setWarning('')
    setFormDone(null)
    setShowForm(true)
  }

  const submitForm = async (): Promise<void> => {
    setError('')
    // 编辑且没改路径：只存名称与简介，不重新导入
    if (formMode === 'edit' && formPath.trim() === info?.rootPath) {
      await window.api.kbUpdate({ name: formName.trim(), intro: formIntro.trim() })
      reload()
      setShowForm(false)
      return
    }
    const r = await window.api.kbBuild({
      path: formPath.trim(),
      name: formName.trim(),
      intro: formIntro.trim()
    })
    if (!r.ok) setError(r.error || '路径无效')
    // 成功则留在表单内展示进度，完成后自动返回
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
        <div className="mb-5 text-[15px] font-semibold">
          {formMode === 'add' ? '新建知识库' : '编辑知识库'}
        </div>
        <Section title="名称 *">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={formBusy}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
          />
        </Section>
        <Section title="简介 *" hint="描述这个库讲什么，模型据此判断问题该不该查这个库">
          <textarea
            value={formIntro}
            onChange={(e) => setFormIntro(e.target.value)}
            disabled={formBusy}
            rows={3}
            placeholder="例：本库收录计费、授权、开通等业务规则与流程，覆盖 A / B 项目"
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-[14px] leading-[1.6] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
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
              <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
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
            <Button
              onClick={submitForm}
              disabled={!formPath.trim() || !formName.trim() || !formIntro.trim()}
              className="h-9 px-5"
            >
              {formMode === 'add' ? '创建' : '保存'}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[15px] font-semibold">知识库</div>
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
          <div className="mt-1 text-[12px] text-muted-foreground">
            添加后可在对话中选用，基于其内容作答
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border p-4">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-semibold">{info!.name}</span>
              <span className="flex-none rounded border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                git
              </span>
            </div>
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
          {info!.intro && (
            <div className="mt-1.5 text-[12px] leading-[1.7] text-muted-foreground">
              {info!.intro}
            </div>
          )}

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
                  <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
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
                  <div className="mt-1 text-[12px] text-muted-foreground">{summaryText}</div>
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
                onClick={() =>
                  window.api.kbBuild({ path: info!.rootPath, name: info!.name, intro: info!.intro })
                }
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
