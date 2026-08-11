import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import SettingsView from './components/SettingsView'
import SidePanel, { DocContent, type DocPanelData } from './components/SidePanel'
import { ArtifactContent } from './components/ArtifactPanel'
import ConfirmDialog from './components/ConfirmDialog'
import { Download, Table2 } from 'lucide-react'
import { useChat, type Msg, type MsgStatus } from './hooks/useChat'
import type { ChipRef, Conversation, PersistedMessage } from './types'
import type { SourceRef, TurnItem, ArtifactView } from '../../preload/index.d'

const toMsg = (p: PersistedMessage): Msg => ({
  id: p.id,
  role: p.role,
  content: p.content,
  items: p.items ? JSON.parse(p.items) : undefined,
  usage: p.usage ? JSON.parse(p.usage) : undefined,
  status: p.status as MsgStatus,
  createdAt: p.createdAt
})

const newId = (): string => crypto.randomUUID()

function App(): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string>('')
  // 草稿会话：新建但还没发消息，不入库不进列表
  const [draftId, setDraftId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsDirty = useRef(false) // 设置里有未保存表单内容（只在离开瞬间读，不需要触发渲染）
  const [leaveTarget, setLeaveTarget] = useState<(() => void) | null>(null) // 未保存拦截：确认后要执行的离开动作
  // 设置打开时直达的分区：侧栏入口用默认分区，服务状态面板的「前往设置」直达 MCP 分区
  const [settingsTab, setSettingsTab] = useState<'provider' | 'kb' | 'mcp' | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const [defaultModel, setDefaultModel] = useState('deepseek-v4-pro')
  const [models, setModels] = useState<import('./components/Composer').ModelGroup[]>([])
  const [convModel, setConvModel] = useState<Record<string, string>>({})
  // 每个会话各自的输入草稿
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // 每个会话各自待发送的表格行引用（013 Case 2）：临时状态不落库，发送时随消息转正
  const [chips, setChips] = useState<Record<string, ChipRef[]>>({})
  // 知识库：可选库清单 + 草稿会话的勾选意向（发首条消息时定性）
  const [kbOptions, setKbOptions] = useState<
    { id: number; name: string; ready: boolean; building: boolean; folderMissing: boolean }[]
  >([])
  // 侧板：一个容器、单一内容位（来源文档阅读 / 制品表格查看，结构上互斥）
  const [panel, setPanel] = useState<
    | { kind: 'doc'; doc: DocPanelData }
    | { kind: 'artifact'; artifact: ArtifactView; highlightRows?: number[] } // 高亮：回看引用时定位
    | null
  >(null)
  const [kbDraftSel, setKbDraftSel] = useState<Record<string, { id: number; name: string }[]>>({})
  // 服务连接状态（输入框工具菜单用）：启动加载 + mcp:status 事件刷新
  const [services, setServices] = useState<
    { id: number; name: string; status: 'connected' | 'auth' | 'error' }[]
  >([])
  // 会话选用的 MCP 服务（Case 8）：按会话缓存，真实会话首次激活时从库读，草稿只在内存
  const [mcpSel, setMcpSel] = useState<Record<string, number[]>>({})

  const reloadKb = useCallback(() => {
    window.api.kbOptions().then(setKbOptions)
  }, [])

  useEffect(() => {
    reloadKb()
    return window.api.onKbProgress((p) => {
      if (p.phase === 'done' || p.phase === 'error') reloadKb()
      else reloadKb() // 构建开始也刷新（building 状态点）
    })
  }, [reloadKb])

  const reloadServices = useCallback(() => {
    window.api.mcpList().then((list) => {
      setServices(
        list
          .filter((s) => s.enabled)
          .map((s) => ({
            id: s.id,
            name: s.name,
            status: (s.status ?? 'error') as 'connected' | 'auth' | 'error'
          }))
      )
    })
  }, [])

  useEffect(() => {
    reloadServices()
    return window.api.onMcpStatus(reloadServices)
  }, [reloadServices])

  // 激活真实会话时补读它的选用清单（草稿会话默认空、只在内存）
  useEffect(() => {
    if (!activeId || activeId === draftId || activeId in mcpSel) return
    window.api
      .getConversationMcpSelection(activeId)
      .then((ids) => setMcpSel((m) => ({ ...m, [activeId]: ids })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, draftId])

  // 会话变更（切换 / 新建 / 删除当前）统一关闭侧板——内容与原会话强相关
  useEffect(() => {
    setPanel(null)
  }, [activeId])

  useEffect(() => window.api.onFullscreen(setFullscreen), [])

  const openSource = useCallback(
    async (file: string, sources: SourceRef[]) => {
      // 重复点击同一来源（同文件同片段）不重开不重滚
      const cur = panel?.kind === 'doc' ? panel.doc : null
      if (
        cur &&
        cur.file === file &&
        cur.sources.map((s) => s.chunkId).join() === sources.map((s) => s.chunkId).join()
      )
        return
      const r = await window.api.openDoc({ kbId: sources[0]?.kbId ?? 0, filePath: file })
      // 点来源永远打开侧板；异常时由侧板内容区呈现空态（不再用 toast 原地拦截）
      setPanel({
        kind: 'doc',
        doc: r.ok
          ? { file, content: r.content, sources }
          : { file, content: null, sources, error: r.reason }
      })
      setCollapsed(true) // 侧板打开 → 侧边栏自动收起
    },
    [panel]
  )

  // 右键「加进对话」：当前制品 + 选中行号 → 本会话的引用清单（013 Case 2）。
  // 一个制品最多一个 chip（俊鹏定：一个制品配一个指令，符合交互形态）——
  // 同一制品再加是替换行集，不新增第二个 chip
  const addChip = useCallback(
    (rowIndexes: number[]) => {
      if (panel?.kind !== 'artifact' || !activeId) return
      const a = panel.artifact
      setChips((m) => {
        const cur = m[activeId] ?? []
        const head = a.columns.map((c) => c.label).join(' | ')
        const chars = rowIndexes.reduce(
          (n, i) =>
            n +
            a.columns.reduce((w, c) => {
              const v = a.rows[i]?.[c.key]
              return w + (v === undefined || v === null ? 0 : String(v).length) + 3
            }, 0),
          head.length
        )
        const next = { artifactId: a.id, title: a.title, rowIndexes, chars }
        const i = cur.findIndex((c) => c.artifactId === a.id)
        return {
          ...m,
          [activeId]: i < 0 ? [...cur, next] : cur.map((c, j) => (j === i ? next : c))
        }
      })
    },
    [panel, activeId]
  )

  // 点制品卡 → 侧板换制品内容（同一容器）；带 rows 时为引用回看，打开后高亮那几行
  const openArtifact = useCallback(async (id: number, rows?: number[]) => {
    const a = await window.api.getArtifact(id)
    if (!a) return
    setPanel({ kind: 'artifact', artifact: a, highlightRows: rows })
    setCollapsed(true)
  }, [])

  const refresh = useCallback(() => {
    window.api.listConversations().then(setConversations)
  }, [])
  const chat = useChat(refresh)
  const didInit = useRef(false)

  // ⌘. 收起/展开侧边栏：按钮提示一直写着这个快捷键，实现是 1.12.0 补的（此前从未生效）
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key === '.') setCollapsed((c) => !c)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const openDraft = useCallback(() => {
    const id = newId()
    setDraftId(id)
    setActiveId(id)
    chat.hydrate(id, [])
  }, [chat])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    window.api.providerGetDefault().then((r) => r && setDefaultModel(r))
    window.api.providerMenu().then(setModels)
    window.api.listConversations().then((list) => {
      setConversations(list)
      if (list.length) setActiveId(list[0].id)
      else openDraft()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切到已有会话时按需水合
  useEffect(() => {
    if (!activeId || activeId === draftId || chat.threads[activeId]) return
    window.api.getMessages(activeId).then((msgs) => chat.hydrate(activeId, msgs.map(toMsg)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const active = conversations.find((c) => c.id === activeId)
  const activeModel = convModel[activeId] ?? active?.model ?? defaultModel
  const messages = chat.threads[activeId] ?? []
  const sending = chat.streamingConv === activeId
  const input = inputs[activeId] ?? ''
  // 队首待回应的卡（授权 / 提问）：提问卡活跃时主输入框保持开放，打字即整体回答
  const lastItems = messages[messages.length - 1]?.items ?? []
  const activeCard = sending
    ? lastItems.find(
        (it): it is Extract<TurnItem, { t: 'tool' }> =>
          it.t === 'tool' && (it.auth === 'pending' || it.ask?.state === 'pending')
      )
    : undefined
  const askActive = activeCard?.ask?.state === 'pending' ? activeCard : undefined
  // 会话定性：草稿（未发首条消息）可切换挂库，已发消息后不可更改
  const kbLocked = draftId !== activeId
  const kbSel = kbLocked ? (active?.kbSelection ?? []) : (kbDraftSel[activeId] ?? [])

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text) return
    // 表格行引用随消息发出（013 Case 2）：chars 是渲染层的估算件，落库前剥掉
    const refs = (chips[activeId] ?? []).map(({ artifactId, title, rowIndexes }) => ({
      t: 'ref' as const,
      artifactId,
      title,
      rowIndexes
    }))
    const clearPending = (): void => {
      setInputs((m) => ({ ...m, [activeId]: '' }))
      setChips((m) => ({ ...m, [activeId]: [] }))
    }
    // 提问卡等待中打字发送 = 中断提问 + 开启新一轮（Claude 同此；想回答问题用卡内作答）
    if (askActive) {
      chat.interruptAskAndSend(activeId, activeModel, text, refs.length ? refs : undefined)
      clearPending()
      return
    }
    if (sending) return
    // 草稿会话发出第一条时才真正建库、进列表；此刻定性是否挂知识库
    if (draftId === activeId) {
      const c = await window.api.createConversation({ id: activeId, model: activeModel })
      const kbChosen = kbDraftSel[activeId] ?? []
      if (kbChosen.length) await window.api.setConversationKbSel({ id: activeId, sel: kbChosen })
      // 草稿期勾选的服务随会话落库（Case 8）
      const sel = mcpSel[activeId]
      if (sel?.length)
        await window.api.setConversationMcpSelection({ id: activeId, serviceIds: sel })
      setConversations((cs) => [{ ...c, kbSelection: kbChosen }, ...cs])
      setDraftId(null)
    }
    clearPending()
    chat.send(activeId, activeModel, text, refs.length ? refs : undefined)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const id = deleteTarget.id
    await window.api.deleteConversation(id)
    const remaining = conversations.filter((c) => c.id !== id)
    setConversations(remaining)
    if (id === activeId) {
      if (remaining.length) setActiveId(remaining[0].id)
      else openDraft()
    }
    setDeleteTarget(null)
  }

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    settingsDirty.current = false
    reloadKb() // 设置里增删改了库，回到会话即反映（移除后标已移除）
  }, [reloadKb])

  // 离开设置的统一入口：有未保存内容先拦（Case 1 功能点 5），确认后执行原动作；没有则直接走。
  // 不在设置页时 then 原样执行，行为与改版前一致
  const leaveSettings = (then?: () => void): void => {
    if (settingsOpen && settingsDirty.current) {
      setLeaveTarget(() => () => {
        closeSettings()
        then?.()
      })
      return
    }
    if (settingsOpen) closeSettings()
    then?.()
  }

  const openSettings = (tab?: 'provider' | 'kb' | 'mcp'): void => {
    setSettingsTab(tab)
    setPanel(null) // 设置占用主区域，侧板一并收起（退出后不自动恢复）
    setSettingsOpen(true)
  }

  const sidebarProps = {
    items: conversations,
    activeId: settingsOpen ? '' : activeId, // 设置打开时会话列表无选中项
    fullscreen,
    settingsActive: settingsOpen,
    onSelect: (id: string) => leaveSettings(() => setActiveId(id)),
    onNewChat: () => leaveSettings(openDraft),
    onOpenSettings: () => openSettings(undefined),
    onDelete: (c: Conversation) => setDeleteTarget(c)
  }

  return (
    <div className="relative flex h-full w-full gap-2 bg-[#e8e8e5] p-2">
      {!collapsed && <Sidebar {...sidebarProps} onCollapse={() => setCollapsed(true)} />}

      {settingsOpen ? (
        <SettingsView
          collapsed={collapsed}
          fullscreen={fullscreen}
          onExpand={() => setCollapsed(false)}
          initialTab={settingsTab}
          onClose={() => leaveSettings()}
          onDirtyChange={(d) => (settingsDirty.current = d)}
          onSaved={(m) => {
            if (m) setDefaultModel(m)
            window.api.providerMenu().then(setModels)
          }}
        />
      ) : (
      <ChatArea
        title={active?.title ?? '新对话'}
        convId={activeId}
        collapsed={collapsed}
        fullscreen={fullscreen}
        onExpand={() => setCollapsed(false)}
        messages={messages}
        sending={sending}
        contextRatio={chat.contextRatio[activeId] ?? 0}
        input={input}
        onInput={(v) => setInputs((m) => ({ ...m, [activeId]: v }))}
        chips={chips[activeId] ?? []}
        onRemoveChip={(idx) =>
          setChips((m) => ({ ...m, [activeId]: (m[activeId] ?? []).filter((_, i) => i !== idx) }))
        }
        onSubmit={submit}
        onStop={chat.stop}
        onRetry={() => chat.retry(activeId, activeModel)}
        kbOptions={kbOptions}
        kbSel={kbSel}
        kbLocked={kbLocked}
        onToggleKb={(id, name) => {
          if (kbLocked) return
          setKbDraftSel((m) => {
            const cur = m[activeId] ?? []
            const next = cur.some((e) => e.id === id)
              ? cur.filter((e) => e.id !== id)
              : [...cur, { id, name }]
            return { ...m, [activeId]: next }
          })
        }}
        services={services}
        selectedServiceIds={mcpSel[activeId] ?? []}
        onToggleService={(id) => {
          const cur = mcpSel[activeId] ?? []
          const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
          setMcpSel((m) => ({ ...m, [activeId]: next }))
          // 真实会话立即持久化；草稿会话等发首条消息时随会话落库
          if (activeId !== draftId)
            window.api.setConversationMcpSelection({ id: activeId, serviceIds: next })
        }}
        onRetryServices={() => {
          window.api.mcpRetry().then(reloadServices)
        }}
        onOpenSettings={() => openSettings('mcp')}
        onRename={(t) => {
          if (!activeId || activeId === draftId) return
          setConversations((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: t } : c)))
          window.api.renameConversation(activeId, t)
        }}
        model={activeModel}
        models={models}
        onPickModel={(m) => setConvModel((cm) => ({ ...cm, [activeId]: m }))}
        onOpenSource={openSource}
        onRespondCard={chat.respondCard}
        onRespondAsk={chat.respondAsk}
        onOpenArtifact={openArtifact}
      />
      )}

      {panel && (
        <SidePanel
          icon={
            panel.kind === 'artifact' ? (
              <Table2 className="size-4 flex-none text-muted-foreground" />
            ) : undefined
          }
          title={
            panel.kind === 'doc'
              ? (panel.doc.file.split('/').pop() ?? '').replace(/\.md$/, '')
              : panel.artifact.title
          }
          subtitle={panel.kind === 'doc' ? panel.doc.file : `${panel.artifact.totalRows} 行`}
          actions={
            panel.kind === 'artifact' ? (
              <button
                onClick={() => void window.api.exportArtifact(panel.artifact.id)}
                title="导出 CSV（完整数据）"
                className="grid size-8 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Download className="size-[18px]" />
              </button>
            ) : undefined
          }
          onClose={() => setPanel(null)}
        >
          {panel.kind === 'doc' ? (
            <DocContent doc={panel.doc} />
          ) : (
            <ArtifactContent
              key={panel.artifact.id} // 按制品重建：不加 key 时 A 切 B 组件不重挂，A 的勾选会串给 B
              artifact={panel.artifact}
              highlightRows={panel.highlightRows}
              referencedRows={
                (chips[activeId] ?? []).find((c) => c.artifactId === panel.artifact.id)?.rowIndexes
              }
              onAddToChat={addChip}
            />
          )}
        </SidePanel>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除会话"
        body={`删除后无法恢复，确定删除「${deleteTarget?.title ?? ''}」？`}
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* 设置里有未保存内容时的离开确认（Case 1 功能点 5）；取消即留在设置页继续编辑 */}
      <ConfirmDialog
        open={!!leaveTarget}
        title="放弃未保存的修改？"
        body="当前编辑的内容还没有保存，离开后会丢失。"
        confirmText="放弃并离开"
        cancelText="继续编辑"
        onConfirm={() => {
          leaveTarget?.()
          setLeaveTarget(null)
        }}
        onCancel={() => setLeaveTarget(null)}
      />
    </div>
  )
}

export default App
