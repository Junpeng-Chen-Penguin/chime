import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import SettingsDialog from './components/SettingsDialog'
import SidePanel, { DocContent, type DocPanelData } from './components/SidePanel'
import { ArtifactContent } from './components/ArtifactPanel'
import ConfirmDialog from './components/ConfirmDialog'
import { Table2 } from 'lucide-react'
import { useChat, type Msg, type MsgStatus } from './hooks/useChat'
import type { Conversation, PersistedMessage } from './types'
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
  // 设置打开时直达的分区：侧栏入口用默认分区，服务状态面板的「前往设置」直达 MCP 分区
  const [settingsTab, setSettingsTab] = useState<'provider' | 'kb' | 'mcp' | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const [defaultModel, setDefaultModel] = useState('deepseek-v4-pro')
  const [models, setModels] = useState<import('./components/Composer').ModelGroup[]>([])
  const [convModel, setConvModel] = useState<Record<string, string>>({})
  // 每个会话各自的输入草稿
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // 知识库：可选库清单 + 草稿会话的勾选意向（发首条消息时定性）
  const [kbOptions, setKbOptions] = useState<{ id: number; name: string; ready: boolean; building: boolean; folderMissing: boolean }[]>([])
  // 侧板：一个容器、单一内容位（来源文档阅读 / 制品表格查看，结构上互斥）
  const [panel, setPanel] = useState<
    { kind: 'doc'; doc: DocPanelData } | { kind: 'artifact'; artifact: ArtifactView } | null
  >(null)
  const [kbDraftSel, setKbDraftSel] = useState<Record<string, { id: number; name: string }[]>>({})
  // 服务连接状态（输入框工具菜单用）：启动加载 + mcp:status 事件刷新
  const [services, setServices] = useState<{ id: number; name: string; status: 'connected' | 'auth' | 'error' }[]>([])
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
          .map((s) => ({ id: s.id, name: s.name, status: (s.status ?? 'error') as 'connected' | 'auth' | 'error' }))
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
    window.api.getConversationMcpSelection(activeId).then((ids) => setMcpSel((m) => ({ ...m, [activeId]: ids })))
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
        doc: r.ok ? { file, content: r.content, sources } : { file, content: null, sources, error: r.reason }
      })
      setCollapsed(true) // 侧板打开 → 侧边栏自动收起
    },
    [panel]
  )

  // 点制品卡 → 侧板换制品内容（同一容器）
  const openArtifact = useCallback(async (id: number) => {
    const a = await window.api.getArtifact(id)
    if (!a) return
    setPanel({ kind: 'artifact', artifact: a })
    setCollapsed(true)
  }, [])

  const refresh = useCallback(() => {
    window.api.listConversations().then(setConversations)
  }, [])
  const chat = useChat(refresh)
  const didInit = useRef(false)

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
    // 提问卡等待中打字发送 = 中断提问 + 开启新一轮（Claude 同此；想回答问题用卡内作答）
    if (askActive) {
      chat.interruptAskAndSend(activeId, activeModel, text)
      setInputs((m) => ({ ...m, [activeId]: '' }))
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
      if (sel?.length) await window.api.setConversationMcpSelection({ id: activeId, serviceIds: sel })
      setConversations((cs) => [{ ...c, kbSelection: kbChosen }, ...cs])
      setDraftId(null)
    }
    setInputs((m) => ({ ...m, [activeId]: '' }))
    chat.send(activeId, activeModel, text)
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

  const sidebarProps = {
    items: conversations,
    activeId,
    fullscreen,
    onSelect: (id: string) => {
      setActiveId(id)
    },
    onNewChat: openDraft,
    onOpenSettings: () => {
      setSettingsTab(undefined)
      setSettingsOpen(true)
    },
    onDelete: (c: Conversation) => setDeleteTarget(c)
  }

  return (
    <div className="relative flex h-full w-full gap-2 bg-[#e8e8e5] p-2">
      {!collapsed && <Sidebar {...sidebarProps} onCollapse={() => setCollapsed(true)} />}

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
            const next = cur.some((e) => e.id === id) ? cur.filter((e) => e.id !== id) : [...cur, { id, name }]
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
          if (activeId !== draftId) window.api.setConversationMcpSelection({ id: activeId, serviceIds: next })
        }}
        onRetryServices={() => {
          window.api.mcpRetry().then(reloadServices)
        }}
        onOpenSettings={() => {
          setSettingsTab('mcp')
          setSettingsOpen(true)
        }}
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

      {panel && (
        <SidePanel
          icon={panel.kind === 'artifact' ? <Table2 className="size-4 flex-none text-muted-foreground" /> : undefined}
          title={
            panel.kind === 'doc' ? (panel.doc.file.split('/').pop() ?? '').replace(/\.md$/, '') : panel.artifact.title
          }
          subtitle={panel.kind === 'doc' ? panel.doc.file : `${panel.artifact.totalRows} 行`}
          onClose={() => setPanel(null)}
        >
          {panel.kind === 'doc' ? <DocContent doc={panel.doc} /> : <ArtifactContent artifact={panel.artifact} />}
        </SidePanel>
      )}

      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        onClose={() => {
          setSettingsOpen(false)
          reloadKb() // 设置里增删改了库，回到会话即反映（移除后标已移除）
        }}
        onSaved={(m) => {
          if (m) setDefaultModel(m)
          window.api.providerMenu().then(setModels)
        }}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除会话"
        body={`删除后无法恢复，确定删除「${deleteTarget?.title ?? ''}」？`}
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

export default App
