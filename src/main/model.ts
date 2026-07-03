import { app } from 'electron'
import { join } from 'path'
import {
  env,
  pipeline,
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer,
  type PreTrainedModel
} from '@huggingface/transformers'

const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5'
const RERANK_MODEL = 'Xenova/bge-reranker-base'
// 建库时记录,换模型强制全量重建的比对依据
export const EMBED_MODEL_ID = EMBED_MODEL
// bge 中文系列官方用法：检索 query 加此前缀，文档侧不加
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'
// query + passage 合并后的截断长度（重排模型输入）
const RERANK_MAX_LENGTH = 320

env.cacheDir = join(app.getPath('userData'), 'models')

let embedder: FeatureExtractionPipeline | null = null
let reranker: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null = null
let mirrored = false

export type ModelProgress = { file?: string; progress?: number; status?: string }

// 默认走 huggingface.co，失败切 hf-mirror 重试一次（国内网络兜底）
async function withMirrorRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (mirrored) throw e
    mirrored = true
    env.remoteHost = 'https://hf-mirror.com'
    return await fn()
  }
}

export async function loadModels(onProgress?: (p: ModelProgress) => void): Promise<void> {
  if (!embedder) {
    embedder = await withMirrorRetry(() =>
      pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8', progress_callback: onProgress })
    )
  }
  if (!reranker) {
    reranker = await withMirrorRetry(async () => ({
      tokenizer: await AutoTokenizer.from_pretrained(RERANK_MODEL, { progress_callback: onProgress }),
      model: await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
        dtype: 'q8',
        progress_callback: onProgress
      })
    }))
  }
}

export async function embed(texts: string[], isQuery = false): Promise<Float32Array[]> {
  await loadModels()
  const input = isQuery ? texts.map((t) => QUERY_PREFIX + t) : texts
  const out = await embedder!(input, { pooling: 'cls', normalize: true })
  const [n, dim] = out.dims
  const data = out.data as Float32Array
  return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim))
}

// 返回每个 passage 与 query 的相关分（sigmoid 后 0~1）
export async function rerank(query: string, passages: string[]): Promise<number[]> {
  await loadModels()
  const { tokenizer, model } = reranker!
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
    max_length: RERANK_MAX_LENGTH
  })
  const { logits } = await model(inputs)
  return Array.from(logits.data as Float32Array, (x) => 1 / (1 + Math.exp(-x)))
}

// M0 自检：向量维度、相关排序、重排分排序。CHIME_MODEL_TEST=1 时在启动后运行
export async function selftest(): Promise<boolean> {
  const t0 = Date.now()
  const query = '续签的计费规则是什么'
  const docs = ['计费规则 › 续签：续签时按新计费规则执行，历史订单不受影响。', '周会纪要：下周三下午三点评审原型。']
  const [q] = await embed([query], true)
  const loadedMs = Date.now() - t0
  const vecs = await embed(docs)
  const dots = vecs.map((v) => v.reduce((s, x, i) => s + x * q[i], 0))
  const t1 = Date.now()
  const scores = await rerank(query, docs)
  const ok = q.length === 512 && dots[0] > dots[1] && scores[0] > scores[1]
  console.log('[model-selftest]', JSON.stringify({ dim: q.length, dots, scores, loadedMs, rerankMs: Date.now() - t1 }))
  console.log(ok ? '[model-selftest] PASS' : '[model-selftest] FAIL')
  return ok
}
