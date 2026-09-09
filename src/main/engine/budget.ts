// 上下文预算（018 二节）：
// 触发线 = 上下文窗口 − 压缩预留；估算 = (工具清单 + 系统提示词 + 消息序列) × 按模型的校准比值。
// 校准比值 = 该模型累计的首次请求实测输入 ÷ 累计估算，按模型存 settings，重启后仍生效

import { asSchema, type Tool } from 'ai'
import { parseModelRef, windowFor as vendorWindow } from '../vendors'
import { registryContext } from '../registry'
import { estimateTokensBase } from '../../shared/tokens'
import { getSetting, setSetting } from '../db'

// 压缩预留：摘要输出预留 20000 + 缓冲 13000（Claude Code 同值，20000 来自它实测的摘要输出 p99.99）
export const COMPACT_RESERVE = 33_000

// 调试开关：CHIME_CONTEXT_WINDOW 把所有模型的窗口当成这个数。1M 窗口下触发线 96.7 万，
// 正常对话堆不到，压缩自测靠它把窗口调小。打包后的应用从终端启动才带环境变量
const DEBUG_WINDOW = ((): number | null => {
  const n = Number(process.env.CHIME_CONTEXT_WINDOW)
  return Number.isInteger(n) && n > 0 ? n : null
})()

// 窗口取值：厂商接口不提供窗口字段（两家均查证），先用 models.dev 登记表，
// 拉不到再退预置表、未知模型 128K 兜底。硬编码表停在旧值时预算会偏小——
// DeepSeek V4 升到 1M 后预置表仍写 128K，预算被卡在 9 万（2026-08-09 查出）
export function windowFor(ref: string): number {
  const { vendor, model } = parseModelRef(ref)
  return registryContext(vendor, model) ?? vendorWindow(vendor, model)
}

export function contextWindow(ref: string): number {
  return DEBUG_WINDOW ?? windowFor(ref)
}

export function triggerLine(ref: string): number {
  return contextWindow(ref) - COMPACT_RESERVE
}

// ── 校准 ──────────────────────────────────────────────────────────────
// 实测取每轮第一次请求的输入，与轮初那次估算配对（改动前拿整轮合计比轮初估算，
// 被请求次数放大后比值一直顶在上限，压缩远未接近上限就触发）。
// 按模型分开存：分词器偏差是模型属性，换模型不沿用。限幅 [0.8, 1.25]，一次异常数据带不偏一整个会话

const CALIB_KEY = 'calibration'
type Calib = { est: number; act: number }
let calib: Map<string, Calib> | null = null

function loadCalib(): Map<string, Calib> {
  if (calib) return calib
  calib = new Map()
  try {
    const raw = getSetting(CALIB_KEY)
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, Calib>)) {
        if (v && v.est > 0 && v.act > 0) calib.set(k, { est: v.est, act: v.act })
      }
    }
  } catch {
    // 坏数据当没有：比值退回 1，下一轮重新累计
  }
  return calib
}

export function recordUsage(model: string, estimated: number, firstStepInput: number): void {
  if (estimated <= 0 || firstStepInput <= 0) return
  const m = loadCalib()
  const c = m.get(model) ?? { est: 0, act: 0 }
  c.est += estimated
  c.act += firstStepInput
  m.set(model, c)
  setSetting(CALIB_KEY, JSON.stringify(Object.fromEntries(m)))
}

function ratio(model: string): number {
  const c = loadCalib().get(model)
  if (!c) return 1
  return Math.min(1.25, Math.max(0.8, c.act / c.est))
}

// 基础估算（shared，与渲染端共用）乘该模型的校准比值
export function applyRatio(model: string, baseTokens: number): number {
  return Math.ceil(baseTokens * ratio(model))
}

export function estimateTokens(model: string, text: string): number {
  return applyRatio(model, estimateTokensBase(text))
}

// ── 工具清单 ──────────────────────────────────────────────────────────
// 工具清单占单次请求的四成上下，改动前不进估算。按名字、说明、参数定义序列化后估基础值；
// 同一组工具名只算一次，模块 5 之后清单在所有会话一致，这里就是一个进程内常数

const toolsTokenCache = new Map<string, number>()

export function toolsTokens(tools: Record<string, Tool>): number {
  const names = Object.keys(tools).sort()
  const key = names.join('\0')
  const hit = toolsTokenCache.get(key)
  if (hit !== undefined) return hit
  const serialized = JSON.stringify(
    names.map((name) => ({
      name,
      description: tools[name].description ?? '',
      parameters: asSchema(tools[name].inputSchema).jsonSchema
    }))
  )
  const n = estimateTokensBase(serialized)
  toolsTokenCache.set(key, n)
  return n
}
