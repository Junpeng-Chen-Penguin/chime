import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// 正文隐去引用标记：移除 [1]-[9] 及其前置空白（含模型幻觉编号）；
// streaming 时额外抑制末尾未闭合的疑似标记（[ 或 [1），避免流式闪现
export function stripCitations(text: string, streaming = false): string {
  let out = text.replace(/\s*\[[1-9]\]/g, '')
  if (streaming) out = out.replace(/\s*\[[1-9]?$/, '')
  return out
}
