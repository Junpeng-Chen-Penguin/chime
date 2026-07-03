// 知识库：git 拉取与变更识别 + 索引构建 job(解析→切块→向量化→入库)+ 进度推送
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { chunkMarkdown } from '../shared/chunker'
import { embed, loadModels, EMBED_MODEL_ID, type ModelProgress } from './model'
import * as db from './db'

const exec = promisify(execFile)
const MAX_FILE_BYTES = 1024 * 1024 // 超 1MB 的 md 跳过
const EMBED_BATCH = 16

export type KbPhase = 'pulling' | 'scanning' | 'downloading-model' | 'embedding' | 'done' | 'error'
export interface KbSummary {
  updated: number
  deleted: number
  skipped: number
}
export interface KbProgress {
  phase: KbPhase
  current?: number
  total?: number
  file?: string
  message?: string
  warning?: string
  stats?: { files: number; chunks: number; summary: KbSummary }
}

let running = false
export const kbBusy = (): boolean => running

// 上次刷新的变动摘要（内存态，重启后不保留）
let lastSummary: KbSummary | null = null
export const getLastSummary = (): KbSummary | null => lastSummary

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

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

export async function validateRepoPath(root: string): Promise<string | null> {
  if (!root.trim() || !existsSync(root)) return '文件夹不存在'
  try {
    const out = await git(root, 'rev-parse', '--is-inside-work-tree')
    if (out.trim() !== 'true') return '不是 git 仓库'
  } catch {
    return '不是 git 仓库'
  }
  const files = await listRepoMd(root)
  if (files.length === 0) return '未找到 Markdown 文件'
  return null
}

async function listRepoMd(root: string): Promise<string[]> {
  const tracked = await git(root, 'ls-files', '-z', '--', '*.md')
  const untracked = await git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '*.md')
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')].filter(Boolean))]
}

interface ChangeSet {
  upserts: string[]
  deletes: string[]
}

// 变更识别:有基准走 diff(到工作区,含未提交修改),基准失效或缺失降级全量
async function detectChanges(root: string, lastCommit: string | null): Promise<ChangeSet> {
  if (lastCommit) {
    try {
      await git(root, 'cat-file', '-e', lastCommit)
      const out = await git(root, 'diff', '--name-status', '-z', lastCommit, '--', '*.md')
      const parts = out.split('\0').filter(Boolean)
      const upserts: string[] = []
      const deletes: string[] = []
      for (let i = 0; i < parts.length; ) {
        const status = parts[i][0]
        if (status === 'R' || status === 'C') {
          deletes.push(parts[i + 1])
          upserts.push(parts[i + 2])
          i += 3
        } else {
          if (status === 'D') deletes.push(parts[i + 1])
          else upserts.push(parts[i + 1])
          i += 2
        }
      }
      const untracked = await git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', '*.md')
      upserts.push(...untracked.split('\0').filter(Boolean))
      return { upserts: [...new Set(upserts)], deletes: [...new Set(deletes)] }
    } catch {
      // 基准 commit 不存在(rebase / reset / 重 clone)→ 降级全量
    }
  }
  const current = await listRepoMd(root)
  const known = db.listKbFiles().map((f) => f.path)
  return { upserts: current, deletes: known.filter((p) => !current.includes(p)) }
}

// 构建 / 刷新 job。rebuild = 换路径或点「构建」:先清库再全量
export async function runIndexJob(wc: WebContents, root: string, rebuild: boolean, name?: string): Promise<void> {
  if (running) return
  running = true
  const send = (p: KbProgress): void => {
    if (process.env.CHIME_KB_TEST) console.log('[kb]', JSON.stringify(p))
    if (!wc.isDestroyed()) wc.send('kb:progress', p)
  }
  try {
    const invalid = await validateRepoPath(root)
    if (invalid) {
      send({ phase: 'error', message: invalid })
      return
    }
    if (rebuild) {
      db.clearKbData()
      db.setKbMeta({ rootPath: root, name })
    }

    let warning: string | undefined
    send({ phase: 'pulling' })
    try {
      await git(root, 'pull', '--ff-only')
    } catch (e) {
      // 拉取失败不中断:本地内容照常增量(无远程 / 无网络 / 冲突均落此)
      warning = `未能获取远程更新,已基于本地内容更新:${(e as Error).message.split('\n')[0].slice(0, 120)}`
    }

    send({ phase: 'scanning' })
    const changes = await detectChanges(root, rebuild ? null : db.getKb().lastCommit)

    send({ phase: 'downloading-model' })
    await loadModels((p: ModelProgress) => {
      if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
        send({ phase: 'downloading-model', file: p.file, current: Math.round(p.progress ?? 0), total: 100 })
      }
    })

    const skipped: string[] = []
    let updated = 0
    const deleted = changes.deletes.filter((p) => db.listKbFiles().some((f) => f.path === p)).length
    for (const path of changes.deletes) db.deleteKbFile(path)

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
      if (db.listKbFiles().find((f) => f.path === path)?.hash === hash) continue
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
      db.replaceKbFile(path, hash, inputs)
      await new Promise((r) => setImmediate(r)) // 让出事件循环
    }

    const head = (await git(root, 'rev-parse', 'HEAD')).trim()
    db.setKbMeta({ rootPath: root, lastCommit: head, embedModel: EMBED_MODEL_ID, indexedAt: Date.now() })
    const summary: KbSummary = { updated, deleted, skipped: skipped.length }
    lastSummary = rebuild ? null : summary // 「上次刷新」摘要只对刷新有意义
    send({ phase: 'done', warning, stats: { ...db.kbStats(), summary } })
  } catch (e) {
    send({ phase: 'error', message: (e as Error).message.split('\n')[0].slice(0, 200) })
  } finally {
    running = false
  }
}
