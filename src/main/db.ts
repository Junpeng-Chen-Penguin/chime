import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'

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
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      api_key       TEXT NOT NULL DEFAULT '',
      base_url      TEXT NOT NULL DEFAULT 'https://api.deepseek.com',
      default_model TEXT NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO provider (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS conversation (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '新对话',
      model      TEXT NOT NULL DEFAULT '',
      kb_enabled INTEGER NOT NULL DEFAULT 0,
      title_auto INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      items           TEXT,
      status          TEXT NOT NULL DEFAULT 'done',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_conv ON message (conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS kb (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      root_path   TEXT NOT NULL DEFAULT '',
      last_commit TEXT,
      embed_model TEXT NOT NULL DEFAULT '',
      indexed_at  INTEGER
    );
    INSERT OR IGNORE INTO kb (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS kb_file (
      path         TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunk (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
  // 迁移：知识库名称（录入时可自定义）
  try {
    db.exec("ALTER TABLE kb ADD COLUMN name TEXT NOT NULL DEFAULT '业务知识库'")
  } catch {
    // 列已存在
  }
  // 迁移：默认上下文窗口（OpenAI 兼容接口无法自动检测窗口大小，设置页可改）
  try {
    db.exec('ALTER TABLE provider ADD COLUMN default_window INTEGER NOT NULL DEFAULT 65536')
  } catch {
    // 列已存在
  }
  // 迁移：知识库简介（人工必填，注入环境信息供模型判断该不该查）
  try {
    db.exec("ALTER TABLE kb ADD COLUMN intro TEXT NOT NULL DEFAULT ''")
  } catch {
    // 列已存在
  }
}

// engine/store 是消息的唯一写者，经此拿库连接
export function getDb(): Database.Database {
  return db
}

export function getProvider(): ProviderRow {
  return db
    .prepare(
      'SELECT api_key AS apiKey, base_url AS baseUrl, default_model AS defaultModel, default_window AS defaultWindow FROM provider WHERE id = 1'
    )
    .get() as ProviderRow
}

export function saveProvider(input: {
  apiKey: string | null
  baseUrl: string
  defaultModel: string
  defaultWindow?: number
}): void {
  // apiKey 为 null 表示沿用已存的密钥（界面未改动）
  const cur = getProvider()
  const apiKey = input.apiKey === null ? cur.apiKey : input.apiKey
  db.prepare(
    'UPDATE provider SET api_key = ?, base_url = ?, default_model = ?, default_window = ? WHERE id = 1'
  ).run(apiKey, input.baseUrl, input.defaultModel, input.defaultWindow ?? cur.defaultWindow)
}

// 仅用于界面展示，明文密钥不离开主进程
export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length > 16) return `${key.slice(0, 6)}••••${key.slice(-4)}`
  if (key.length > 8) return `${key.slice(0, 3)}••••${key.slice(-2)}`
  return '••••'
}

export interface ConversationRow {
  id: string
  title: string
  model: string
  updatedAt: number
  kbEnabled?: number
}

export interface MessageRow {
  id: string
  conversationId: string
  role: string
  content: string
  items: string | null // 一轮的有序过程记录（JSON），仅 assistant 行有
  status: string
  createdAt: number
}

export function listConversations(): ConversationRow[] {
  return db
    .prepare(
      'SELECT id, title, model, updated_at AS updatedAt, kb_enabled AS kbEnabled FROM conversation ORDER BY updated_at DESC'
    )
    .all() as ConversationRow[]
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

// 跨结果搜索用：本会话全部已存结果（按编号升序）
export function listToolResults(conversationId: string): { id: number; content: string }[] {
  return db
    .prepare('SELECT id, content FROM tool_result WHERE conversation_id = ? ORDER BY id')
    .all(conversationId) as { id: number; content: string }[]
}

export function getMessages(conversationId: string): MessageRow[] {
  return db
    .prepare(
      'SELECT id, conversation_id AS conversationId, role, content, items, status, created_at AS createdAt FROM message WHERE conversation_id = ? ORDER BY created_at'
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
  lastCommit: string | null
  embedModel: string
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

export function getKb(): KbRow {
  return db
    .prepare(
      'SELECT root_path AS rootPath, name, intro, last_commit AS lastCommit, embed_model AS embedModel, indexed_at AS indexedAt FROM kb WHERE id = 1'
    )
    .get() as KbRow
}

export function setKbMeta(
  meta: Partial<{ rootPath: string; name: string; intro: string; lastCommit: string | null; embedModel: string; indexedAt: number }>
): void {
  const cur = getKb()
  db.prepare('UPDATE kb SET root_path = ?, name = ?, intro = ?, last_commit = ?, embed_model = ?, indexed_at = ? WHERE id = 1').run(
    meta.rootPath ?? cur.rootPath,
    meta.name ?? cur.name,
    meta.intro ?? cur.intro,
    meta.lastCommit === undefined ? cur.lastCommit : meta.lastCommit,
    meta.embedModel ?? cur.embedModel,
    meta.indexedAt ?? cur.indexedAt
  )
}

export function kbStats(): { files: number; chunks: number } {
  const files = (db.prepare('SELECT COUNT(*) AS n FROM kb_file').get() as { n: number }).n
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunk').get() as { n: number }).n
  return { files, chunks }
}

export function listKbFiles(): { path: string; hash: string }[] {
  return db.prepare('SELECT path, content_hash AS hash FROM kb_file').all() as { path: string; hash: string }[]
}

// 移除知识库：清空索引数据并复位配置（回到空态）
export function resetKb(): void {
  clearKbData()
  db.prepare("UPDATE kb SET root_path = '', name = '业务知识库', embed_model = '' WHERE id = 1").run()
}

// 换路径 / 重新构建：整库清空
export const clearKbData = (): void => {
  db.transaction(() => {
    db.prepare('DELETE FROM chunk_fts').run()
    db.prepare('DELETE FROM chunk').run()
    db.prepare('DELETE FROM kb_file').run()
    db.prepare('UPDATE kb SET last_commit = NULL, indexed_at = NULL WHERE id = 1').run()
  })()
}

// 删除一个文件的全部数据（chunk 与 FTS 同事务，防幽灵命中）
export function deleteKbFile(path: string): void {
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chunk WHERE file_path = ?').all(path) as { id: number }[]
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    db.prepare('DELETE FROM chunk WHERE file_path = ?').run(path)
    db.prepare('DELETE FROM kb_file WHERE path = ?').run(path)
  })()
}

// 写入一个文件的全部片段（先清旧数据 = 修改文件的替换语义）
export function replaceKbFile(path: string, hash: string, chunks: ChunkInput[]): void {
  db.transaction(() => {
    const ids = db.prepare('SELECT id FROM chunk WHERE file_path = ?').all(path) as { id: number }[]
    const delFts = db.prepare('DELETE FROM chunk_fts WHERE rowid = ?')
    for (const { id } of ids) delFts.run(id)
    db.prepare('DELETE FROM chunk WHERE file_path = ?').run(path)

    const insChunk = db.prepare(
      'INSERT INTO chunk (file_path, heading_path, start_line, end_line, content, embedding) VALUES (?, ?, ?, ?, ?, ?)'
    )
    // FTS rowid 显式对齐 chunk.id（自动分配在删除后必然错位）
    const insFts = db.prepare('INSERT INTO chunk_fts (rowid, seg_text) VALUES (?, ?)')
    for (const c of chunks) {
      const rowid = insChunk.run(path, c.headingPath, c.startLine, c.endLine, c.content, c.embedding)
        .lastInsertRowid as number
      insFts.run(rowid, c.segText)
    }
    db.prepare('INSERT INTO kb_file (path, content_hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET content_hash = ?').run(
      path,
      hash,
      hash
    )
  })()
}

export function loadAllEmbeddings(): { id: number; embedding: Buffer }[] {
  return db.prepare('SELECT id, embedding FROM chunk').all() as { id: number; embedding: Buffer }[]
}

export interface ChunkRow {
  id: number
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
      `SELECT id, file_path AS filePath, heading_path AS headingPath, start_line AS startLine, end_line AS endLine, content
       FROM chunk WHERE id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as ChunkRow[]
  const order = new Map(ids.map((id, i) => [id, i]))
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

// BM25 检索：返回 chunk id（bm25 分数越小越相关，这里只用名次）
export function ftsSearch(matchQuery: string, limit: number): number[] {
  if (!matchQuery.trim()) return []
  const rows = db
    .prepare('SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?')
    .all(matchQuery, limit) as { rowid: number }[]
  return rows.map((r) => r.rowid)
}

// ── MCP 服务 ──────────────────────────────────────

export interface McpServiceRow {
  id: number
  name: string
  url: string
  headers: Record<string, string> // 认证请求头键值对，明文只在主进程
  enabled: boolean
}

export function listMcpServices(): McpServiceRow[] {
  const rows = db
    .prepare('SELECT id, name, url, headers, enabled FROM mcp_service ORDER BY created_at')
    .all() as { id: number; name: string; url: string; headers: string; enabled: number }[]
  return rows.map((r) => ({ ...r, headers: JSON.parse(r.headers), enabled: !!r.enabled }))
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
    db.prepare('UPDATE mcp_service SET name = ?, url = ?, headers = ?, enabled = ? WHERE id = ?').run(
      input.name,
      input.url,
      JSON.stringify(headers),
      input.enabled ? 1 : 0,
      input.id
    )
    return input.id
  }
  const r = db
    .prepare('INSERT INTO mcp_service (name, url, headers, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.url, JSON.stringify(input.headers ?? {}), input.enabled ? 1 : 0, Date.now())
  return Number(r.lastInsertRowid)
}

// 删除服务：历史会话的调用行、授权记录等全部保留（存在 message.items 里，与服务表无外键）
export function deleteMcpService(id: number): void {
  db.prepare('DELETE FROM mcp_service WHERE id = ?').run(id)
}

export function setConversationKb(id: string, enabled: boolean): void {
  db.prepare('UPDATE conversation SET kb_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function getConversationKb(id: string): boolean {
  const row = db.prepare('SELECT kb_enabled AS k FROM conversation WHERE id = ?').get(id) as { k: number } | undefined
  return !!row?.k
}
