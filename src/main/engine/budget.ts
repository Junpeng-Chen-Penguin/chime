// 上下文预算：预算 = 窗口 × 0.75 − 8192；估算按字符折算，用 API 实测用量做全局校准

import { parseModelRef, windowFor as vendorWindow } from '../vendors'
import { registryContext } from '../registry'

const SAFETY = 0.75
const OUTPUT_RESERVE = 8192

// 单条消息发送上限（字符）：渲染层发送前拦截用同一常量，联调期校准
export const SEND_CHAR_LIMIT = 30000

// 窗口取值：厂商接口不提供窗口字段（两家均查证），先用 models.dev 登记表，
// 拉不到再退预置表、未知模型 128K 兜底。硬编码表停在旧值时预算会偏小——
// DeepSeek V4 升到 1M 后预置表仍写 128K，预算被卡在 9 万（2026-08-09 查出）
export function windowFor(ref: string): number {
  const { vendor, model } = parseModelRef(ref)
  return registryContext(vendor, model) ?? vendorWindow(vendor, model)
}

export function budgetFor(model: string): number {
  return Math.floor(windowFor(model) * SAFETY) - OUTPUT_RESERVE
}

// 校准：累计实测 ÷ 累计估算，限幅 [0.5, 2]，全局一个比值存内存（tokenizer 偏差是模型属性）
let accEstimated = 0
let accActual = 0

export function recordUsage(estimated: number, actual: number): void {
  if (estimated > 0 && actual > 0) {
    accEstimated += estimated
    accActual += actual
  }
}

function ratio(): number {
  if (!accEstimated || !accActual) return 1
  return Math.min(2, Math.max(0.5, accActual / accEstimated))
}

// 估算：汉字 × 0.6 + 其他字符 ÷ 4，乘校准比值
export function estimateTokens(text: string): number {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  return Math.ceil((han * 0.6 + (text.length - han) / 4) * ratio())
}
