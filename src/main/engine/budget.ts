// 上下文预算：预算 = 窗口 × 0.75 − 8192；估算按字符折算，用 API 实测用量做全局校准

import { getProvider } from '../db'

const SAFETY = 0.75
const OUTPUT_RESERVE = 8192

// 单条消息发送上限（字符）：渲染层发送前拦截用同一常量，联调期校准
export const SEND_CHAR_LIMIT = 30000

// 窗口大小无法从 OpenAI 兼容接口自动检测：几行识别规则 + 服务配置的默认值兜底
export function windowFor(model: string): number {
  if (model.toLowerCase().includes('deepseek')) return 131072 // DeepSeek 官方 128K
  return getProvider().defaultWindow
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
