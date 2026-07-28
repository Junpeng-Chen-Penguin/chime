import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  getProvider,
  saveProvider,
  maskApiKey,
  listConversations,
  createConversation,
  deleteConversation,
  getMessages,
  getConversationMeta,
  setConversationTitle
} from './db'
import { detect, listModels, generateTitle } from './ai'
import { runTurn, stopTurn, REPAIR_TEXTS, type ChatEvent } from './engine/orchestrator'
import { respondCard, respondAskCard, type AskOutcome } from './engine/cards'
import { lastUserText, deleteLastAssistant, repairConversation } from './engine/store'
import { getKb, kbStats, setConversationKbSelection, getConversationKbSelection, setConversationMcpSelection, getConversationMcpSelection, listKbs, createKb, updateKb, deleteKb, kbStatsFor, type KbSelEntry } from './db'
import { listMcpServices, getMcpService, saveMcpService, deleteMcpService, getArtifact } from './db'
import { TABLE_RENDER_CAP } from './engine/artifact'
import { syncMcpServices, getMcpServiceRuntime, testMcpConnection } from './mcp/client'
import { kbBusy, busyKbId, runIndexJob, validateRepoPath, getLastSummary, checkChanges } from './kb'

export function registerIpc(): void {
  // 读取配置：明文密钥不出主进程，只回打码串
  ipcMain.handle('provider:get', () => {
    const p = getProvider()
    return {
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      defaultWindow: p.defaultWindow,
      keyMask: maskApiKey(p.apiKey),
      hasKey: !!p.apiKey
    }
  })

  ipcMain.handle(
    'provider:save',
    (
      _e,
      input: { baseUrl: string; defaultModel: string; apiKey: string | null; defaultWindow?: number }
    ) => {
      saveProvider(input)
    }
  )

  // apiKey 为 null 表示界面没改密钥，用已存的检测
  ipcMain.handle('provider:detect', (_e, input: { baseUrl: string; apiKey: string | null }) => {
    const key = input.apiKey ?? getProvider().apiKey
    return detect(input.baseUrl, key)
  })

  // 拉模型列表（供对话里切换模型用），失败返回空数组
  ipcMain.handle('provider:models', async () => {
    const p = getProvider()
    if (!p.apiKey) return []
    try {
      return await listModels(p.baseUrl, p.apiKey)
    } catch {
      return []
    }
  })

  // 流式对话：渲染层只发「会话 + 一句话」，事件从统一通道 chat:event 单向推回
  ipcMain.on(
    'chat:send',
    (e, payload: { streamId: string; convId: string; text: string; model: string }) => {
      const wc = e.sender
      const emit = (ev: ChatEvent): void => {
        if (!wc.isDestroyed()) wc.send('chat:event', ev)
      }
      void runTurn({ ...payload, emit })
    }
  )
  // 重试 / 重新生成：删除末轮回答后按库内历史重跑
  ipcMain.on('chat:retry', (e, payload: { streamId: string; convId: string; model: string }) => {
    const text = lastUserText(payload.convId)
    if (!text) return
    deleteLastAssistant(payload.convId)
    const wc = e.sender
    const emit = (ev: ChatEvent): void => {
      if (!wc.isDestroyed()) wc.send('chat:event', ev)
    }
    void runTurn({ ...payload, text, saveUser: false, emit })
  })
  ipcMain.on('chat:stop', (_e, streamId: string) => {
    stopTurn(streamId)
  })
  // 授权卡回应：路由到该轮的卡片队列（只认队首，过期回应静默忽略）
  ipcMain.on(
    'chat:card-response',
    (_e, payload: { streamId: string; toolCallId: string; decision: 'approved' | 'denied' }) => {
      respondCard(payload.streamId, payload.toolCallId, payload.decision)
    }
  )
  // 提问卡回应（作答 / 直接打字 / 放弃整卡）
  ipcMain.on(
    'chat:ask-response',
    (_e, payload: { streamId: string; toolCallId: string; outcome: Exclude<AskOutcome, { kind: 'aborted' }> }) => {
      respondAskCard(payload.streamId, payload.toolCallId, payload.outcome)
    }
  )

  // 会话管理
  ipcMain.handle('conv:list', () => listConversations())
  ipcMain.handle('conv:create', (_e, input: { id: string; model: string }) =>
    createConversation(input.id, input.model, Date.now())
  )
  ipcMain.handle('conv:delete', (_e, id: string) => deleteConversation(id))
  // 手动改名：title_auto 置 0，之后不再被自动标题覆盖
  ipcMain.handle('conv:rename', (_e, input: { id: string; title: string }) =>
    setConversationTitle(input.id, input.title, false)
  )
  // 打开会话先做启动修复（配对检查，幂等）：等待回应的卡随消息原样返回，执行中被强退的调用补三级文案
  ipcMain.handle('conv:messages', (_e, id: string) => {
    repairConversation(id, REPAIR_TEXTS)
    return getMessages(id)
  })

  // 知识库（多库，PRD Case 1/2）。kb:get 兼容旧形状供会话控件用（模块 3 移除）
  ipcMain.handle('kb:get', () => {
    const kb = getKb()
    return {
      rootPath: kb.rootPath,
      name: kb.name,
      intro: kb.intro,
      indexedAt: kb.indexedAt,
      busy: kbBusy(),
      lastSummary: getLastSummary(),
      ...kbStats()
    }
  })
  // 库列表：卡片数据一次给齐——元数据、统计、变更检查（秒级）、构建中状态
  ipcMain.handle('kb:list', () => {
    const busy = busyKbId()
    return listKbs().map((k) => ({
      ...k,
      ...kbStatsFor(k.id),
      changes: busy === k.id ? null : checkChanges(k.id), // 构建中的库不做检查（数据在变）
      building: busy === k.id,
      othersBuilding: busy !== null && busy !== k.id // 构建互斥：其他库按钮置灰
    }))
  })
  // 新建库：登记后立即首次构建（PRD Case 1 功能点 1）
  ipcMain.handle('kb:add', async (e, input: { name: string; intro: string; path: string }) => {
    if (kbBusy()) return { ok: false, error: '有知识库正在构建，请稍后再试' }
    const invalid = await validateRepoPath(input.path)
    if (invalid) return { ok: false, error: invalid }
    const r = createKb(input.name.trim(), input.intro.trim(), input.path.trim())
    if (!r.ok) return r
    void runIndexJob(e.sender, r.id, true)
    return { ok: true, id: r.id }
  })
  // 编辑：只改名称简介直接存；路径变了按新路径重建（PRD Case 1 功能点 2）
  ipcMain.handle('kb:update', async (e, input: { id: number; name: string; intro: string; path: string }) => {
    const cur = listKbs().find((k) => k.id === input.id)
    if (!cur) return { ok: false, error: '知识库不存在' }
    const pathChanged = input.path.trim() !== cur.rootPath
    if (pathChanged) {
      if (kbBusy()) return { ok: false, error: '有知识库正在构建，请稍后再试' }
      const invalid = await validateRepoPath(input.path)
      if (invalid) return { ok: false, error: invalid }
    }
    const r = updateKb(input.id, { name: input.name.trim(), intro: input.intro.trim(), rootPath: input.path.trim() })
    if (!r.ok) return r
    if (pathChanged) void runIndexJob(e.sender, input.id, true)
    return { ok: true, rebuilt: pathChanged }
  })
  ipcMain.handle('kb:remove', (_e, id: number) => {
    if (busyKbId() === id) return { ok: false, error: '该知识库正在构建，请稍后再试' }
    deleteKb(id)
    return { ok: true }
  })
  // 构建：按变更检查决定增量或全量；大批删除先确认（PRD Case 2）
  ipcMain.handle('kb:build', (e, input: { id: number; force?: boolean }) => {
    if (kbBusy()) return { ok: false, error: '有知识库正在构建，请稍后再试' }
    const c = checkChanges(input.id)
    if (c.folderMissing) return { ok: false, error: '文件夹不可用，请重新指定' }
    const { files } = kbStatsFor(input.id)
    if (!input.force && files > 0 && c.deleted > files / 2) {
      return { ok: false, confirmRequired: { deleted: c.deleted, kept: files - c.deleted } }
    }
    void runIndexJob(e.sender, input.id, c.needsFullRebuild)
    return { ok: true }
  })
  // 选择文件夹
  ipcMain.handle('kb:pickFolder', async () => {
    const { dialog } = await import('electron')
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  // 会话选库（PRD Case 3）：多选，[{id, name}] name 为快照
  ipcMain.handle('conv:setKbSel', (_e, input: { id: string; sel: KbSelEntry[] }) =>
    setConversationKbSelection(input.id, input.sel)
  )
  ipcMain.handle('conv:getKbSel', (_e, id: string) => getConversationKbSelection(id))
  // 会话控件的库选项：轻量（不做哈希检查），带可选性状态
  ipcMain.handle('kb:options', async () => {
    const { existsSync } = await import('fs')
    const { busyKbId } = await import('./kb')
    const busy = busyKbId()
    return listKbs().map((k) => ({
      id: k.id,
      name: k.name,
      ready: !!k.indexedAt, // 红档：从未构建成功不可选
      building: busy === k.id, // 绿档：构建中可选，检索已建好的部分
      folderMissing: !!k.rootPath && !existsSync(k.rootPath) // 黄档：可选，用已有索引
    }))
  })

  // Case 8 会话选用工具：读写本会话选用的 MCP 服务清单
  ipcMain.handle('conv:setMcpSel', (_e, input: { id: string; serviceIds: number[] }) =>
    setConversationMcpSelection(input.id, input.serviceIds)
  )
  ipcMain.handle('conv:getMcpSel', (_e, id: string) => getConversationMcpSelection(id))

  // ── MCP 服务 ──────────────────────────────────────
  // 重试连接（输入框状态标识的入口）：重连全部已启用服务，完成后 mcp:status 事件自会刷新界面
  ipcMain.handle('mcp:retry', () => syncMcpServices())

  // 列表：配置 + 运行时状态；认证请求头只回打码值（明文不出主进程，与 provider 密钥同一约定）
  ipcMain.handle('mcp:list', () =>
    listMcpServices().map((s) => {
      const rt = getMcpServiceRuntime(s.id)
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        headersMasked: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, maskApiKey(v)])),
        enabled: s.enabled,
        status: s.enabled ? (rt?.status ?? 'error') : null,
        error: rt?.error,
        toolCount: rt?.toolCount ?? 0
      }
    })
  )
  // 保存（新建/编辑共用）：headers 为 null 表示沿用已存认证；保存即生效（连接/断开随 sync）
  ipcMain.handle(
    'mcp:save',
    async (_e, input: { id?: number; name: string; url: string; headers: Record<string, string> | null; enabled: boolean }) => {
      saveMcpService(input)
      await syncMcpServices()
    }
  )
  ipcMain.handle('mcp:delete', async (_e, id: number) => {
    deleteMcpService(id)
    await syncMcpServices()
  })
  // 测试连接：表单内点测；headers 为 null 时（编辑未改认证）用已存的
  ipcMain.handle(
    'mcp:test',
    (_e, input: { id?: number; url: string; headers: Record<string, string> | null }) => {
      const headers = input.headers ?? (input.id ? (getMcpService(input.id)?.headers ?? {}) : {})
      return testMcpConnection(input.url, headers)
    }
  )

  // 制品查看（侧板表格视图）：渲染行数设上限防卡，数据完整在库
  ipcMain.handle('artifact:get', (_e, id: number) => {
    const a = getArtifact(id)
    if (!a) return null
    return {
      id: a.id,
      title: a.title,
      columns: a.columns,
      rows: a.rows.slice(0, TABLE_RENDER_CAP),
      totalRows: a.rows.length
    }
  })

  // 打开来源文档（侧板阅读视图）：读磁盘现状；校验片段用消息自带的原文快照，此处不查库
  ipcMain.handle('doc:open', (_e, input: { kbId: number; filePath: string }) => {
    const kb = listKbs().find((k) => k.id === input.kbId)
    if (!kb) return { ok: false, reason: 'no-kb' } // 库已移除：侧板降级显示片段快照
    if (kbBusy()) return { ok: false, reason: 'busy' }
    const root = resolve(kb.rootPath)
    const abs = resolve(join(root, input.filePath))
    if (!abs.startsWith(root + '/') || !existsSync(abs)) return { ok: false, reason: 'missing' }
    try {
      return { ok: true, content: readFileSync(abs, 'utf8') }
    } catch {
      return { ok: false, reason: 'missing' }
    }
  })

  // 首轮回复后用模型生成精炼标题；标题被手动改过则跳过；失败兜底保留首句标题
  ipcMain.handle(
    'conv:autotitle',
    async (_e, input: { convId: string; userText: string; assistantText: string }) => {
      const meta = getConversationMeta(input.convId)
      if (!meta || !meta.titleAuto) return null
      const p = getProvider()
      if (!p.apiKey) return null
      try {
        const title = await generateTitle({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.defaultModel || 'deepseek-v4-flash',
          userText: input.userText,
          assistantText: input.assistantText
        })
        if (title) {
          setConversationTitle(input.convId, title, true)
          return title
        }
        return null
      } catch {
        return null
      }
    }
  )
}
