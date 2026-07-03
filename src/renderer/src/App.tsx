import { useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import SettingsDialog from './components/SettingsDialog'
import SidePanel, { type DocPanelData } from './components/SidePanel'
import ConfirmDialog from './components/ConfirmDialog'
import { useChat, type Msg, type MsgStatus } from './hooks/useChat'
import type { Conversation, PersistedMessage } from './types'
import type { SourceRef } from '../../preload/index.d'

const toMsg = (p: PersistedMessage): Msg => ({
  id: p.id,
  role: p.role,
  content: p.content,
  reasoning: p.reasoning ?? undefined,
  status: p.status as MsgStatus,
  createdAt: p.createdAt,
  sources: p.sources ? JSON.parse(p.sources) : undefined
})

const newId = (): string => crypto.randomUUID()

function App(): React.JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string>('')
  // 草稿会话：新建但还没发消息，不入库不进列表
  const [draftId, setDraftId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [peek, setPeek] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const [defaultModel, setDefaultModel] = useState('deepseek-v4-pro')
  const [models, setModels] = useState<string[]>([])
  const [convModel, setConvModel] = useState<Record<string, string>>({})
  // 每个会话各自的输入草稿
  const [inputs, setInputs] = useState<Record<string, string>>({})
  // 知识库：全局状态 + 草稿会话的选用意向（发首条消息时定性）
  const [kbState, setKbState] = useState<'none' | 'busy' | 'ready'>('none')
  // 侧板（本版唯一内容：来源文档阅读）
  const [doc, setDoc] = useState<DocPanelData | null>(null)
  const [kbName, setKbName] = useState('业务知识库')
  const [kbDraftSel, setKbDraftSel] = useState<Record<string, boolean>>({})

  const reloadKb = useCallback(() => {
    window.api.getKb().then((k) => {
      setKbState(k.busy ? 'busy' : k.indexedAt ? 'ready' : 'none')
      setKbName(k.name)
    })
  }, [])

  useEffect(() => {
    reloadKb()
    return window.api.onKbProgress((p) => {
      if (p.phase === 'done' || p.phase === 'error') reloadKb()
      else setKbState('busy')
    })
  }, [reloadKb])

  // 会话变更（切换 / 新建 / 删除当前）统一关闭侧板——内容与原会话强相关
  useEffect(() => {
    setDoc(null)
  }, [activeId])

  const openSource = useCallback(
    async (file: string, sources: SourceRef[]) => {
      // 重复点击同一来源（同文件同片段）不重开不重滚
      if (
        doc &&
        doc.file === file &&
        doc.sources.map((s) => s.chunkId).join() === sources.map((s) => s.chunkId).join()
      )
        return
      const r = await window.api.openDoc(file)
      // 点来源永远打开侧板；异常时由侧板内容区呈现空态（不再用 toast 原地拦截）
      setDoc(r.ok ? { file, content: r.content, sources } : { file, content: null, sources, error: r.reason })
      setCollapsed(true) // 侧板打开 → 侧边栏自动收起
    },
    [doc]
  )

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
    setPeek(false)
  }, [chat])

  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    window.api.getProvider().then((p) => p.defaultModel && setDefaultModel(p.defaultModel))
    window.api.getModels().then(setModels)
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
  // 会话定性：草稿（未发首条消息）可切换挂库，已发消息后不可更改
  const kbLocked = draftId !== activeId
  const kbSelected = kbLocked ? !!active?.kbEnabled : !!kbDraftSel[activeId]

  const submit = async (): Promise<void> => {
    const text = input.trim()
    if (!text || sending) return
    // 草稿会话发出第一条时才真正建库、进列表；此刻定性是否挂知识库
    if (draftId === activeId) {
      const c = await window.api.createConversation({ id: activeId, model: activeModel })
      const kb = !!kbDraftSel[activeId]
      if (kb) await window.api.setConversationKb({ id: activeId, enabled: true })
      setConversations((cs) => [{ ...c, kbEnabled: kb ? 1 : 0 }, ...cs])
      setDraftId(null)
    }
    setInputs((m) => ({ ...m, [activeId]: '' }))
    chat.send(activeId, activeModel, text, kbSelected)
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
    onSelect: (id: string) => {
      setActiveId(id)
      setPeek(false)
    },
    onNewChat: openDraft,
    onOpenSettings: () => setSettingsOpen(true),
    onDelete: (c: Conversation) => setDeleteTarget(c)
  }

  return (
    <div className="relative flex h-full w-full gap-2 bg-[#e8e8e5] p-2">
      {!collapsed && <Sidebar {...sidebarProps} onCollapse={() => setCollapsed(true)} />}

      <ChatArea
        title={active?.title ?? '新对话'}
        convId={activeId}
        collapsed={collapsed}
        onExpand={() => setCollapsed(false)}
        messages={messages}
        sending={sending}
        input={input}
        onInput={(v) => setInputs((m) => ({ ...m, [activeId]: v }))}
        onSubmit={submit}
        onStop={chat.stop}
        onRetry={(msgId) => chat.retry(activeId, activeModel, msgId, !!active?.kbEnabled)}
        kbState={kbState}
        kbName={kbName}
        kbSelected={kbSelected}
        kbLocked={kbLocked}
        onToggleKb={() => {
          if (kbLocked) return
          setKbDraftSel((m) => ({ ...m, [activeId]: !m[activeId] }))
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
      />

      {doc && <SidePanel doc={doc} onClose={() => setDoc(null)} />}

      {collapsed && (
        <div
          onMouseEnter={() => setPeek(true)}
          className="absolute top-0 bottom-0 left-0 z-30 w-3"
        />
      )}
      {collapsed && peek && (
        <div
          onMouseLeave={() => setPeek(false)}
          className="absolute top-2 bottom-2 left-2 z-40 w-[256px]"
        >
          <Sidebar
            {...sidebarProps}
            onCollapse={() => {
              setCollapsed(false)
              setPeek(false)
            }}
          />
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(m) => {
          if (m) setDefaultModel(m)
          window.api.getModels().then(setModels)
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
