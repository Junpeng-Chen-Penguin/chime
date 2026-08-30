// 知识库：本地文件夹变更识别 + 索引构建 job(解析→切块→向量化→入库)+ 进度推送。
// 文档更新由使用者在本地完成（Obsidian 编辑、内网拉取等），Chime 不参与获取（v1.0.0 去 git 化）
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { chunkMarkdown } from '../shared/chunker'
import { embed, loadModels, EMBED_MODEL_ID, type ModelProgress } from './model'

// 库可用性判定（016 十节，三处界面加引擎共用这一份）：构建过，且嵌入模型为空或与当前一致。
// 空 embedModel 的老库放行——老库没记模型，严格相等会把它们全翻成不可用
export function kbReady(k: { indexedAt: number | null; embedModel: string }): boolean {
  return !!k.indexedAt && (!k.embedModel || k.embedModel === EMBED_MODEL_ID)
}
// 需重建：构建过但嵌入模型对不上（应用升级换了本地模型）
export function kbStale(k: { indexedAt: number | null; embedModel: string }): boolean {
  return !!k.indexedAt && !!k.embedModel && k.embedModel !== EMBED_MODEL_ID
}
import * as db from './db'

const MAX_FILE_BYTES = 1024 * 1024 // 超 1MB 的 md 跳过
const EMBED_BATCH = 16

// 切块器版本：切块规则升级时 +1，构建时写进库；版本不等 → 该库需全量重建（PRD Case 2 Feature 3）
export const CHUNKER_VERSION = 1

export type KbPhase = 'pulling' | 'scanning' | 'downloading-model' | 'embedding' | 'done' | 'error'
export interface KbSummary {
  updated: number
  deleted: number
  skipped: number
}
export interface KbProgress {
  kbId?: number // 哪个库在构建（多库后进度按库归属）
  phase: KbPhase
  current?: number
  total?: number
  file?: string
  message?: string
  warning?: string
  stats?: { files: number; chunks: number; summary: KbSummary }
}

let running = false
let runningKbId: number | null = null
export const kbBusy = (): boolean => running
export const busyKbId = (): number | null => runningKbId

// 上次刷新的变动摘要（内存态，重启后不保留）
let lastSummary: KbSummary | null = null
export const getLastSummary = (): KbSummary | null => lastSummary


// 中文分词供 FTS 入库/查询共用；token 加引号转义,不让内容进入 FTS 查询语法
const seg = new Intl.Segmenter('zh', { granularity: 'word' })
export function segmentText(text: string): string {
  return [...seg.segment(text)]
    .filter((s) => s.isWordLike)
    .map((s) => s.segment)
    .join(' ')
}
export function toMatchQuery(text: string): string {
  return [...seg.segment(text)]
    .filter((s) => s.isWordLike)
    .map((s) => `"${s.segment.replaceAll('"', '""')}"`)
    .join(' OR ')
}

// 路径校验放宽：文件夹存在即可（空文件夹允许建库，构建后 0 篇）
export async function validateRepoPath(root: string): Promise<string | null> {
  if (!root.trim() || !existsSync(root)) return '文件夹不存在'
  if (!statSync(root).isDirectory()) return '不是文件夹'
  return null
}

// fs 递归枚举 md：跳过点开头的目录与文件（.git/.obsidian 等），返回相对路径
function listMdFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const p = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(p)
    }
  }
  walk('')
  return out
}

interface ChangeSet {
  upserts: string[]
  deletes: string[]
}

// 变更识别：枚举文件夹与已索引清单比对。upserts 含未变更文件，构建循环里按内容哈希跳过
function detectChanges(kbId: number, root: string): ChangeSet {
  const current = listMdFiles(root)
  const known = db.listKbFilesFor(kbId).map((f) => f.path)
  return { upserts: current, deletes: known.filter((p) => !current.includes(p)) }
}

export interface KbChanges {
  added: number
  changed: number
  deleted: number
  needsFullRebuild: boolean // 切块规则升级
  folderMissing: boolean
}

