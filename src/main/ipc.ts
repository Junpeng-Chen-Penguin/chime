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
import { runTurn, stopTurn, type ChatEvent } from './engine/orchestrator'
import { lastUserText, deleteLastAssistant } from './engine/store'
import { getKb, kbStats, setConversationKb, setKbMeta, resetKb } from './db'
import { listMcpServices, getMcpService, saveMcpService, deleteMcpService } from './db'
import { syncMcpServices, getMcpServiceRuntime, testMcpConnection } from './mcp/client'
import { kbBusy, runIndexJob, validateRepoPath, getLastSummary } from './kb'

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
  ipcMain.handle('conv:messages', (_e, id: string) => getMessages(id))

  // 知识库
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
  // 名称 + 简介：纯元数据，不触发任何索引
  ipcMain.handle('kb:update', (_e, input: { name: string; intro: string }) => {
    setKbMeta({ name: input.name.trim() || '业务知识库', intro: input.intro.trim() })
  })
  // 移除：清空索引数据并复位（不影响 git 仓库本身）
  ipcMain.handle('kb:remove', () => {
    if (kbBusy()) return { ok: false, error: '知识库处理中，请稍后再试' }
    resetKb()
    return { ok: true }
  })
  // 点「构建」：校验 → 整库重建（换路径与首次构建同语义）；简介为必填元数据，随表单一并保存
  ipcMain.handle('kb:build', async (e, input: { path: string; name: string; intro: string }) => {
    const invalid = await validateRepoPath(input.path)
    if (invalid) return { ok: false, error: invalid }
    setKbMeta({ intro: input.intro.trim() })
    void runIndexJob(e.sender, input.path, true, input.name.trim() || '业务知识库')
    return { ok: true }
  })
  // 点「刷新」：增量
  ipcMain.handle('kb:refresh', (e) => {
    const kb = getKb()
    if (!kb.rootPath) return { ok: false, error: '尚未配置知识库' }
    void runIndexJob(e.sender, kb.rootPath, false)
    return { ok: true }
  })
  ipcMain.handle('conv:setKb', (_e, input: { id: string; enabled: boolean }) =>
    setConversationKb(input.id, input.enabled)
  )

  // ── MCP 服务 ──────────────────────────────────────
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

  // 打开来源文档（侧板阅读视图）：读磁盘现状；校验片段用消息自带的原文快照，此处不查库
  ipcMain.handle('doc:open', (_e, filePath: string) => {
    const kb = getKb()
    if (!kb.rootPath) return { ok: false, reason: 'no-kb' }
    if (kbBusy()) return { ok: false, reason: 'busy' }
    const root = resolve(kb.rootPath)
    const abs = resolve(join(root, filePath))
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
