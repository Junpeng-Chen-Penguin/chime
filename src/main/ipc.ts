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
import { startChat, stopChat, type SendPayload } from './chat'
import { getKb, kbStats, setConversationKb, setKbMeta, resetKb } from './db'
import { kbBusy, runIndexJob, validateRepoPath, getLastSummary } from './kb'

export function registerIpc(): void {
  // 读取配置：明文密钥不出主进程，只回打码串
  ipcMain.handle('provider:get', () => {
    const p = getProvider()
    return {
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      keyMask: maskApiKey(p.apiKey),
      hasKey: !!p.apiKey
    }
  })

  ipcMain.handle(
    'provider:save',
    (_e, input: { baseUrl: string; defaultModel: string; apiKey: string | null }) => {
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

  // 流式对话：事件单向推送，不用 invoke
  ipcMain.on('chat:send', (e, payload: SendPayload) => {
    startChat(e.sender, payload)
  })
  ipcMain.on('chat:stop', (_e, streamId: string) => {
    stopChat(streamId)
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
      indexedAt: kb.indexedAt,
      busy: kbBusy(),
      lastSummary: getLastSummary(),
      ...kbStats()
    }
  })
  // 改名：纯元数据，不触发任何索引
  ipcMain.handle('kb:rename', (_e, name: string) => {
    setKbMeta({ name: name.trim() || '业务知识库' })
  })
  // 移除：清空索引数据并复位（不影响 git 仓库本身）
  ipcMain.handle('kb:remove', () => {
    if (kbBusy()) return { ok: false, error: '知识库处理中，请稍后再试' }
    resetKb()
    return { ok: true }
  })
  // 点「构建」：校验 → 整库重建（换路径与首次构建同语义）
  ipcMain.handle('kb:build', async (e, input: { path: string; name: string }) => {
    const invalid = await validateRepoPath(input.path)
    if (invalid) return { ok: false, error: invalid }
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
