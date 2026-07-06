import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// 正文隐去引用标记：移除 [1]-[9] 及其前置空白（含模型幻觉编号）；
// streaming 时额外抑制末尾未闭合的疑似标记（[ 或 [1），避免流式闪现
export function stripCitations(text: string, streaming = false): string {
  // 多位数编号：真实库一轮可命中 10+ 条，编号进两位数，需匹配 \d+ 而非单个 [1-9]
  let out = text.replace(/\s*\[\d+\]/g, '')
  if (streaming) out = out.replace(/\s*\[\d*$/, '') // 流式中途的半个角标（如「[1」「[」）先藏起
  return out
}