// 变更检查（PRD Case 2 Feature 1）：只读文件算哈希，秒级，不动索引
export function checkChanges(kbId: number): KbChanges {
  const kb = db.getKbById(kbId)
  const none = { added: 0, changed: 0, deleted: 0, needsFullRebuild: false, folderMissing: false }
  if (!kb || !kb.rootPath) return none
  if (!existsSync(kb.rootPath)) return { ...none, folderMissing: true }
  if (kb.indexedAt && kb.chunkerVersion !== CHUNKER_VERSION) {
    const files = listMdFiles(kb.rootPath).length
    return { added: 0, changed: files, deleted: 0, needsFullRebuild: true, folderMissing: false }
  }
  const known = new Map(db.listKbFilesFor(kbId).map((f) => [f.path, f.hash]))
  let added = 0
  let changed = 0
  const seen = new Set<string>()
  for (const path of listMdFiles(kb.rootPath)) {
    seen.add(path)
    const abs = join(kb.rootPath, path)
    if (statSync(abs).size > MAX_FILE_BYTES) continue
    const hash = createHash('sha1').update(readFileSync(abs, 'utf8')).digest('hex')
    const old = known.get(path)
    if (old === undefined) added++
    else if (old !== hash) changed++
  }
  const deleted = [...known.keys()].filter((p) => !seen.has(p)).length
  return { added, changed, deleted, needsFullRebuild: false, folderMissing: false }
}

// 构建 job（按库）。rebuild = 换路径 / 切块升级 / 首次：先清该库再全量；构建全局互斥（嵌入模型单份）
// wc 传 null = 无界面运行（测试 / 评估通道），进度不推送
export async function runIndexJob(wc: WebContents | null, kbId: number, rebuild: boolean): Promise<void> {
  if (running) return
  running = true
  runningKbId = kbId
  const send = (p: KbProgress): void => {
    if (process.env.CHIME_KB_TEST) console.log('[kb]', JSON.stringify(p))
    if (wc && !wc.isDestroyed()) wc.send('kb:progress', { kbId, ...p })
  }
  try {
    const kb = db.getKbById(kbId)
    if (!kb) {
      send({ phase: 'error', message: '知识库不存在' })
      return
    }
    const root = kb.rootPath
    const invalid = await validateRepoPath(root)
    if (invalid) {
      send({ phase: 'error', message: invalid })
      return
    }
    // 切块规则升级：该库的旧片段按旧规则切的，整库重来（PRD Case 2 Feature 3）
    if (!rebuild && kb.indexedAt && kb.chunkerVersion !== CHUNKER_VERSION) rebuild = true
    if (rebuild) db.clearKbDataFor(kbId)

    const warning: string | undefined = undefined
    send({ phase: 'scanning' })
    const changes = detectChanges(kbId, root)

    send({ phase: 'downloading-model' })
    await loadModels((p: ModelProgress) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
        send({ phase: 'downloading-model', file: p.file, current: Math.round(p.progress ?? 0), total: 100 })
      }
    })

    const skipped: string[] = []
    let updated = 0
    const deleted = changes.deletes.length
    for (const path of changes.deletes) db.deleteKbFileFor(kbId, path)

    const total = changes.upserts.length
    let current = 0
    for (const path of changes.upserts) {
      current++
      send({ phase: 'embedding', current, total, file: path })
      const abs = join(root, path)
      if (!existsSync(abs)) continue
      if (statSync(abs).size > MAX_FILE_BYTES) {
        skipped.push(path)
        continue
      }
      const text = readFileSync(abs, 'utf8')
      const hash = createHash('sha1').update(text).digest('hex')
      if (db.listKbFilesFor(kbId).find((f) => f.path === path)?.hash === hash) continue
      updated++

      const chunks = chunkMarkdown(text)
      const inputs: db.ChunkInput[] = []
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH)
        const vecs = await embed(batch.map((c) => `${path} › ${c.headingPath}\n${c.content}`))
        batch.forEach((c, j) =>
          inputs.push({
            headingPath: c.headingPath,
            startLine: c.startLine,
            endLine: c.endLine,
            content: c.content,
            embedding: Buffer.from(vecs[j].buffer, vecs[j].byteOffset, vecs[j].byteLength),
            segText: segmentText(`${path} ${c.headingPath} ${c.content}`)
          })
        )
      }
      db.replaceKbFileFor(kbId, path, hash, inputs)
      await new Promise((r) => setImmediate(r)) // 让出事件循环
    }

    db.updateKb(kbId, { embedModel: EMBED_MODEL_ID, chunkerVersion: CHUNKER_VERSION, indexedAt: Date.now() })
    const summary: KbSummary = { updated, deleted, skipped: skipped.length }
    lastSummary = rebuild ? null : summary // 「上次刷新」摘要只对刷新有意义
    send({ phase: 'done', warning, stats: { ...db.kbStatsFor(kbId), summary } })
  } catch (e) {
    send({ phase: 'error', message: (e as Error).message.split('\n')[0].slice(0, 200) })
  } finally {
    running = false
    runningKbId = null
  }
}
