// 检索链路：向量(内存点积) + 关键词(FTS5) 双路召回 → RRF 融合 → 重排 → 阈值判定
import { embed, rerank, EMBED_MODEL_ID } from './model'
import { segmentText, toMatchQuery, kbBusy } from './kb'
import * as db from './db'

const RECALL_K = 30 // 每路召回数
const RERANK_K = 20 // 送重排数
const RRF_K = 60
const RERANK_THRESHOLD = 0.35 // 「未找到」判定线（经验值，真实语料跑几轮后微调）
const TOP_SOURCES = 6 // 送入提示词的片段上限
const COARSE_FLOOR = 0.25 // 粗筛：向量最高分低于此且关键词零命中 → 跳过重排直接未命中

export interface Source {
  n: number
  chunkId: number
  filePath: string
  headingPath: string
  startLine: number
  endLine: number
  content: string
  score: number
}

export type RetrieveResult =
  | { status: 'hit'; sources: Source[] }
  | { status: 'miss' }
  | { status: 'busy' } // 知识库更新中
  | { status: 'needs-rebuild' } // embedding 模型已更换，须重建

// 向量缓存：首查时全量载入；记住加载时的 indexedAt，刷新过就自动重载（自愈，无需通知）
let cache: { id: number; vec: Float32Array }[] | null = null
let cachedAt: number | null = null

function loadCache(indexedAt: number | null): { id: number; vec: Float32Array }[] {
  if (!cache || cachedAt !== indexedAt) {
    cache = db.loadAllEmbeddings().map((r) => ({
      id: r.id,
      vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
    }))
    cachedAt = indexedAt
  }
  return cache
}

export async function retrieve(query: string): Promise<RetrieveResult> {
  if (kbBusy()) return { status: 'busy' }
  // 模型校验在检索入口，而非仅在刷新时——升级后直接提问也拦得住
  const kb = db.getKb()
  if (kb.embedModel && kb.embedModel !== EMBED_MODEL_ID) return { status: 'needs-rebuild' }

  const vecs = loadCache(kb.indexedAt)
  if (vecs.length === 0) return { status: 'miss' }

  const [q] = await embed([query], true)
  const scored = vecs
    .map(({ id, vec }) => {
      let s = 0
      for (let i = 0; i < q.length; i++) s += q[i] * vec[i]
      return { id, s }
    })
    .sort((a, b) => b.s - a.s)
  const vecTop = scored.slice(0, RECALL_K)
  const ftsTop = db.ftsSearch(toMatchQuery(segmentText(query)), RECALL_K)

  // 粗筛：与库内容明显无关（闲聊）→ 不进重排
  if (vecTop[0].s < COARSE_FLOOR && ftsTop.length === 0) return { status: 'miss' }

  // RRF 融合（只用名次，免调参）
  const rrf = new Map<number, number>()
  vecTop.forEach(({ id }, rank) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  ftsTop.forEach((id, rank) => rrf.set(id, (rrf.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  const fusedIds = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, RERANK_K).map(([id]) => id)

  const chunks = db.getChunksByIds(fusedIds)
  const scores = await rerank(query, chunks.map((c) => `${c.filePath} › ${c.headingPath}\n${c.content}`))

  const passed = chunks
    .map((c, i) => ({ c, score: scores[i] }))
    .filter((x) => x.score >= RERANK_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_SOURCES)

  if (passed.length === 0) return { status: 'miss' }
  return {
    status: 'hit',
    sources: passed.map((x, i) => ({
      n: i + 1,
      chunkId: x.c.id,
      filePath: x.c.filePath,
      headingPath: x.c.headingPath,
      startLine: x.c.startLine,
      endLine: x.c.endLine,
      content: x.c.content,
      score: x.score
    }))
  }
}

// M4 自检：业务提问应命中、闲聊应未命中（不绑定具体文件，适配任意已建好的库）
export async function selftest(): Promise<boolean> {
  const cases: { q: string; expect: 'hit' | 'miss' }[] = [
    { q: '按天计费怎么算', expect: 'hit' },
    { q: '今天天气怎么样', expect: 'miss' },
    { q: '帮我把这句话改通顺', expect: 'miss' }
  ]
  let ok = true
  for (const c of cases) {
    const t0 = Date.now()
    const r = await retrieve(c.q)
    const detail = r.status === 'hit' ? `${r.sources[0].filePath} score=${r.sources[0].score.toFixed(3)} 共${r.sources.length}条` : ''
    const pass = r.status === c.expect
    ok = ok && pass
    console.log(`[retrieve-test] ${pass ? 'PASS' : 'FAIL'} "${c.q}" → ${r.status} ${detail} ${Date.now() - t0}ms`)
  }
  return ok
}
