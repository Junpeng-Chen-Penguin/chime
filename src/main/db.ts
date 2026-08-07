import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { VENDORS, WINDOW_FALLBACK, vendorFromBaseUrl } from './vendors'
import { seal, unseal, isSealed, canSeal } from './secret'

export interface ProviderRow {
  apiKey: string
  baseUrl: string
  defaultModel: string
  defaultWindow: number
}

let db: Database.Database

export function initDb(): void {
  db = new Database(join(app.getPath('userData'), 'chime.db'))
  db.pragma('journal_mode = WAL')
  // 换库：检测到旧结构（message 无 items 列）即清掉会话数据重建——老会话不迁移（PRD Case 1）
  const msgCols = db.prepare('PRAGMA table_info(message)').all() as { name: string }[]
  if (msgCols.length && !msgCols.some((c) => c.name === 'items')) {
    db.exec('DROP TABLE IF EXISTS message; DROP TABLE IF EXISTS conversation;')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider (
      vendor       TEXT PRIMARY KEY,
      api_key      TEXT NOT NULL DEFAULT '',
      base_url     TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 0,
      models       TEXT NOT NULL DEFAULT '[]',
      extra_params TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL DEFAULT '新对话',
      model        TEXT NOT NULL DEFAULT '',
      kb_selection TEXT,
      title_auto   INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      items           TEXT,
      usage           TEXT,
      status          TEXT NOT NULL DEFAULT 'done',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_conv ON message (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS kb (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      intro           TEXT NOT NULL DEFAULT '',
      root_path       TEXT NOT NULL,
      embed_model     TEXT NOT NULL DEFAULT '',
      chunker_version INTEGER NOT NULL DEFAULT 0,
      indexed_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS kb_file (
      kb_id        INTEGER NOT NULL,
      path         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (kb_id, path)
    );

    CREATE TABLE IF NOT EXISTS chunk (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kb_id        INTEGER NOT NULL DEFAULT 0,
      file_path    TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      content      TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_file ON chunk (file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(seg_text);

    CREATE TABLE IF NOT EXISTS mcp_service (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL,
      headers    TEXT NOT NULL DEFAULT '{}',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tool_result (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id    TEXT NOT NULL,
      tool_call_id       TEXT NOT NULL,
      tool_name          TEXT NOT NULL,
      content            TEXT NOT NULL,
      structured_content TEXT,
      chars              INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      title           TEXT NOT NULL,
      columns         TEXT NOT NULL,
      rows            TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `)
  // 迁移（Case 8 会话选用工具）：本会话选用的 MCP 服务 id 清单（JSON 数组；NULL/空 = 未选用任何服务）
  try {
    db.exec('ALTER TABLE conversation ADD COLUMN mcp_selection TEXT')
  } catch {
    // 列已存在
  }
  // 迁移（011 Case 4/5 服务级信任）：信任只读声明开关 + 开启时的清单指纹 + 变更标识
  for (const col of [
    "ALTER TABLE mcp_service ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mcp_service ADD COLUMN tools_fingerprint TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE mcp_service ADD COLUMN tools_changed INTEGER NOT NULL DEFAULT 0"
  ]) {
    try {
      db.exec(col)
    } catch {
      // 列已存在
    }
  }
  migrateV1()
  // chunk.kb_id 索引：旧库要等迁移加上列才能建，故放建表段之后
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunk_kb ON chunk (kb_id)')
  // 预置服务商行就位（迁移后/新装均补齐缺的行）
  const insVendor = db.prepare('INSERT OR IGNORE INTO provider (vendor, base_url) VALUES (?, ?)')
  for (const v of VENDORS) insVendor.run(v.vendor, v.baseUrl)
}

// v1.0.0 迁移：知识库单库 → 多库、模型服务单套 → 按服务商分行、用量落库。
// 判据：旧 kb 表带 last_commit 列（单库 git 时代的遗留）。整体一个事务，中途失败原样回滚。
function migrateV1(): void {
  const kbCols = db.prepare('PRAGMA table_info(kb)').all() as { name: string }[]
  const oldKb = kbCols.some((c) => c.name === 'last_commit')
  const provCols = db.prepare('PRAGMA table_info(provider)').all() as { name: string }[]
  const oldProv = provCols.some((c) => c.name === 'default_model')
  if (!oldKb && !oldProv) return

  db.transaction(() => {
    if (oldKb) {
      // kb 单行 CHECK(id=1) → 多行；原库（root_path 非空）迁为第一行，索引与文件哈希整体挂到它名下
      db.exec(`CREATE TABLE kb_v1 (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        intro           TEXT NOT NULL DEFAULT '',
        root_path       TEXT NOT NULL,
        embed_model     TEXT NOT NULL DEFAULT '',
        chunker_version INTEGER NOT NULL DEFAULT 0,
        indexed_at      INTEGER
      )`)
      const old = db
        .prepare('SELECT root_path AS rootPath, name, intro, embed_model AS embedModel, indexed_at AS indexedAt FROM kb WHERE id = 1')
        .get() as { rootPath: string; name: string; intro: string; embedModel: string; indexedAt: number | null } | undefined
      let firstId = 0
      if (old?.rootPath) {
        // chunker_version 置当前值：索引是现行切块器建的，不触发全量重建
        const r = db
          .prepare('INSERT INTO kb_v1 (name, intro, root_path, embed_model, chunker_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(old.name, old.intro, old.rootPath, old.embedModel, CHUNKER_VERSION_AT_MIGRATION, old.indexedAt)
        firstId = Number(r.lastInsertRowid)
      }
      db.exec('DROP TABLE kb')
      db.exec('ALTER TABLE kb_v1 RENAME TO kb')

      db.exec('ALTER TABLE chunk ADD COLUMN kb_id INTEGER NOT NULL DEFAULT 0')
      db.exec('CREATE INDEX IF NOT EXISTS idx_chunk_kb ON chunk (kb_id)')
      db.exec(`CREATE TABLE kb_file_v1 (
        kb_id        INTEGER NOT NULL,
        path         TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (kb_id, path)
      )`)
      if (firstId) {
        db.prepare('UPDATE chunk SET kb_id = ?').run(firstId)
        db.prepare('INSERT INTO kb_file_v1 (kb_id, path, content_hash) SELECT ?, path, content_hash FROM kb_file').run(firstId)
      }
      db.exec('DROP TABLE kb_file')
      db.exec('ALTER TABLE kb_file_v1 RENAME TO kb_file')

      // 会话选库：kb_enabled=1 的历史会话 → kb_selection（含库名快照）
      db.exec('ALTER TABLE conversation ADD COLUMN kb_selection TEXT')
      if (firstId && old) {
        db.prepare('UPDATE conversation SET kb_selection = ? WHERE kb_enabled = 1').run(
          JSON.stringify([{ id: firstId, name: old.name }])
        )
      }
      // 用量落库（Case 5）
      db.exec('ALTER TABLE message ADD COLUMN usage TEXT')
    }

    if (oldProv) {
      // provider 单行 → 按 vendor 分行；按 base_url 判归属，匹配不上归 deepseek 并保留原地址
      const old = db
        .prepare('SELECT api_key AS apiKey, base_url AS baseUrl, default_model AS defaultModel FROM provider WHERE id = 1')
        .get() as { apiKey: string; baseUrl: string; defaultModel: string } | undefined
      db.exec(`CREATE TABLE provider_v1 (
        vendor       TEXT PRIMARY KEY,
        api_key      TEXT NOT NULL DEFAULT '',
        base_url     TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 0,
        models       TEXT NOT NULL DEFAULT '[]',
        extra_params TEXT NOT NULL DEFAULT '{}'
      )`)
      db.exec('DROP TABLE provider')
      db.exec('ALTER TABLE provider_v1 RENAME TO provider')
      db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      if (old?.apiKey) {
        const vendor = vendorFromBaseUrl(old.baseUrl)
        const models = old.defaultModel ? JSON.stringify([{ id: old.defaultModel, picked: true }]) : '[]'
        db.prepare('INSERT INTO provider (vendor, api_key, base_url, enabled, models) VALUES (?, ?, ?, 1, ?)').run(
          vendor,
          old.apiKey,
          old.baseUrl,
          models
        )
        if (old.defaultModel) {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
            'default_model',
            `${vendor}:${old.defaultModel}`
          )
        }
      }
    }
  })()
}

// 迁移时写入的切块器版本：与 shared/chunker 的现行版本一致（模块 2 起从 chunker 导出，此处先落常量）
const CHUNKER_VERSION_AT_MIGRATION = 1

// engine/store 是消息的唯一写者，经此拿库连接
export function getDb(): Database.Database {
  return db
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

// ── 多服务商正式接口（PRD Case 6/7）──────────────────

export interface ProviderModel {
  id: string
  picked: boolean
  offline?: boolean // 再次拉取清单时已不在返回中（不自动取消勾选）
}

export interface ProviderRecord {
  vendor: string
  apiKey: string
  baseUrl: string
  enabled: boolean
  models: ProviderModel[]
  extraParams: Record<string, unknown>
}

export function listProviderRecords(): ProviderRecord[] {
  const rows = db
    .prepare('SELECT vendor, api_key AS apiKey, base_url AS baseUrl, enabled, models, extra_params AS extraParams FROM provider')
    .all() as { vendor: string; apiKey: string; baseUrl: string; enabled: number; models: string; extraParams: string }[]
  const order = new Map(VENDORS.map((v, i) => [v.vendor, i]))
  return rows
    .map((r) => {
      let models: ProviderModel[] = []
      let extra: Record<string, unknown> = {}
      try {
        models = JSON.parse(r.models)
      } catch {
        // 坏数据按空处理
      }
      try {
        extra = JSON.parse(r.extraParams)
      } catch {
        // 同上
      }
      return { vendor: r.vendor, apiKey: unseal(r.apiKey), baseUrl: r.baseUrl, enabled: !!r.enabled, models, extraParams: extra }
    })
    .sort((a, b) => (order.get(a.vendor) ?? 99) - (order.get(b.vendor) ?? 99))
}

export function getProviderRecord(vendor: string): ProviderRecord | null {
  return listProviderRecords().find((p) => p.vendor === vendor) ?? null
}

// patch 语义：apiKey 为 null 沿用已存（界面未改动）；未传的字段不动
export function saveProviderRecord(
  vendor: string,
  patch: Partial<{ apiKey: string | null; baseUrl: string; enabled: boolean; models: ProviderModel[]; extraParams: Record<string, unknown> }>
): void {
  const cur = getProviderRecord(vendor)
  if (!cur) return
  const apiKey = patch.apiKey === undefined || patch.apiKey === null ? cur.apiKey : patch.apiKey
  db.prepare('UPDATE provider SET api_key = ?, base_url = ?, enabled = ?, models = ?, extra_params = ? WHERE vendor = ?').run(
    seal(apiKey), // cur.apiKey 已由 listProviderRecords 解密，这里统一按明文入口加密
    patch.baseUrl ?? cur.baseUrl,
    (patch.enabled ?? cur.enabled) ? 1 : 0,
    JSON.stringify(patch.models ?? cur.models),
    JSON.stringify(patch.extraParams ?? cur.extraParams),
    vendor
  )
}

// 默认模型（vendor:model）；失效时退到任一已启用服务商的首个勾选模型
export function getDefaultModelRef(): string {
  const ref = getSetting('default_model') ?? ''
  const check = (r: string): boolean => {
    const i = r.indexOf(':')
    if (i < 0) return false
    const p = getProviderRecord(r.slice(0, i))
    return !!p && p.enabled && p.models.some((m) => m.picked && m.id === r.slice(i + 1))
  }
  if (check(ref)) return ref
  for (const p of listProviderRecords()) {
    if (!p.enabled) continue
    const m = p.models.find((x) => x.picked)
    if (m) return `${p.vendor}:${m.id}`
  }
  return ref
}

export function setDefaultModelRef(ref: string): void {
  setSetting('default_model', ref)
}

// 每轮调用的模型定位：vendor:model（历史无前缀按 deepseek）→ 该服务商的连接信息
export function resolveModelRef(
  ref: string
): { vendor: string; model: string; apiKey: string; baseUrl: string; extraParams: Record<string, unknown>; enabled: boolean } | null {
  const i = ref.indexOf(':')
  const vendor = i < 0 ? 'deepseek' : ref.slice(0, i)
  const model = i < 0 ? ref : ref.slice(i + 1)
  const p = getProviderRecord(vendor)
  if (!p) return null
  return { vendor, model, apiKey: p.apiKey, baseUrl: p.baseUrl, extraParams: p.extraParams, enabled: p.enabled }
}

// ── 兼容壳（模块 4 多服务商界面就位后移除）：以「默认模型所属服务商」拼出旧的单套配置形状 ──
export function getProvider(): ProviderRow {
  const ref = getSetting('default_model') ?? ''
  const i = ref.indexOf(':')
  const vendor = i < 0 ? 'deepseek' : ref.slice(0, i)
  const model = i < 0 ? ref : ref.slice(i + 1)
  const row = db.prepare('SELECT api_key AS apiKey, base_url AS baseUrl FROM provider WHERE vendor = ?').get(vendor) as
    | { apiKey: string; baseUrl: string }
    | undefined
  return {
    apiKey: unseal(row?.apiKey ?? ''),
    baseUrl: row?.baseUrl ?? VENDORS[0].baseUrl,
    defaultModel: model,
    defaultWindow: WINDOW_FALLBACK
  }
}

export function saveProvider(input: {
  apiKey: string | null
  baseUrl: string
  defaultModel: string
  defaultWindow?: number
}): void {
  // 兼容壳：按 base_url 判服务商写入对应行；defaultWindow 弃用（窗口随模型走）
  const vendor = vendorFromBaseUrl(input.baseUrl)
  const cur = db.prepare('SELECT api_key AS apiKey FROM provider WHERE vendor = ?').get(vendor) as
    | { apiKey: string }
    | undefined
  // cur 直接读列，可能已是密文——沿用时原样透传，新值才加密
  const apiKey = input.apiKey === null ? (cur?.apiKey ?? '') : seal(input.apiKey)
  const models = input.defaultModel ? JSON.stringify([{ id: input.defaultModel, picked: true }]) : '[]'
  db.prepare(
    'INSERT INTO provider (vendor, api_key, base_url, enabled, models) VALUES (?, ?, ?, 1, ?) ON CONFLICT(vendor) DO UPDATE SET api_key = ?, base_url = ?, enabled = 1, models = ?'
  ).run(vendor, apiKey, input.baseUrl, models, apiKey, input.baseUrl, models)
  if (input.defaultModel) setSetting('default_model', `${vendor}:${input.defaultModel}`)
}

// 仅用于界面展示，明文密钥不离开主进程
export function maskApiKey(key: string): string {
  // 掩码不带密钥原文（首尾字符也不露），只表示「已保存」
  return key ? '••••••••' : ''
}

export interface ConversationRow {
  id: string
  title: string
  model: string
  updatedAt: number
  kbSelection?: KbSelEntry[]
}

export interface MessageRow {
  id: string
  conversationId: string
  role: string
  content: string
  items: string | null // 一轮的有序过程记录（JSON），仅 assistant 行有
  usage: string | null // {input, output, cached} JSON；中断轮为 NULL
  status: string
  createdAt: number
}

export function listConversations(): ConversationRow[] {
  const rows = db
    .prepare(
      'SELECT id, title, model, updated_at AS updatedAt, kb_selection AS kbSelection FROM conversation ORDER BY updated_at DESC'
    )
    .all() as unknown as { id: string; title: string; model: string; updatedAt: number; kbSelection: string | null }[]
  return rows.map((r) => {
    let sel: KbSelEntry[] = []
    try {
      if (r.kbSelection) sel = JSON.parse(r.kbSelection)
    } catch {
      // 坏数据按未选处理
    }
    return { ...r, kbSelection: sel }
  })
}

export function createConversation(id: string, model: string, now: number): ConversationRow {
  db.prepare(
    'INSERT INTO conversation (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, '新对话', model, now, now)
  return { id, title: '新对话', model, updatedAt: now }
}

export function deleteConversation(id: string): void {
  db.prepare('DELETE FROM message WHERE conversation_id = ?').run(id)
  db.prepare('DELETE FROM tool_result WHERE conversation_id = ?').run(id) // 结果随会话删除（未启用外键，手工清）
  db.prepare('DELETE FROM artifact WHERE conversation_id = ?').run(id) // 制品随会话删除
  db.prepare('DELETE FROM conversation WHERE id = ?').run(id)
}

// ── 制品库（自包含快照：生成那一刻数据完整物化，不依赖结果库）──────────

export interface ArtifactRow {
  id: number
  title: string
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
}

export function insertArtifact(row: {
  conversationId: string
  title: string
  columns: { key: string; label: string }[]
  rows: Record<string, unknown>[]
}): number {
  const r = db
    .prepare('INSERT INTO artifact (conversation_id, title, columns, rows, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.conversationId, row.title, JSON.stringify(row.columns), JSON.stringify(row.rows), Date.now())
  return Number(r.lastInsertRowid)
}

export function getArtifact(id: number): ArtifactRow | null {
  const row = db.prepare('SELECT id, title, columns, rows FROM artifact WHERE id = ?').get(id) as
    | { id: number; title: string; columns: string; rows: string }
    | undefined
  if (!row) return null
  return { ...row, columns: JSON.parse(row.columns), rows: JSON.parse(row.rows) }
}

// ── 超限结果库（工具结果超限处理机制）────────────────────
// 全量原样落库，自增 id 即「结果编号」；本会话内一直有效，跨会话不可用

export function insertToolResult(row: {
  conversationId: string
  toolCallId: string
  toolName: string
  content: string
  structuredContent?: string | null
}): number {
  const r = db
    .prepare(
      `INSERT INTO tool_result (conversation_id, tool_call_id, tool_name, content, structured_content, chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.conversationId,
      row.toolCallId,
      row.toolName,
      row.content,
      row.structuredContent ?? null,
      row.content.length,
      Date.now()
    )
  return Number(r.lastInsertRowid)
}

export function getToolResult(
  id: number,
  conversationId: string
): { content: string; chars: number; structuredContent: string | null } | null {
  const row = db
    .prepare('SELECT content, chars, structured_content AS structuredContent FROM tool_result WHERE id = ? AND conversation_id = ?')
    .get(id, conversationId) as { content: string; chars: number; structuredContent: string | null } | undefined
  return row ?? null
}

// 压力降级补存小结果时的幂等查找：同一调用清除过一次就复用编号，不重复插行
export function findToolResultIdByCallId(toolCallId: string): number | null {
  const row = db.prepare('SELECT id FROM tool_result WHERE tool_call_id = ? LIMIT 1').get(toolCallId) as
    | { id: number }
    | undefined
  return row?.id ?? null
}

// 跨结果搜索用：本会话全部已存结果（按编号升序）
export function listToolResults(conversationId: string): { id: number; content: string }[] {
  return db
    .prepare('SELECT id, content FROM tool_result WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as { id: number; content: string }[]
}

export function getMessages(conversationId: string): MessageRow[] {
  return db
    .prepare(
      'SELECT id, conversation_id AS conversationId, role, content, items, usage, status, created_at AS createdAt FROM message WHERE conversation_id = ? ORDER BY created_at'
    )
    .all(conversationId) as MessageRow[]
}

export function getConversationMeta(id: string): { title: string; titleAuto: boolean } | null {
  const row = db
    .prepare('SELECT title, title_auto AS titleAuto FROM conversation WHERE id = ?')
    .get(id) as { title: string; titleAuto: number } | undefined
  return row ? { title: row.title, titleAuto: !!row.titleAuto } : null
}

export function setConversationTitle(id: string, title: string, auto: boolean): void {
  db.prepare('UPDATE conversation SET title = ?, title_auto = ? WHERE id = ?').run(
    title,
    auto ? 1 : 0,
    id
  )
}

// ── 知识库 ──────────────────────────────────────────

export interface KbRow {
  rootPath: string
  name: string
  intro: string
  lastCommit: string | null // 弃用恒 null（去 git 化）；模块 2b 移除
  embedModel: string
  chunkerVersion: number
  indexedAt: number | null
}

export interface ChunkInput {
  headingPath: string
  startLine: number
  endLine: number
  content: string
  embedding: Buffer
  segText: string // 分词后的检索文本
}

// ── 多库正式接口（PRD Case 1/2）──────────────────────

export interface KbListRow {
  id: number
  name: string
  intro: string
  rootPath: string
  embedModel: string
  chunkerVersion: number
  indexedAt: number | null
}

export function listKbs(): KbListRow[] {
  return db
    .prepare(
      'SELECT id, name, intro, root_path AS rootPath, embed_model AS embedModel, chunker_version AS chunkerVersion, indexed_at AS indexedAt FROM kb ORDER BY id'
    )
    .all() as KbListRow[]
}

export function getKbById(id: number): KbListRow | null {
  return (listKbs().find((k) => k.id === id) ?? null) as KbListRow | null
}

// 建库：重名拒绝（Tuner 用例与会话快照都按库名定位）
export function createKb(name: string, intro: string, rootPath: string): { ok: true; id: number } | { ok: false; error: string } {
  const dup = db.prepare('SELECT id FROM kb WHERE name = ?').get(name)
  if (dup) return { ok: false, error: '已存在同名知识库，请换一个名称' }
  const r = db.prepare('INSERT INTO kb (name, intro, root_path) VALUES (?, ?, ?)').run(name, intro, rootPath)
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function updateKb(
  id: number,
  meta: Partial<{ name: string; intro: string; rootPath: string; embedModel: string; chunkerVersion: number; indexedAt: number | null }>
): { ok: true } | { ok: false; error: string } {
  const cur = getKbById(id)
  if (!cur) return { ok: false, error: '知识库不存在' }
  if (meta.name && meta.name !== cur.name) {
    const dup = db.prepare('SELECT id FROM kb WHERE name = ? AND id != ?').get(meta.name, id)
    if (dup) return { ok: false, error: '已存在同名知识库，请换一个名称' }
  }
  db.prepare(
    'UPDATE kb SET name = ?, intro = ?, root_path = ?, embed_model = ?, chunker_version = ?, indexed_at = ? WHERE id = ?'
  ).run(
    meta.name ?? cur.name,
    meta.intro ?? cur.intro,
    meta.rootPath ?? cur.rootPath,
    meta.embedModel ?? cur.embedModel,
    meta.chunkerVersion ?? cur.chunkerVersion,
    meta.indexedAt === undefined ? cur.indexedAt : meta.indexedAt,
    id
  )
  return { ok: true }
}

// 移除库：索引数据一并清除，源文件夹不受影响；历史会话的引用靠 kb_selection 快照与消息内来源快照存续
export function deleteKb(id: number): void {
  clearKbDataFor(id)
  db.prepare('DELETE FROM kb WHERE id = ?').run(id)
}

export function kbStatsFor(id: number): { files: number; chunks: number } {
  const files = (db.prepare('SELECT COUNT(*) AS n FROM kb_file WHERE kb_id = ?').get(id) as { n: number }).n
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunk WHERE kb_id = ?').get(id) as { n: number }).n
  return { files, chunks }
}

export function listKbFilesFor(id: number): { path: string; hash: string }[] {
  return db.prepare('SELECT path, content_hash AS hash FROM kb_file WHERE kb_id = ?').all(id) as {
    path: string
    hash: string
  }[]
}

export function clearKbDataFor(id: number): void {
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chunk WHERE kb_id = ?').all(id) as { id: number }[]
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id: cid } of ids) delFts.run(cid)
    db.prepare('DELETE FROM chunk WHERE kb_id = ?').run(id)
    db.prepare('DELETE FROM kb_file WHERE kb_id = ?').run(id)
    db.prepare('UPDATE kb SET indexed_at = NULL WHERE id = ?').run(id)
  })()
}

export function deleteKbFileFor(kbId: number, path: string): void {
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chunk WHERE kb_id = ? AND file_path = ?').all(kbId, path) as { id: number }[]
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    db.prepare('DELETE FROM chunk WHERE kb_id = ? AND file_path = ?').run(kbId, path)
    db.prepare('DELETE FROM kb_file WHERE kb_id = ? AND path = ?').run(kbId, path)
  })()
}

export function replaceKbFileFor(kbId: number, path: string, hash: string, chunks: ChunkInput[]): void {
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chunk WHERE kb_id = ? AND file_path = ?').all(kbId, path) as { id: number }[]
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    db.prepare('DELETE FROM chunk WHERE kb_id = ? AND file_path = ?').run(kbId, path)

    const insChunk = db.prepare(
      'INSERT INTO chunk (kb_id, file_path, heading_path, start_line, end_line, content, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    // FTS rowid 显式对齐 chunk.id（自动分配在删除后必然错位）
    const insFts = db.prepare('INSERT INTO chunk_fts (rowid, seg_text) VALUES (?, ?)')
    for (const c of chunks) {
      const rowid = insChunk.run(kbId, path, c.headingPath, c.startLine, c.endLine, c.content, c.embedding)
        .lastInsertRowid as number
      insFts.run(rowid, c.segText)
    }
    db.prepare(
      'INSERT INTO kb_file (kb_id, path, content_hash) VALUES (?, ?, ?) ON CONFLICT(kb_id, path) DO UPDATE SET content_hash = ?'
    ).run(kbId, path, hash, hash)
  })()
}

// 第一个库的 id（兼容壳期内全部 kb 操作落在它身上；无库返回 null）
function firstKbId(): number | null {
  const row = db.prepare('SELECT id FROM kb ORDER BY id LIMIT 1').get() as { id: number } | undefined
  return row?.id ?? null
}

// ── 兼容壳（模块 2 多库构建就位后改为按 id 的多库函数）：一切按第一个库 ──
export function getKb(): KbRow {
  const row = db
    .prepare(
      'SELECT root_path AS rootPath, name, intro, embed_model AS embedModel, chunker_version AS chunkerVersion, indexed_at AS indexedAt FROM kb ORDER BY id LIMIT 1'
    )
    .get() as Omit<KbRow, 'lastCommit'> | undefined
  if (!row)
    return { rootPath: '', name: '业务知识库', intro: '', lastCommit: null, embedModel: '', chunkerVersion: 0, indexedAt: null }
  return { ...row, lastCommit: null }
}

export function setKbMeta(
  meta: Partial<{
    rootPath: string
    name: string
    intro: string
    lastCommit: string | null
    embedModel: string
    chunkerVersion: number
    indexedAt: number
  }>
): void {
  const id = firstKbId()
  if (id === null) {
    db.prepare('INSERT INTO kb (name, intro, root_path, embed_model, chunker_version, indexed_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      meta.name ?? '业务知识库',
      meta.intro ?? '',
      meta.rootPath ?? '',
      meta.embedModel ?? '',
      meta.chunkerVersion ?? 0,
      meta.indexedAt ?? null
    )
    return
  }
  const cur = getKb()
  db.prepare(
    'UPDATE kb SET root_path = ?, name = ?, intro = ?, embed_model = ?, chunker_version = ?, indexed_at = ? WHERE id = ?'
  ).run(
    meta.rootPath ?? cur.rootPath,
    meta.name ?? cur.name,
    meta.intro ?? cur.intro,
    meta.embedModel ?? cur.embedModel,
    meta.chunkerVersion ?? cur.chunkerVersion,
    meta.indexedAt ?? cur.indexedAt,
    id
  )
}

export function kbStats(): { files: number; chunks: number } {
  const id = firstKbId()
  if (id === null) return { files: 0, chunks: 0 }
  const files = (db.prepare('SELECT COUNT(*) AS n FROM kb_file WHERE kb_id = ?').get(id) as { n: number }).n
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunk WHERE kb_id = ?').get(id) as { n: number }).n
  return { files, chunks }
}

export function listKbFiles(): { path: string; hash: string }[] {
  const id = firstKbId()
  if (id === null) return []
  return db.prepare('SELECT path, content_hash AS hash FROM kb_file WHERE kb_id = ?').all(id) as {
    path: string
    hash: string
  }[]
}

// 移除知识库：清数据并删库行（多库表里空态 = 无行）
export function resetKb(): void {
  clearKbData()
  const id = firstKbId()
  if (id !== null) db.prepare('DELETE FROM kb WHERE id = ?').run(id)
}

// 换路径 / 重新构建：清第一个库的全部数据（兼容壳）
export const clearKbData = (): void => {
  const id = firstKbId()
  if (id !== null) clearKbDataFor(id)
}

// 兼容壳
export function deleteKbFile(path: string): void {
  const id = firstKbId()
  if (id !== null) deleteKbFileFor(id, path)
}

// 兼容壳
export function replaceKbFile(path: string, hash: string, chunks: ChunkInput[]): void {
  const id = firstKbId()
  if (id !== null) replaceKbFileFor(id, path, hash, chunks)
}

export function loadAllEmbeddings(): { id: number; kbId: number; embedding: Buffer }[] {
  return db.prepare('SELECT id, kb_id AS kbId, embedding FROM chunk').all() as {
    id: number
    kbId: number
    embedding: Buffer
  }[]
}

// 向量缓存的失效键：任一库重建即变化，整体重载（几千片段全量重载毫秒级，不做按库分片）
export function kbMaxIndexedAt(): number | null {
  const row = db.prepare('SELECT MAX(indexed_at) AS m FROM kb').get() as { m: number | null }
  return row.m
}

export interface ChunkRow {
  id: number
  kbId: number
  filePath: string
  headingPath: string
  startLine: number
  endLine: number
  content: string
}

export function getChunksByIds(ids: number[]): ChunkRow[] {
  if (ids.length === 0) return []
  const rows = db
    .prepare(
      `SELECT id, kb_id AS kbId, file_path AS filePath, heading_path AS headingPath, start_line AS startLine, end_line AS endLine, content
       FROM chunk WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as ChunkRow[]
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

// BM25 检索：返回 chunk id（bm25 分数越小越相关，这里只用名次）。
// 库范围过滤走 JOIN（fts rowid 与 chunk.id 显式对齐），FTS 表自身不带库标识
export function ftsSearch(matchQuery: string, limit: number, kbIds: number[]): number[] {
  if (!matchQuery.trim() || kbIds.length === 0) return []
  const ph = kbIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT f.rowid FROM chunk_fts f JOIN chunk c ON c.id = f.rowid WHERE chunk_fts MATCH ? AND c.kb_id IN (${ph}) ORDER BY bm25(chunk_fts) LIMIT ?`
    )
    .all(matchQuery, ...kbIds, limit) as { rowid: number }[]
  return rows.map((r) => r.rowid)
}

// ── MCP 服务 ──────────────────────────────────────

export interface McpServiceRow {
  id: number
  name: string
  url: string
  headers: Record<string, string> // 认证请求头键值对，明文只在主进程
  enabled: boolean
  trusted: boolean // 信任只读声明（011 Case 4）：开启后 readOnlyHint 为真的工具免授权确认
  toolsFingerprint: string // 开启信任时的清单指纹（Case 5 比对基准）
  toolsChanged: boolean // 已信任服务的清单发生过变更（提示标识，重新开启信任时清除）
}

export function listMcpServices(): McpServiceRow[] {
  const rows = db
    .prepare(
      'SELECT id, name, url, headers, enabled, trusted, tools_fingerprint AS toolsFingerprint, tools_changed AS toolsChanged FROM mcp_service ORDER BY created_at'
    )
    .all() as {
    id: number
    name: string
    url: string
    headers: string
    enabled: number
    trusted: number
    toolsFingerprint: string
    toolsChanged: number
  }[]
  // headers 整体加密（里面除了认证凭据没有别的），解开后再 parse
  return rows.map((r) => ({
    ...r,
    headers: JSON.parse(unseal(r.headers) || '{}'),
    enabled: !!r.enabled,
    trusted: !!r.trusted,
    toolsChanged: !!r.toolsChanged
  }))
}

export function getMcpService(id: number): McpServiceRow | null {
  return listMcpServices().find((s) => s.id === id) ?? null
}

// headers 为 null 表示沿用已存的认证信息（界面未改动，与 provider 密钥同一约定）
export function saveMcpService(input: {
  id?: number
  name: string
  url: string
  headers: Record<string, string> | null
  enabled: boolean
}): number {
  if (input.id) {
    const cur = getMcpService(input.id)
    const headers = input.headers ?? cur?.headers ?? {}
    // 连接目标（URL/认证）变了，信任基础不复存在，自动撤销；仅改显示名不影响（011 Case 4）
    const targetChanged =
      cur && (cur.url !== input.url || JSON.stringify(cur.headers) !== JSON.stringify(headers))
    db.prepare('UPDATE mcp_service SET name = ?, url = ?, headers = ?, enabled = ? WHERE id = ?').run(
      input.name,
      input.url,
      seal(JSON.stringify(headers)),
      input.enabled ? 1 : 0,
      input.id
    )
    if (targetChanged) {
      db.prepare(
        "UPDATE mcp_service SET trusted = 0, tools_fingerprint = '', tools_changed = 0 WHERE id = ?"
      ).run(input.id)
    }
    return input.id
  }
  const r = db
    .prepare('INSERT INTO mcp_service (name, url, headers, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.url, seal(JSON.stringify(input.headers ?? {})), input.enabled ? 1 : 0, Date.now())
  return Number(r.lastInsertRowid)
}

// 信任开关（011 Case 4）：开启记当前清单指纹并清变更标识；关闭清空
export function setMcpTrusted(id: number, trusted: boolean, fingerprint: string): void {
  db.prepare(
    "UPDATE mcp_service SET trusted = ?, tools_fingerprint = ?, tools_changed = 0 WHERE id = ?"
  ).run(trusted ? 1 : 0, trusted ? fingerprint : '', id)
}

// 已信任服务清单变更（011 Case 5）：自动关信任、置提示标识
export function markMcpToolsChanged(id: number): void {
  db.prepare("UPDATE mcp_service SET trusted = 0, tools_fingerprint = '', tools_changed = 1 WHERE id = ?").run(id)
}

// 存量明文凭据一次性转密文。必须在 app ready 之后调用——safeStorage 此前不可用，
// 提前跑会因为 canSeal 为 false 直接跳过，明文继续留在库里。
export function migrateSecrets(): void {
  if (!canSeal()) return
  const provs = db.prepare('SELECT vendor, api_key AS apiKey FROM provider').all() as { vendor: string; apiKey: string }[]
  for (const p of provs) {
    if (p.apiKey && !isSealed(p.apiKey)) {
      db.prepare('UPDATE provider SET api_key = ? WHERE vendor = ?').run(seal(p.apiKey), p.vendor)
    }
  }
  const svcs = db.prepare('SELECT id, headers FROM mcp_service').all() as { id: number; headers: string }[]
  for (const s of svcs) {
    if (s.headers && s.headers !== '{}' && !isSealed(s.headers)) {
      db.prepare('UPDATE mcp_service SET headers = ? WHERE id = ?').run(seal(s.headers), s.id)
    }
  }
}

// 删除服务：历史会话的调用行、授权记录等全部保留（存在 message.items 里，与服务表无外键）
export function deleteMcpService(id: number): void {
  db.prepare('DELETE FROM mcp_service WHERE id = ?').run(id)
}

// ── 兼容壳（模块 3 会话多选库就位后改为 selection 版）：单开关映射为「第一个库」的选择 ──
export function setConversationKb(id: string, enabled: boolean): void {
  if (!enabled) {
    db.prepare('UPDATE conversation SET kb_selection = NULL WHERE id = ?').run(id)
    return
  }
  const kbId = firstKbId()
  const kb = getKb()
  const sel = kbId !== null ? JSON.stringify([{ id: kbId, name: kb.name }]) : null
  db.prepare('UPDATE conversation SET kb_selection = ? WHERE id = ?').run(sel, id)
}

export function getConversationKb(id: string): boolean {
  return getConversationKbSelection(id).length > 0
}

// 会话选库列表（PRD Case 3）：[{id, name}]，name 为库名快照——库被移除后历史会话仍能显示原名
export interface KbSelEntry {
  id: number
  name: string
}

export function setConversationKbSelection(id: string, sel: KbSelEntry[]): void {
  db.prepare('UPDATE conversation SET kb_selection = ? WHERE id = ?').run(sel.length ? JSON.stringify(sel) : null, id)
}

export function getConversationKbSelection(id: string): KbSelEntry[] {
  const row = db.prepare('SELECT kb_selection AS s FROM conversation WHERE id = ?').get(id) as
    | { s: string | null }
    | undefined
  if (!row?.s) return []
  try {
    const v = JSON.parse(row.s)
    return Array.isArray(v) ? v.filter((e) => e && Number.isInteger(e.id)) : []
  } catch {
    return []
  }
}

// 会话选用的 MCP 服务（Case 8）：NULL/解析失败按未选用处理
export function setConversationMcpSelection(id: string, serviceIds: number[]): void {
  db.prepare('UPDATE conversation SET mcp_selection = ? WHERE id = ?').run(JSON.stringify(serviceIds), id)
}

export function getConversationMcpSelection(id: string): number[] {
  const row = db.prepare('SELECT mcp_selection AS s FROM conversation WHERE id = ?').get(id) as
    | { s: string | null }
    | undefined
  if (!row?.s) return []
  try {
    const v = JSON.parse(row.s)
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : []
  } catch {
    return []
  }
}
