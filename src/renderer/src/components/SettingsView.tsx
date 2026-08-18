import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import {
  PanelLeft,
  Eye,
  EyeOff,
  Check,
  Loader2,
  Boxes,
  BookOpen,
  FolderOpen,
  Plus,
  MoreHorizontal,
  Wrench,
  Search,
  MessageCircleQuestion,
  Table2,
  TextSearch,
  TextSelect,
  FileText,
  FolderTree,
  FilePen,
  Replace,
  Bot,
  ChevronLeft,
  ChevronDown,
  Trash2,
  TriangleAlert,
  X,
  Puzzle,
  Code,
  Upload
} from 'lucide-react'
import { Markdown } from './Markdown'
import { estimateTokensBase } from '../../../shared/tokens'
import { BUILTIN_TOOLS } from '../../../shared/builtinTools'
import deepseekIcon from '@/assets/vendors/deepseek.png'
import zhipuIcon from '@/assets/vendors/zhipu.png'

const VENDOR_ICONS: Record<string, string> = { deepseek: deepseekIcon, zhipu: zhipuIcon }
import { Button } from '@/components/ui/button'
import ConfirmDialog from './ConfirmDialog'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'detecting' | 'success' | 'error'
type Tab = 'provider' | 'kb' | 'mcp' | 'skill' | 'agent'

const TABS: { key: Tab; label: string; icon: typeof Boxes }[] = [
  { key: 'provider', label: '模型服务', icon: Boxes },
  { key: 'kb', label: '知识库', icon: BookOpen },
  { key: 'mcp', label: '工具', icon: Wrench },
  { key: 'skill', label: '技能', icon: Puzzle },
  { key: 'agent', label: 'Agent', icon: Bot }
]

interface Props {
  collapsed: boolean // 侧边栏收起时顶栏要自带展开按钮，否则设置页没有出路
  fullscreen: boolean
  onExpand: () => void
  onClose: () => void // Esc 退出设置（回当前会话）；App 侧包了未保存拦截
  onSaved: (defaultModel: string) => void
  onDirtyChange: (dirty: boolean) => void // 有未保存的表单内容时上报，App 在离开入口拦截
  initialTab?: Tab // 外部入口直达分区（如输入框服务状态面板的「前往设置」）
}

