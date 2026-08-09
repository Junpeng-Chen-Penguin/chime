import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import {
  maskApiKey,
  listConversations,
  createConversation,
  deleteConversation,
  getMessages,
  getConversationMeta,
  setConversationTitle
} from './db'
import { detect, listModels, generateTitle, vendorHealth, markVendorHealth, humanize } from './ai'
import { runTurn, stopTurn, REPAIR_TEXTS, type ChatEvent } from './engine/orchestrator'
import { respondCard, respondAskCard, type AskOutcome } from './engine/cards'
import { lastUserText, deleteLastAssistant, repairConversation } from './engine/store'
import {
  getKb,
  kbStats,
  setConversationKbSelection,
  getConversationKbSelection,
  setConversationMcpSelection,
  getConversationMcpSelection,
  listKbs,
  createKb,
  updateKb,
  deleteKb,
  kbStatsFor,
  listProviderRecords,
  getProviderRecord,
  saveProviderRecord,
  getDefaultModelRef,
  setDefaultModelRef,
  resolveModelRef,
  type KbSelEntry
} from './db'
import { vendorPreset } from './vendors'
import { refreshRegistry, windowsForVendor } from './registry'
import { listMcpServices, getMcpService, saveMcpService, deleteMcpService, getArtifact, setMcpTrusted } from './db'
import { TABLE_RENDER_CAP } from './engine/artifact'
import { syncMcpServices, getMcpServiceRuntime, testMcpConnection } from './mcp/client'
import { kbBusy, busyKbId, runIndexJob, validateRepoPath, getLastSummary, checkChanges } from './kb'

export function registerIpc(): void {
  // ── 模型服务商（PRD Case 6/7）：预置多家，密钥明文不出主进程 ──
  ipcMain.handle('provider:list', () => {
    const health = vendorHealth()
    return listProviderRecords().map((p) => {
      const preset = vendorPreset(p.vendor)
      return {
        vendor: p.vendor,
        name: preset?.name ?? p.vendor,
        baseUrl: p.baseUrl,
        defaultBaseUrl: preset?.baseUrl ?? '',
        keyMask: maskApiKey(p.apiKey),
        hasKey: !!p.apiKey,
        enabled: p.enabled,
        models: p.models,
        extraParams: p.extraParams,
        windows: windowsForVendor(p.vendor),
        health: health[p.vendor] ?? { ok: true }
      }
    })
  })
  ipcMain.handle(
    'provider:save',
    (_e, input: { vendor: string; apiKey?: string | null; baseUrl?: string; enabled?: boolean; extraParams?: Record<string, unknown> }) => {
      saveProviderRecord(input.vendor, input)
    }
  )
  // 检测：向该服务商发一条极短消息确认能真正对话（PRD Case 6 功能点 4）
  ipcMain.handle('provider:detect', async (_e, input: { vendor: string; apiKey: string | null }) => {
    const p = getProviderRecord(input.vendor)
    if (!p) return { ok: false, error: '服务商不存在' }
    const key = input.apiKey ?? p.apiKey
    const r = await detect(p.baseUrl, key)
    if (r.ok) markVendorHealth(input.vendor, true) // 检测通过解除警示
    return r
  })
  // 拉取模型清单并合并：已勾选保持勾选；消失的标已下线不自动取消；新出现的不自动勾选
  ipcMain.handle('provider:fetchModels', async (_e, vendor: string) => {
    const p = getProviderRecord(vendor)
    if (!p || !p.apiKey) return { ok: false, error: '请先填写 API 密钥' }
    try {
      // 名单以厂商 /models 为准，窗口以登记表为准，两件事各拉各的。
      // 登记表拉失败不影响检测——窗口退回预置表，名单照常更新
      const [ids] = await Promise.all([listModels(p.baseUrl, p.apiKey), refreshRegistry()])
      const prev = new Map(p.models.map((m) => [m.id, m]))
      const merged = [
        ...ids.map((id) => ({ id, picked: prev.get(id)?.picked ?? false, offline: false })),
        ...p.models.filter((m) => !ids.includes(m.id)).map((m) => ({ ...m, offline: true }))
      ]
      // 认得窗口的对话模型排前，其余按接口返回顺序
      const windows = windowsForVendor(vendor)
      merged.sort((a, b) => (windows[b.id.toLowerCase()] ? 1 : 0) - (windows[a.id.toLowerCase()] ? 1 : 0))
      saveProviderRecord(vendor, { models: merged })
      return { ok: true, models: merged }
    } catch (e) {
      const status = (e as { status?: number }).status
      return { ok: false, error: status ? humanize(status) : '拉取失败，请检查网络或服务地址' }
    }
  })
  ipcMain.handle('provider:pickModel', (_e, input: { vendor: string; id: string; picked: boolean }) => {
    const p = getProviderRecord(input.vendor)
    if (!p) return
    saveProviderRecord(input.vendor, {
      models: p.models.map((m) => (m.id === input.id ? { ...m, picked: input.picked } : m))
    })
  })
  ipcMain.handle('provider:getDefault', () => getDefaultModelRef())
  ipcMain.handle('provider:setDefault', (_e, ref: string) => setDefaultModelRef(ref))
  // 会话模型菜单数据源：已启用服务商的勾选模型，按服务商分组
  ipcMain.handle('provider:menu', () => {
    const health = vendorHealth()
    return listProviderRecords()
      .filter((p) => p.enabled && p.apiKey)
      .map((p) => ({
        vendor: p.vendor,
        name: vendorPreset(p.vendor)?.name ?? p.vendor,
        health: health[p.vendor] ?? { ok: true },
        models: p.models.filter((m) => m.picked).map((m) => m.id)
      }))
  })
  ipcMain.handle('provider:health', () => vendorHealth())

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
        trusted: s.trusted,
        toolsChanged: s.toolsChanged,
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
  // 信任只读声明开关（011 Case 4）：只管信任位；指纹基线在连接时统一记（012 改）
  ipcMain.handle('mcp:setTrusted', async (_e, input: { id: number; trusted: boolean }) => {
    setMcpTrusted(input.id, input.trusted)
    await syncMcpServices()
  })
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
      const p = resolveModelRef(getDefaultModelRef())
      if (!p || !p.apiKey) return null
      try {
        const title = await generateTitle({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model: p.model || 'deepseek-v4-flash',
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
