// 模型登记表（models.dev）：厂商的 /models 只返回 id，不给上下文窗口——OpenAI 兼容协议
// 本来就没定义这些字段（2026-08-09 实测 DeepSeek 只回 id 与 owned_by）。窗口只能靠外部登记表。
//
// 分工：哪些模型存在以厂商 /models 为准，窗口多大以登记表为准，两个来源不互相覆盖。
// 登记表自己也会滞后（它到 2026-08-09 仍列着 7 月已下线的 deepseek-chat），所以它只回答
// 「这个 id 的窗口是多少」，不参与「有没有这个模型」。
//
// 拉不到就用缓存，没缓存就退回 vendors.ts 的预置表——离线可用是硬要求。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { VENDORS } from './vendors'

const URL = 'https://models.dev/api.json'
const TIMEOUT_MS = 10_000

type Cache = { fetchedAt: number; contexts: Record<string, number> } // 键为 vendor:model

let mem: Cache | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'models-dev.json')
}

function load(): Cache {
  if (mem) return mem
  try {
    mem = JSON.parse(readFileSync(cachePath(), 'utf8')) as Cache
  } catch {
    mem = { fetchedAt: 0, contexts: {} }
  }
  return mem
}

// 登记表里的窗口；没有该模型就返回 null，由调用方退回预置表
export function registryContext(vendor: string, model: string): number | null {
  const v = load().contexts[`${vendor}:${model.toLowerCase()}`]
  return typeof v === 'number' && v > 0 ? v : null
}

export function registryFetchedAt(): number {
  return load().fetchedAt
}

// 展示与排序用的窗口表：登记表覆盖预置表，登记表没有的仍用预置值
export function windowsForVendor(vendor: string): Record<string, number> {
  const out = { ...(VENDORS.find((v) => v.vendor === vendor)?.windows ?? {}) }
  const prefix = `${vendor}:`
  for (const [k, v] of Object.entries(load().contexts)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v
  }
  return out
}

// 拉一次登记表并落盘。只留我们支持的厂商，3.6MB 的原始表不整个存
export async function refreshRegistry(): Promise<{ ok: boolean; count: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(URL, { signal: controller.signal })
    if (!res.ok) return { ok: false, count: 0 }
    const json = (await res.json()) as Record<
      string,
      { models?: Record<string, { limit?: { context?: number } }> }
    >
    const contexts: Record<string, number> = {}
    for (const v of VENDORS) {
      const models = json[v.registryId ?? v.vendor]?.models ?? {}
      for (const [id, m] of Object.entries(models)) {
        const ctx = m.limit?.context
        if (typeof ctx === 'number' && ctx > 0) contexts[`${v.vendor}:${id.toLowerCase()}`] = ctx
      }
    }
    // 一条都没解析出来时不覆盖旧缓存——多半是对方改了结构，旧数据比空表有用
    if (!Object.keys(contexts).length) return { ok: false, count: 0 }
    mem = { fetchedAt: Date.now(), contexts }
    mkdirSync(dirname(cachePath()), { recursive: true })
    writeFileSync(cachePath(), JSON.stringify(mem))
    return { ok: true, count: Object.keys(contexts).length }
  } catch {
    return { ok: false, count: 0 }
  } finally {
    clearTimeout(timer)
  }
}

// 首次启动还没有缓存时后台补一次，免得第一轮对话按预置表算预算
export function warmRegistry(): void {
  if (!existsSync(cachePath())) void refreshRegistry()
}