// 设置页：占用主区域展示（014 Case 1，原为弹窗——弹窗放不下 Agent 提示词这类长文本编辑）
export default function SettingsView({
  collapsed,
  fullscreen,
  onExpand,
  onClose,
  onSaved,
  onDirtyChange,
  initialTab
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'provider')

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="flex h-full min-w-[480px] flex-1 flex-col overflow-hidden rounded-[12px] border border-border bg-background shadow-[0_1px_2px_rgba(0,0,0,0.03),0_2px_8px_rgba(0,0,0,0.05)]">
      <header
        className={cn(
          'app-drag flex h-[44px] flex-none items-center gap-1',
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
        <div className="text-[15px] font-semibold">设置</div>
      </header>

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

        {/* 切换分区即卸载当前面板，面板卸载时自行把未保存标记复位 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === 'kb' ? (
            <KbPanel onDirtyChange={onDirtyChange} />
          ) : tab === 'mcp' ? (
            <ToolsPanel
              initialSub={initialTab === 'mcp' ? 'mcp' : 'builtin'}
              onDirtyChange={onDirtyChange}
            />
          ) : tab === 'skill' ? (
            <SkillPanel />
          ) : tab === 'agent' ? (
            <AgentPanel onDirtyChange={onDirtyChange} onGoSkills={() => setTab('skill')} />
          ) : (
            <ProviderPanel onSaved={onSaved} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── 模型服务商分区（PRD Case 6）：两栏——左为默认模型入口 + 预置服务商清单，右为选中项配置 ──

function ProviderPanel({
  onSaved
}: {
  onSaved: (defaultModel: string) => void
}): React.JSX.Element {
  type VendorInfo = import('../../../preload/index.d').VendorInfo
  const [list, setList] = useState<VendorInfo[]>([])
  const [sel, setSel] = useState<string>('') // '' = 默认模型页
  const [defaultRef, setDefaultRef] = useState('')

  const reload = useCallback(() => {
    window.api.providerList().then((l) => {
      setList(l)
      setSel((cur) => (cur && !l.some((v) => v.vendor === cur) ? '' : cur))
    })
    window.api.providerGetDefault().then(setDefaultRef)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const cur = list.find((v) => v.vendor === sel) ?? null

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[190px] flex-none flex-col gap-1 overflow-y-auto border-r border-border p-3">
        <button
          onClick={() => setSel('')}
          className={cn(
            'rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
            sel === '' ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
          )}
        >
          默认模型
        </button>
        <div className="mx-1 my-1 border-t border-border" />
        {list.map((v) => (
          <button
            key={v.vendor}
            onClick={() => setSel(v.vendor)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
              sel === v.vendor ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
            )}
          >
            {VENDOR_ICONS[v.vendor] ? (
              <img src={VENDOR_ICONS[v.vendor]} alt="" className="size-6 flex-none rounded-md" />
            ) : (
              <span className="grid size-6 flex-none place-items-center rounded-md bg-primary text-[12px] font-semibold text-primary-foreground">
                {v.name[0]}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{v.name}</span>
            {!v.health.ok && <span className="size-1.5 flex-none rounded-full bg-destructive" />}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {cur ? (
          <VendorPane key={cur.vendor} v={cur} onChanged={reload} />
        ) : (
          <DefaultModelPane
            list={list}
            defaultRef={defaultRef}
            onPick={async (ref) => {
              await window.api.providerSetDefault(ref)
              setDefaultRef(ref)
              onSaved(ref)
            }}
          />
        )}
      </div>
    </div>
  )
}

function DefaultModelPane({
  list,
  defaultRef,
  onPick
}: {
  list: import('../../../preload/index.d').VendorInfo[]
  defaultRef: string
  onPick: (ref: string) => void
}): React.JSX.Element {
  const groups = list.filter((v) => v.enabled && v.models.some((m) => m.picked))
  return (
    <div className="px-6 py-6">
      <div className="mb-4 text-[15px] font-semibold">默认模型</div>
      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
          先在左侧选择一家服务商，填入密钥并启用模型
        </div>
      ) : (
        groups.map((v) => (
          <div key={v.vendor} className="mb-4">
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">{v.name}</div>
            <div className="flex flex-col gap-2">
              {v.models
                .filter((m) => m.picked)
                .map((m) => {
                  const ref = `${v.vendor}:${m.id}`
                  const active = ref === defaultRef
                  return (
                    <button
                      key={ref}
                      onClick={() => onPick(ref)}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-[14px] transition-colors',
                        active
                          ? 'border-primary/40 bg-primary-soft'
                          : 'border-border hover:bg-muted'
                      )}
                    >
                      <span
                        className={cn(
                          'grid size-[18px] flex-none place-items-center rounded-full border',
                          active ? 'border-primary' : 'border-input'
                        )}
                      >
                        {active && <span className="size-2.5 rounded-full bg-primary" />}
                      </span>
                      <span className="flex-1">{m.id}</span>
                    </button>
                  )
                })}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function VendorPane({
  v,
  onChanged
}: {
  v: import('../../../preload/index.d').VendorInfo
  onChanged: () => void
}): React.JSX.Element {
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(v.baseUrl)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [fetching, setFetching] = useState(false)

  // 随填随存：密钥失焦即存（空输入 = 未改动沿用）
  const commitKey = async (): Promise<void> => {
    if (!keyInput.trim()) return
    await window.api.providerSave({ vendor: v.vendor, apiKey: keyInput.trim() })
    onChanged()
  }
  const commitUrl = async (): Promise<void> => {
    if (baseUrl.trim() && baseUrl.trim() !== v.baseUrl) {
      await window.api.providerSave({ vendor: v.vendor, baseUrl: baseUrl.trim() })
      onChanged()
    }
  }

  const runDetect = async (): Promise<void> => {
    await commitKey()
    setStatus('detecting')
    setError('')
    const r = await window.api.providerDetect({ vendor: v.vendor, apiKey: keyInput.trim() || null })
    if (r.ok) {
      setStatus('success')
    } else {
      setStatus('error')
      setError(r.error || '连接失败')
    }
  }

  const fetchModels = async (): Promise<void> => {
    await commitKey()
    setFetching(true)
    setError('')
    const r = await window.api.providerFetchModels(v.vendor)
    setFetching(false)
    if (!r.ok) {
      setStatus('error')
      setError(r.error || '拉取失败')
    } else {
      onChanged()
    }
  }

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div className="text-[15px] font-semibold">{v.name}</div>
        {/* 启用开关：关闭即整家停用，配置保留 */}
        <button
          onClick={async () => {
            await window.api.providerSave({ vendor: v.vendor, enabled: !v.enabled })
            onChanged()
          }}
          className={cn(
            'relative h-6 w-11 flex-none rounded-full transition-colors',
            v.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 size-5 rounded-full bg-white shadow transition-all',
              v.enabled ? 'left-[22px]' : 'left-0.5'
            )}
          />
        </button>
      </div>

      {!v.health.ok && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[12px] text-destructive">
          最近一次请求失败：{v.health.reason || '服务异常'}，请检测密钥或稍后再试
        </div>
      )}

      <Section title="API 密钥">
        <div className="flex gap-2.5">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onBlur={commitKey}
              placeholder={v.hasKey ? v.keyMask : 'sk-...'}
              className="h-10 w-full rounded-lg border border-input bg-background pr-10 pl-3 text-[14px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
            />
            <button
              onClick={() => setShowKey((x) => !x)}
              className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
            >
              {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button
            onClick={runDetect}
            disabled={status === 'detecting' || (!v.hasKey && !keyInput.trim())}
            className="h-10 px-5"
          >
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
            连接成功
          </StatusLine>
        )}
        {status === 'error' && <StatusLine className="text-destructive">{error}</StatusLine>}
      </Section>

      <Section title="服务地址">
        <div className="flex gap-2.5">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={commitUrl}
            className="h-10 w-full flex-1 rounded-lg border border-input bg-background px-3 font-mono text-[13px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
          />
          {baseUrl !== v.defaultBaseUrl && (
            <Button
              variant="outline"
              onClick={async () => {
                setBaseUrl(v.defaultBaseUrl)
                await window.api.providerSave({ vendor: v.vendor, baseUrl: v.defaultBaseUrl })
                onChanged()
              }}
              className="h-10 px-4"
            >
              还原
            </Button>
          )}
        </div>
      </Section>

      <Section title="模型">
        <div className="mb-2">
          <Button
            variant="outline"
            onClick={fetchModels}
            disabled={fetching || (!v.hasKey && !keyInput.trim())}
            className="h-9 px-4"
          >
            {fetching ? '获取中…' : '获取模型列表'}
          </Button>
        </div>
        {v.models.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-3 text-[13px] text-muted-foreground">
            获取后在这里勾选要用的模型
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {v.models.map((m) => {
              const win = v.windows[m.id.toLowerCase()]
              return (
                <button
                  key={m.id}
                  onClick={async () => {
                    await window.api.providerPickModel({
                      vendor: v.vendor,
                      id: m.id,
                      picked: !m.picked
                    })
                    onChanged()
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                >
                  <span
                    className={cn(
                      'grid size-5 flex-none place-items-center rounded-md border',
                      m.picked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border'
                    )}
                  >
                    {m.picked && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{m.id}</span>
                  {m.offline && (
                    <span className="flex-none text-[11px] text-amber-600">已下线</span>
                  )}
                  {win && (
                    <span className="flex-none text-[11px] text-muted-foreground">
                      {win >= 1048576
                        ? `${Math.round(win / 1048576)}M`
                        : `${Math.round(win / 1024)}K`}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}

const KB_PHASE_TEXT: Record<string, string> = {
  pulling: '获取最新内容…',
  scanning: '检查内容变动…',
  'downloading-model': '首次准备：下载本地模型…',
  embedding: '导入文档…'
}

function KbPanel({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }): React.JSX.Element {
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
  const [confirmBuild, setConfirmBuild] = useState<{
    card: KbCard
    deleted: number
    kept: number
  } | null>(null)
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

  const formInit = useRef({ name: '', intro: '', path: '' }) // 打开表单时的初值，未保存判断的基准

  const openForm = (card: KbCard | null): void => {
    setEditingId(card?.id ?? null)
    setFormName(card?.name ?? '')
    setFormIntro(card?.intro ?? '')
    setFormPath(card?.rootPath ?? '')
    formInit.current = {
      name: card?.name ?? '',
      intro: card?.intro ?? '',
      path: card?.rootPath ?? ''
    }
    setFormError('')
    setFormDone(null)
    setShowForm(true)
  }

  // 未保存上报：表单开着且有字段偏离初值才算（构建中/构建完成不算——内容已提交，离开无损失）
  useEffect(() => {
    const i = formInit.current
    onDirtyChange(
      showForm &&
        !progress &&
        formDone === null &&
        (formName !== i.name || formIntro !== i.intro || formPath !== i.path)
    )
  }, [showForm, formName, formIntro, formPath, progress, formDone, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]) // 卸载复位（切分区、退出设置）

  const submitForm = async (): Promise<void> => {
    setFormError('')
    if (editingId !== null) {
      const r = await window.api.kbUpdate({
        id: editingId,
        name: formName.trim(),
        intro: formIntro.trim(),
        path: formPath.trim()
      })
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
    const r = await window.api.kbAdd({
      name: formName.trim(),
      intro: formIntro.trim(),
      path: formPath.trim()
    })
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
        <div className="mb-5 text-[15px] font-semibold">
          {editingId === null ? '新建知识库' : '编辑知识库'}
        </div>
        <Section title="名称 *">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={formBusy}
            className={INPUT_CLS}
          />
        </Section>
        <Section title="简介 *">
          <textarea
            value={formIntro}
            onChange={(e) => setFormIntro(e.target.value)}
            disabled={formBusy}
            rows={3}
            placeholder="这个库收录哪些内容、覆盖什么范围"
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-[14px] leading-[1.6] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
          />
        </Section>
        <Section
          title="文件夹 *"
          hint={editingId !== null ? '修改后将按新文件夹重新构建' : undefined}
        >
          <div className="flex gap-2.5">
            <input
              value={formPath}
              onChange={(e) => setFormPath(e.target.value)}
              placeholder="/Users/you/docs"
              disabled={formBusy}
              className="h-10 w-full flex-1 rounded-lg border border-input bg-background px-3 font-mono text-[13px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15 disabled:opacity-50"
            />
            <Button
              variant="outline"
              onClick={pickFolder}
              disabled={formBusy}
              className="h-10 px-4"
            >
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
              {progress.phase === 'embedding' && progress.total
                ? `（${progress.current} / ${progress.total}）`
                : ''}
              {progress.phase === 'downloading-model' && progress.current
                ? `${progress.current}%`
                : ''}
            </StatusLine>
            {progress.file && (
              <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                {progress.file}
              </div>
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
  ): {
    line: ReactNode
    btn: { label: string; onClick: () => void; disabled?: boolean } | null
  } => {
    if (c.building && progress) {
      return {
        line: (
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
        line: (
          <StatusLine className="mt-0 text-destructive">{err || '尚未完成构建，可重试'}</StatusLine>
        ),
        btn: { label: '重试', onClick: () => startBuild(c), disabled: anyBuilding }
      }
    }
    if (c.changes?.needsFullRebuild) {
      return {
        line: (
          <StatusLine className="mt-0 text-amber-600">切块规则已更新，需重建全部文档</StatusLine>
        ),
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
          {c.files} 篇文档 · 最近构建 {time}
        </StatusLine>
      ),
      btn: { label: '构建变更', onClick: () => {}, disabled: true }
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[15px] font-semibold">知识库</div>
        <Button
          variant="outline"
          onClick={() => openForm(null)}
          className="h-8 gap-1 px-3 text-[13px]"
        >
          <Plus className="size-3.5" />
          添加知识库
        </Button>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-[14px] font-medium">还没有知识库</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            添加后可在对话中选用，基于其内容作答
          </div>
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
                {c.intro && (
                  <div className="mt-1.5 text-[12px] leading-[1.7] text-muted-foreground">
                    {c.intro}
                  </div>
                )}
                <div className="mt-3">{st.line}</div>
                {st.btn && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="outline"
                      onClick={st.btn.onClick}
                      disabled={st.btn.disabled}
                      title={
                        st.btn.disabled && anyBuilding && !c.building
                          ? '等待当前构建完成'
                          : undefined
                      }
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
function ToolsPanel({
  initialSub,
  onDirtyChange
}: {
  initialSub: 'builtin' | 'mcp'
  onDirtyChange: (d: boolean) => void
}): React.JSX.Element {
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
              sub === k
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted'
            )}
          >
            {k === 'builtin' ? '内置工具' : 'MCP 服务'}
          </button>
        ))}
      </div>
      {sub === 'builtin' ? <BuiltinToolsPane /> : <McpPanel onDirtyChange={onDirtyChange} />}
    </div>
  )
}

// 内置工具：只展示（图标 + 中文名 + 函数名 + 一句话用途），无开关无配置（PRD Case 4）。
// 名称与用途来自登记表（与时间线、测试记录同一份）；函数名一并展示——写用例断言时照抄
// 图标跟随工具的实际能力（验收意见 2026-08-18）：检索放大镜、结果集搜/读成对、
// 文件读/列/写/改各自成形，激活技能与设置的技能分区同用拼图
const TOOL_ICONS: Record<string, typeof Search> = {
  search_knowledge_base: Search,
  ask_user_question: MessageCircleQuestion,
  create_artifact: Table2,
  grep_result: TextSearch,
  read_result: TextSelect,
  read_file: FileText,
  list_dir: FolderTree,
  write_file: FilePen,
  edit_file: Replace,
  activate_skill: Puzzle
}

function BuiltinToolsPane(): React.JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="rounded-lg border border-border">
        {BUILTIN_TOOLS.map((t, i) => {
          const Icon = TOOL_ICONS[t.name] ?? Search
          return (
            <div
              key={t.name}
              className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}
            >
              <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-medium">{t.display}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{t.name}</span>
                </div>
                <div className="mt-1 text-[13px] text-muted-foreground">{t.desc}</div>
              </div>
              <span className="flex-none text-[12px] text-muted-foreground">默认开启</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function McpPanel({ onDirtyChange }: { onDirtyChange: (d: boolean) => void }): React.JSX.Element {
  type McpServiceInfo = import('../../../preload/index.d').McpServiceInfo
  type McpTestResult = import('../../../preload/index.d').McpTestResult
  const [list, setList] = useState<McpServiceInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<McpServiceInfo | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<McpServiceInfo | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null) // 启停进行中的服务（连接/断开有秒级过程，无反馈会误以为没点上）
  const [trustBusyId, setTrustBusyId] = useState<number | null>(null) // 信任开关处理中
  const [confirmTrust, setConfirmTrust] = useState<{ id: number; name: string } | null>(null) // 开启信任的确认弹窗（011 Case 4：关键告知走弹窗，页面不放说明文案）
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

  const formInit = useRef({ name: '', url: '', enabled: true, headers: '' }) // 打开表单时的初值，未保存判断的基准

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
    formInit.current = {
      name: svc?.name ?? '',
      url: svc?.url ?? '',
      enabled: svc?.enabled ?? true,
      headers: text
    }
    setFormError('')
    setTestResult(null)
    setShowForm(true)
  }

  // 未保存上报：表单开着且有字段偏离初值才算（保存进行中不算）
  useEffect(() => {
    const i = formInit.current
    onDirtyChange(
      showForm &&
        !saving &&
        (formName !== i.name ||
          formUrl !== i.url ||
          formEnabled !== i.enabled ||
          headersText !== i.headers)
    )
  }, [showForm, formName, formUrl, formEnabled, headersText, saving, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]) // 卸载复位（切分区、切子页签、退出设置）

  // 认证请求头解析：一行一条「名=值」。编辑时文本没动 = 沿用已存（null，与模型服务密钥同一约定）；
  // 动了则须全部重填（打码字符出现在值里即视为没填完整）
  const parseHeaders = ():
    { ok: true; value: Record<string, string> | null } | { ok: false; error: string } => {
    if (editing && headersText === headersOriginal) return { ok: true, value: null }
    const out: Record<string, string> = {}
    for (const line of headersText.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const i = t.indexOf('=')
      if (i <= 0)
        return {
          ok: false,
          error: `请求头格式不正确：「${t.slice(0, 30)}」。每行一条，格式为 请求头名=值，如 Authorization=Bearer xxx`
        }
      const v = t.slice(i + 1).trim()
      if (v.includes('•'))
        return { ok: false, error: '认证值不完整：修改请求头时，值需要全部重新填写' }
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
    const r = await window.api.mcpTest({
      id: editing?.id,
      url: formUrl.trim(),
      headers: parsed.value
    })
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
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="服务名称"
            className={INPUT_CLS}
          />
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
          hint={editing ? '值已打码；没改动就沿用已保存的，改动则值需全部重填' : '一行一条'}
        >
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            rows={3}
            placeholder={'Authorization=Bearer <token>'}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[13px] leading-[1.6] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
          />
        </Section>
        <Section title="启用">
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
          <Button
            variant="outline"
            onClick={runTest}
            disabled={testing || !formUrl.trim()}
            className="h-9"
          >
            测试连接
          </Button>
          <div className="flex gap-2.5">
            <Button variant="outline" onClick={() => setShowForm(false)} className="h-9">
              取消
            </Button>
            <Button
              onClick={submit}
              disabled={saving || !formName.trim() || !formUrl.trim()}
              className="h-9 px-5"
            >
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
        <Button
          variant="outline"
          onClick={() => openForm(null)}
          className="h-8 gap-1 px-3 text-[13px]"
        >
          <Plus className="size-3.5" />
          添加服务
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="text-[14px] font-medium">还没有 MCP 服务</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            添加后模型可在对话中调用它的工具
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((svc) => (
            <div key={svc.id} className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[14px] font-semibold">{svc.name}</span>
                </div>
                <div className="flex flex-none items-center gap-1.5">
                  <SwitchBtn
                    on={svc.enabled}
                    busy={busyId === svc.id}
                    onToggle={async () => {
                      if (busyId !== null) return
                      setBusyId(svc.id)
                      try {
                        await window.api.mcpSave({
                          id: svc.id,
                          name: svc.name,
                          url: svc.url,
                          headers: null,
                          enabled: !svc.enabled
                        })
                        reload()
                      } finally {
                        setBusyId(null)
                      }
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
                        {svc.enabled && (
                          <button
                            onMouseDown={(e) => {
                              e.preventDefault()
                              setMenuFor(null)
                              if (!svc.trusted) {
                                setConfirmTrust({ id: svc.id, name: svc.name })
                                return
                              }
                              void (async () => {
                                setTrustBusyId(svc.id)
                                try {
                                  await window.api.mcpSetTrusted({ id: svc.id, trusted: false })
                                  reload()
                                } finally {
                                  setTrustBusyId(null)
                                }
                              })()
                            }}
                            className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
                          >
                            信任只读声明
                            {svc.trusted && <Check className="size-3.5 text-primary" />}
                          </button>
                        )}
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
                {busyId === svc.id || trustBusyId === svc.id ? (
                  <StatusLine className="mt-0">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在处理…
                  </StatusLine>
                ) : !svc.enabled ? (
                  <StatusLine className="mt-0">已停用</StatusLine>
                ) : svc.status === 'connected' ? (
                  <StatusLine className="mt-0 text-emerald-600">
                    <Check className="size-3.5" />
                    已连接 · {svc.toolCount} 个工具
                  </StatusLine>
                ) : svc.status === 'auth' ? (
                  <StatusLine className="mt-0 text-destructive">
                    认证失效，请更新认证请求头
                  </StatusLine>
                ) : (
                  <StatusLine className="mt-0 text-destructive">
                    连接失败，请检查服务地址，以及公司网络 / VPN 是否可用
                  </StatusLine>
                )}
                {svc.enabled && svc.toolsChanged && (
                  <StatusLine className="text-amber-600">
                    ⚠ 工具清单已变更
                    <button
                      onClick={() => {
                        // 检测更新 = 清变更标记 + 重连刷新工具清单（拿到的就是当前最新）
                        void window.api
                          .mcpAckToolsChanged(svc.id)
                          .then(() => window.api.mcpRetry())
                          .then(reload)
                      }}
                      className="ml-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground underline-offset-2 hover:underline"
                    >
                      检测更新
                    </button>
                  </StatusLine>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTrust}
        title="开启只读信任？"
        body="开启后，该服务声明为只读的工具将直接执行、不再逐次确认；写操作仍每次确认。服务的工具清单发生变更时会自动关闭。"
        confirmText="开启"
        onConfirm={async () => {
          const id = confirmTrust!.id
          setConfirmTrust(null)
          setTrustBusyId(id)
          try {
            await window.api.mcpSetTrusted({ id, trusted: true })
            reload()
          } finally {
            setTrustBusyId(null)
          }
        }}
        onCancel={() => setConfirmTrust(null)}
      />
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

// 启停开关（胶囊型），与卡片状态行搭配使用；busy 期间禁点防重复触发
function SwitchBtn({
  on,
  onToggle,
  busy
}: {
  on: boolean
  onToggle: () => void
  busy?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      title={on ? '停用' : '启用'}
      className={cn(
        'relative h-5 w-9 flex-none rounded-full transition-colors',
        on ? 'bg-primary' : 'bg-muted-foreground/25',
        busy && 'opacity-50'
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
  const required = title.endsWith('*')
  const label = required ? title.slice(0, -1).trim() : title
  return (
    <div className="mb-7 last:mb-0">
      <div className="mb-2.5 flex items-baseline gap-2">
        <div className="flex-none whitespace-nowrap text-[13px] font-semibold">
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </div>
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
    <div
      className={cn(
        'mt-2.5 flex items-center gap-1.5 text-[12px] text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}

// ── Agent 分区（014 Case 2）：列表 / 编辑两态。Agent = 提示词 + 知识库 + MCP 服务的命名组合 ──

// 提示词预填骨架：括号里是引导文字，用户写时替换；不需要的标题自行删除。
// 所见即所得：编辑框里是什么就存什么、token 数按实际内容算，不做「没动过骨架按空存」的特判
const AGENT_PROMPT_SKELETON = `你是XXX，负责XXX。

## 我能做什么
（写清楚这个 Agent 具体能办哪些事，一条一行）

## 我不做什么
（哪些问题不归它管，遇到了该怎么回）

## 业务背景
（模型不可能知道的业务常识、术语、系统之间的关系）

## 回答规矩
（回答时要遵守的具体规则，比如涉及价格不给具体数字，让用户找商务确认）
`

// ── 技能分区（015 Case 4）：列表两列（技能、最近更新）+ 明细页（只读）+ 导入弹窗，界面照 Claude 桌面端技能页 ──
function SkillPanel(): React.JSX.Element {
  type SkillInfo = import('../../../preload/index.d').SkillInfo
  type SkillDetail = import('../../../preload/index.d').SkillDetail
  type AgentInfo = import('../../../preload/index.d').AgentInfo

  const [list, setList] = useState<SkillInfo[]>([])
  const [agents, setAgents] = useState<AgentInfo[]>([]) // 删除确认的受影响 Agent 数（renderer 现算）
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [conflict, setConflict] = useState<{ name: string; path: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false) // 明细页 ⋮
  const [fileMenuOpen, setFileMenuOpen] = useState(false) // 明细页文件切换
  const [fileIdx, setFileIdx] = useState(0)
  const [viewSrc, setViewSrc] = useState(false) // 渲染 / 源码
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const reload = useCallback(() => {
    window.api.skillList().then(setList)
    window.api.agentList().then(setAgents)
  }, [])
  useEffect(() => {
    reload()
  }, [reload])

  const doImport = async (path?: string, overwrite?: boolean): Promise<void> => {
    const r = await window.api.skillImport({ path, overwrite })
    if (!r) return // 用户取消了系统选择框
    if ('ok' in r) {
      setImportOpen(false)
      setImportErrors([])
      setConflict(null)
      reload()
    } else if ('conflict' in r) {
      setConflict({ name: r.conflict, path: r.path })
    } else {
      setImportErrors(r.errors)
    }
  }

  const openDetail = async (name: string): Promise<void> => {
    const d = await window.api.skillGet(name)
    if (!d) return
    setFileIdx(0)
    setViewSrc(false)
    setDetail(d)
  }

  // ── 明细页 ──
  if (detail) {
    const file = detail.files[fileIdx] ?? detail.files[0]
    const affected = agents.filter((a) => a.skillSel.includes(detail.name)).length
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center px-6 pt-5 pb-2">
          <button
            onClick={() => setDetail(null)}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            技能
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[16px] font-semibold">
                {detail.name}
                {detail.hasScripts && (
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
                    含脚本
                  </span>
                )}
              </div>
              <div className="mt-1 text-[13px] leading-[1.7] text-muted-foreground">
                {detail.description}
              </div>
            </div>
            <div className="relative flex-none">
              <button
                onClick={() => setMenuOpen((o) => !o)}
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-[120px] rounded-lg border border-border bg-background p-1 shadow-lg">
                    <button
                      onClick={() => {
                        setMenuOpen(false)
                        setConfirmDelete(detail.name)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/5"
                    >
                      <Trash2 className="size-3.5" />
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 内容卡：文件切换 + 渲染/源码切换，全程只读（修改走外部编辑后重新导入） */}
          <div className="mt-4 rounded-xl border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <div className="relative">
                <button
                  onClick={() => setFileMenuOpen((o) => !o)}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] transition-colors hover:bg-muted"
                >
                  {file?.path ?? 'SKILL.md'}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </button>
                {fileMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setFileMenuOpen(false)} />
                    <div className="absolute left-0 z-20 mt-1 max-h-[280px] w-max min-w-[180px] overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-lg">
                      {detail.files.map((f, i) => (
                        <button
                          key={f.path}
                          onClick={() => {
                            setFileIdx(i)
                            setFileMenuOpen(false)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-muted',
                            i === fileIdx && 'font-medium'
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{f.path}</span>
                          {i === fileIdx && <Check className="size-3.5 flex-none text-primary" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <span className="text-[12px] text-muted-foreground">
                {detail.files.length} 个文件
              </span>
              <div className="flex-1" />
              <button
                onClick={() => setViewSrc(false)}
                title="渲染视图"
                className={cn(
                  'grid size-7 place-items-center rounded-md transition-colors',
                  !viewSrc ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                )}
              >
                <Eye className="size-4" />
              </button>
              <button
                onClick={() => setViewSrc(true)}
                title="源码视图"
                className={cn(
                  'grid size-7 place-items-center rounded-md transition-colors',
                  viewSrc ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'
                )}
              >
                <Code className="size-4" />
              </button>
            </div>
            <div className="px-4 py-3">
              {file?.content == null ? (
                <div className="py-6 text-center text-[13px] text-muted-foreground">
                  该文件不支持预览
                </div>
              ) : viewSrc || !file.path.endsWith('.md') ? (
                <pre className="overflow-x-auto text-[12.5px] leading-[1.7] whitespace-pre-wrap select-text">
                  {file.content}
                </pre>
              ) : (
                <div className="select-text">
                  {/* 渲染视图剥掉 YAML 头（验收意见）：头部信息页面顶部已展示，直出会被挤成一段粗体；源码视图保留全文 */}
                  <Markdown text={file.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')} />
                </div>
              )}
            </div>
          </div>
        </div>

        <ConfirmDialog
          open={!!confirmDelete}
          title="删除技能"
          body={
            affected > 0
              ? `删除「${confirmDelete ?? ''}」？${affected} 个 Agent 添加了它，删除后将从这些 Agent 的技能清单中剔除。`
              : `删除「${confirmDelete ?? ''}」？删除后不可恢复。`
          }
          confirmText="删除"
          onConfirm={async () => {
            if (confirmDelete) await window.api.skillDelete(confirmDelete)
            setConfirmDelete(null)
            setDetail(null)
            reload()
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      </div>
    )
  }

  // ── 列表视图 ──
  const shown = list.filter(
    (s) => !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase())
  )
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[15px] font-semibold">技能</div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索"
              className="h-8 w-[160px] rounded-lg border border-input bg-background pr-2 pl-8 text-[13px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setImportErrors([])
              setImportOpen(true)
            }}
            className="h-8 gap-1 px-3 text-[13px]"
          >
            <Plus className="size-4" />
            导入
          </Button>
        </div>
      </div>

      {/* 空库只给一句通用文案（验收拍板），不显示表头也不加解释 */}
      {list.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-muted-foreground">暂无技能</div>
      ) : (
        <div className="rounded-xl border border-border">
          <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-[12px] font-medium text-muted-foreground">
            <span className="min-w-0 flex-1">技能</span>
            <span className="w-[96px] flex-none">最近更新</span>
          </div>
          <div className="divide-y divide-border">
            {shown.map((s) => (
              <button
                key={s.name}
                onClick={() => void openDetail(s.name)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-muted/50"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-medium">{s.name}</span>
                  {s.hasScripts && (
                    <span className="flex-none rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      含脚本
                    </span>
                  )}
                </span>
                <span className="w-[96px] flex-none text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </span>
              </button>
            ))}
            {!shown.length && !!q.trim() && (
              <div className="px-4 py-3 text-[13px] text-muted-foreground">未找到匹配结果</div>
            )}
          </div>
        </div>
      )}

      {/* 导入弹窗（功能点 4）：拖放区 + 点击选择 + 文件要求；失败原因就地显示（功能点 6） */}
      {importOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
          <div className="w-[400px] rounded-xl border border-border bg-background p-5 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-[15px] font-semibold">导入技能</div>
              <button
                onClick={() => setImportOpen(false)}
                className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                const f = e.dataTransfer.files[0]
                if (!f) return
                try {
                  const p = window.api.pathForFile(f)
                  if (p) void doImport(p)
                  else setImportErrors(['无法获取拖入项的路径，请点击选择'])
                } catch {
                  setImportErrors(['无法获取拖入项的路径，请点击选择'])
                }
              }}
              onClick={() => void doImport()}
              className={cn(
                'grid cursor-pointer place-items-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
                dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
              )}
            >
              <Upload className="mb-2 size-5 text-muted-foreground" />
              <div className="text-[13px]">拖入技能文件夹或 zip，或点击选择</div>
            </div>
            {importErrors.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {importErrors.map((e, i) => (
                  <div key={i} className="text-[13px] text-destructive">
                    {e}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4">
              <div className="mb-1 text-[12px] font-medium text-muted-foreground">文件要求</div>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12px] text-muted-foreground">
                <li>SKILL.md 的 YAML 头须含 name 与 description</li>
                <li>文件夹或 zip 内须有 SKILL.md</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 重名覆盖确认（功能点 5 第 4 步）：覆盖就是技能的更新方式 */}
      <ConfirmDialog
        open={!!conflict}
        title="覆盖同名技能"
        body={`已有同名技能「${conflict?.name ?? ''}」，用导入的这份覆盖吗？`}
        confirmText="覆盖"
        onConfirm={() => {
          if (conflict) void doImport(conflict.path, true)
        }}
        onCancel={() => setConflict(null)}
      />
    </div>
  )
}

function AgentPanel({
  onDirtyChange,
  onGoSkills
}: {
  onDirtyChange: (d: boolean) => void
  onGoSkills: () => void
}): React.JSX.Element {
  type AgentInfo = import('../../../preload/index.d').AgentInfo
  type KbCard = import('../../../preload/index.d').KbCard
  type McpServiceInfo = import('../../../preload/index.d').McpServiceInfo
  type SelEntry = { id: number; name: string }

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [kbs, setKbs] = useState<KbCard[]>([])
  const [services, setServices] = useState<McpServiceInfo[]>([])
  const [skills, setSkills] = useState<import('../../../preload/index.d').SkillInfo[]>([])
  const [editing, setEditing] = useState<{ id?: number } | null>(null) // null = 列表；{} = 新建；{id} = 编辑
  const [sub, setSub] = useState<'base' | 'prompt' | 'kb' | 'tools' | 'skill'>('base') // 编辑页内的分类导航
  const [formName, setFormName] = useState('')
  const [formPrompt, setFormPrompt] = useState('')
  const [formKbSel, setFormKbSel] = useState<SelEntry[]>([])
  const [formMcpSel, setFormMcpSel] = useState<SelEntry[]>([])
  const [formWsSel, setFormWsSel] = useState<string[]>([]) // 默认工作空间（015 Case 1）
  const [formSkillSel, setFormSkillSel] = useState<string[]>([]) // 技能（015，C4 出界面前仅透传保存）
  const [wsError, setWsError] = useState('') // 「已在授权范围内」提示
  const [wsMissing, setWsMissing] = useState<string[]>([]) // 已失效（磁盘上不存在）的已配目录
  const [formError, setFormError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<{
    id: number
    name: string
    usage: number
  } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<{
    kind: 'kb' | 'mcp' | 'skill'
    id: number | string
    name: string
  } | null>(null)
  const formInit = useRef({ name: '', prompt: '', kb: '[]', mcp: '[]', ws: '[]', skill: '[]' })

  const reload = useCallback(() => {
    window.api.agentList().then(setAgents)
    window.api.kbList().then(setKbs)
    window.api.mcpList().then(setServices)
    window.api.skillList().then(setSkills)
  }, [])
  useEffect(() => {
    reload()
  }, [reload])

  // 未保存上报：编辑视图开着且有字段偏离初值
  useEffect(() => {
    const i = formInit.current
    onDirtyChange(
      editing !== null &&
        (formName !== i.name ||
          formPrompt !== i.prompt ||
          JSON.stringify(formKbSel) !== i.kb ||
          JSON.stringify(formMcpSel) !== i.mcp ||
          JSON.stringify(formWsSel) !== i.ws ||
          JSON.stringify(formSkillSel) !== i.skill)
    )
  }, [editing, formName, formPrompt, formKbSel, formMcpSel, formWsSel, formSkillSel, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const openEdit = (a: AgentInfo | null): void => {
    setFormName(a?.name ?? '')
    setFormPrompt(a?.prompt ?? AGENT_PROMPT_SKELETON)
    setFormKbSel(a?.kbSel ?? [])
    setFormMcpSel(a?.mcpSel ?? [])
    setFormWsSel(a?.wsSel ?? [])
    setFormSkillSel(a?.skillSel ?? [])
    setWsMissing(a?.wsMissing ?? [])
    // 失效状态现查（验收意见 #2：列表缓存慢一拍——目录刚在磁盘上改名，第一次进来要立即看到）
    if (a)
      void window.api.agentList().then((l) => {
        const fresh = l.find((x) => x.id === a.id)
        if (fresh) setWsMissing(fresh.wsMissing ?? [])
      })
    setWsError('')
    formInit.current = {
      name: a?.name ?? '',
      prompt: a?.prompt ?? AGENT_PROMPT_SKELETON,
      kb: JSON.stringify(a?.kbSel ?? []),
      mcp: JSON.stringify(a?.mcpSel ?? []),
      ws: JSON.stringify(a?.wsSel ?? []),
      skill: JSON.stringify(a?.skillSel ?? [])
    }
    setFormError('')
    setSub('base')
    setEditing(a ? { id: a.id } : {})
  }

  // 添加默认工作空间：亲手选文件夹；重复或已是某目录的子文件夹提示不重复添加
  const addWs = async (): Promise<void> => {
    const p = await window.api.kbPickFolder()
    if (!p) return
    if (formWsSel.some((w) => p === w || p.startsWith(w + '/'))) {
      setWsError('已在授权范围内')
      return
    }
    setWsError('')
    setFormWsSel([...formWsSel, p])
  }

  const submit = async (): Promise<void> => {
    const r = await window.api.agentSave({
      id: editing?.id,
      name: formName.trim(),
      prompt: formPrompt,
      kbSel: formKbSel,
      mcpSel: formMcpSel,
      wsSel: formWsSel,
      skillSel: formSkillSel
    })
    if (!r.ok) {
      setFormError(r.error)
      setSub('base') // 错误是名字的事，直接带到名称字段下
      return
    }
    onDirtyChange(false)
    setEditing(null)
    reload()
  }

  const askDelete = async (a: { id: number; name: string }): Promise<void> => {
    const usage = await window.api.agentUsage(a.id)
    setConfirmDelete({ id: a.id, name: a.name, usage })
  }

  // ── 编辑视图（分类式）：四个分类共享一份表单，切分类不丢，保存一次落库 ──
  if (editing !== null) {
    const kbById = new Map(kbs.map((k) => [k.id, k]))
    const svcById = new Map(services.map((s) => [s.id, s]))
    const goneKb = formKbSel.filter((e) => !kbById.has(e.id))
    const goneMcp = formMcpSel.filter((e) => !svcById.has(e.id))
    const goneSkills = formSkillSel.filter((n) => !skills.some((s) => s.name === n))
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-none items-center px-6 pt-5 pb-2">
          <button
            onClick={() => setEditing(null)}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            Agent
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[112px] flex-none flex-col gap-1 px-4 pt-1">
            {(
              [
                ['base', '基础设置'],
                ['prompt', '提示词'],
                ['kb', '知识库'],
                ['tools', '工具'],
                ['skill', '技能']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setSub(key)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors',
                  sub === key ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-6 pb-4">
            {sub === 'base' && (
              <>
                <Section title="名称 *">
                  <input
                    value={formName}
                    onChange={(e) => {
                      setFormName(e.target.value)
                      setFormError('')
                    }}
                    className={INPUT_CLS}
                  />
                  {formError && (
                    <div className="mt-1.5 text-[13px] text-destructive">{formError}</div>
                  )}
                </Section>
                {/* 默认工作空间（015 Case 1）：新会话选用该 Agent 时默认勾选；改动只影响之后新建的会话 */}
                <Section title="工作空间">
                  <div className="flex flex-col gap-1">
                    {formWsSel.map((p) => {
                      const name = p.split('/').filter(Boolean).pop() ?? p
                      const missing = wsMissing.includes(p)
                      return (
                        <div key={p} className="group flex items-center gap-2 py-1 text-[13px]">
                          <FolderOpen className="size-4 flex-none text-muted-foreground" />
                          <span className="flex-none">{name}</span>
                          {missing && (
                            <span className="flex flex-none items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                              <TriangleAlert className="size-3" />
                              已失效
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                            {p}
                          </span>
                          <button
                            onClick={() => {
                              setFormWsSel(formWsSel.filter((x) => x !== p))
                              setWsError('')
                            }}
                            title="移除"
                            className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground"
                          >
                            <X className="size-3.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1.5"
                    onClick={() => void addWs()}
                  >
                    <Plus className="size-3.5" />
                    添加
                  </Button>
                  {wsError && (
                    <div className="mt-1.5 text-[13px] text-muted-foreground">{wsError}</div>
                  )}
                </Section>
              </>
            )}

            {sub === 'prompt' && (
              <>
                <div className="mb-1.5 text-[13px] font-medium text-muted-foreground">
                  系统提示词
                </div>
                <textarea
                  value={formPrompt}
                  onChange={(e) => setFormPrompt(e.target.value)}
                  rows={16}
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-[13px] leading-[1.7] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/15"
                />
                <div className="mt-1 text-[12px] text-muted-foreground">
                  {estimateTokensBase(formPrompt)} tokens
                </div>
              </>
            )}

            {sub === 'kb' && (
              <>
                <div className="mb-2 text-[13px] font-medium text-muted-foreground">知识库</div>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {goneKb.map((e) => (
                    <CatalogRow
                      key={`gone-${e.id}`}
                      name={e.name}
                      added
                      note="已移除"
                      onAskRemove={() => setConfirmRemove({ kind: 'kb', id: e.id, name: e.name })}
                    />
                  ))}
                  {kbs.map((k) => {
                    const added = formKbSel.some((e) => e.id === k.id)
                    return (
                      <CatalogRow
                        key={k.id}
                        name={k.name}
                        added={added}
                        onAdd={() => setFormKbSel([...formKbSel, { id: k.id, name: k.name }])}
                        onAskRemove={() => setConfirmRemove({ kind: 'kb', id: k.id, name: k.name })}
                      />
                    )
                  })}
                  {!kbs.length && !goneKb.length && (
                    <div className="py-3 text-[13px] text-muted-foreground">
                      还没有知识库，可先在「知识库」分区添加
                    </div>
                  )}
                </div>
              </>
            )}

            {sub === 'skill' && (
              <>
                <div className="mb-2 text-[13px] font-medium text-muted-foreground">技能</div>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {goneSkills.map((n) => (
                    <CatalogRow
                      key={`gone-${n}`}
                      name={n}
                      added
                      note="已删除"
                      onAskRemove={() => setConfirmRemove({ kind: 'skill', id: n, name: n })}
                    />
                  ))}
                  {skills.map((s) => {
                    const added = formSkillSel.includes(s.name)
                    return (
                      <CatalogRow
                        key={s.name}
                        name={s.name}
                        added={added}
                        onAdd={() => setFormSkillSel([...formSkillSel, s.name])}
                        onAskRemove={() =>
                          setConfirmRemove({ kind: 'skill', id: s.name, name: s.name })
                        }
                      />
                    )
                  })}
                  {!skills.length && !goneSkills.length && (
                    <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
                      技能库是空的
                      <button onClick={onGoSkills} className="text-primary hover:underline">
                        去导入
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {sub === 'tools' && (
              <>
                <div className="mb-2 text-[13px] font-medium text-muted-foreground">内置工具</div>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {BUILTIN_TOOLS.map((t) => (
                    <CatalogRow key={t.name} name={t.display} added lockAdded />
                  ))}
                </div>
                <div className="mt-5 mb-2 pt-2 text-[13px] font-medium text-muted-foreground">
                  MCP 服务
                </div>
                <div className="divide-y divide-border rounded-xl border border-border">
                  {goneMcp.map((e) => (
                    <CatalogRow
                      key={`gone-${e.id}`}
                      name={e.name}
                      added
                      note="已移除"
                      onAskRemove={() => setConfirmRemove({ kind: 'mcp', id: e.id, name: e.name })}
                    />
                  ))}
                  {services
                    .filter((s) => s.enabled)
                    .map((s) => {
                      const added = formMcpSel.some((e) => e.id === s.id)
                      return (
                        <CatalogRow
                          key={s.id}
                          name={s.name}
                          added={added}
                          onAdd={() => setFormMcpSel([...formMcpSel, { id: s.id, name: s.name }])}
                          onAskRemove={() =>
                            setConfirmRemove({ kind: 'mcp', id: s.id, name: s.name })
                          }
                        />
                      )
                    })}
                  {!services.some((s) => s.enabled) && !goneMcp.length && (
                    <div className="py-3 text-[13px] text-muted-foreground">
                      还没有已启用的 MCP 服务，可先在「工具」分区添加
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-none justify-end gap-2.5 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={() => setEditing(null)} className="h-9">
            取消
          </Button>
          <Button onClick={submit} disabled={!formName.trim()} className="h-9 px-5">
            保存
          </Button>
        </div>

        <ConfirmDialog
          open={!!confirmRemove}
          title={`移除「${confirmRemove?.name ?? ''}」？`}
          body={
            confirmRemove?.kind === 'kb'
              ? '移除后这个 Agent 不再依据该知识库作答。'
              : confirmRemove?.kind === 'skill'
                ? '移除后这个 Agent 的会话不再具备该技能。'
                : '移除后这个 Agent 不再具备该服务的操作能力。'
          }
          confirmText="移除"
          onConfirm={() => {
            if (confirmRemove?.kind === 'kb')
              setFormKbSel(formKbSel.filter((e) => e.id !== confirmRemove.id))
            if (confirmRemove?.kind === 'mcp')
              setFormMcpSel(formMcpSel.filter((e) => e.id !== confirmRemove.id))
            if (confirmRemove?.kind === 'skill')
              setFormSkillSel(formSkillSel.filter((n) => n !== confirmRemove.id))
            setConfirmRemove(null)
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      </div>
    )
  }

  // ── 列表视图（删除入口在这里，不进编辑页）──
  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[15px] font-semibold">Agent</div>
        <Button
          variant="outline"
          onClick={() => openEdit(null)}
          className="h-8 gap-1 px-3 text-[13px]"
        >
          <Plus className="size-4" />
          新建 Agent
        </Button>
      </div>
      {agents.length === 0 ? (
        <div className="flex flex-col items-start gap-1 py-8">
          <div className="text-[14px] font-medium">还没有 Agent</div>
          <div className="text-[13px] text-muted-foreground">
            建一个专管某摊事的助手，开会话时直接选它
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {agents.map((a) => (
            <div
              key={a.id}
              onClick={() => openEdit(a)}
              className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">{a.name}</div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  {a.kbSel.length} 个知识库&emsp;{a.mcpSel.length} 个 MCP 服务&emsp;
                  {a.skillSel.length} 个技能
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void askDelete(a)
                }}
                title="删除"
                className="grid size-8 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/5 hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title={`删除 Agent「${confirmDelete?.name ?? ''}」？`}
        body={
          confirmDelete?.usage
            ? `有 ${confirmDelete.usage} 个会话正在用它。删除后这些会话保留，但不再具备它的知识库和服务能力。`
            : '删除后不可恢复。'
        }
        confirmText="删除"
        onConfirm={async () => {
          if (confirmDelete) await window.api.agentDelete(confirmDelete.id)
          setConfirmDelete(null)
          reload()
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  )
}

// 目录表格行（Agent 编辑页的知识库与工具，参照 Claude Connectors 的表格式）。
// 已添加 = ✅，悬停变「移除」，点击弹确认；内置工具恒 ✅ 不可移除。
// 悬停抑制：刚点完「添加」鼠标还悬在原地，立即显示「移除」会误导——移出一次后才恢复悬停态。
// 独立顶层组件而非面板内定义：内联定义每次渲染重建组件身份，内部 state 会丢（mermaid 闪动同款教训）
function CatalogRow({
  name,
  added,
  note,
  lockAdded,
  onAdd,
  onAskRemove
}: {
  name: string
  added: boolean
  note?: string // 「已移除」一类的备注（成员在 Chime 里已删）
  lockAdded?: boolean
  onAdd?: () => void
  onAskRemove?: () => void
}): React.JSX.Element {
  const [suppressHover, setSuppressHover] = useState(false)
  return (
    <div className={cn('flex items-center gap-2 px-4 py-2.5 text-[13px]', note && 'opacity-60')}>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {note && (
        <>
          <span className="size-1.5 flex-none rounded-full bg-destructive" />
          <span className="flex-none text-[12px] text-muted-foreground">{note}</span>
        </>
      )}
      {lockAdded ? (
        <span className="grid h-7 w-14 flex-none place-items-center text-muted-foreground">
          <Check className="size-4" />
        </span>
      ) : added ? (
        <button
          onClick={onAskRemove}
          onMouseLeave={() => setSuppressHover(false)}
          className={cn(
            'grid h-7 w-14 flex-none place-items-center rounded-md border border-border text-[12px] transition-colors',
            !suppressHover &&
              'group/rm hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive'
          )}
        >
          <Check className={cn('size-4', !suppressHover && 'group-hover/rm:hidden')} />
          {!suppressHover && <span className="hidden group-hover/rm:inline">移除</span>}
        </button>
      ) : (
        <Button
          variant="outline"
          onClick={() => {
            onAdd?.()
            setSuppressHover(true)
          }}
          className="h-7 w-14 flex-none px-0 text-[12px]"
        >
          添加
        </Button>
      )}
    </div>
  )
}
