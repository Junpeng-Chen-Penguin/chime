import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// 正文隐去引用标记：移除 [1]-[9] 及其前置空白（含模型幻觉编号）；
// streaming 时额外抑制末尾未闭合的疑似标记（[ 或 [1），避免流式闪现
export function stripCitations(text: string, streaming = false): string {
  // 编号形态（018 Case 7）：四位随机前缀加序号，如 [a3f2-1]；改动前会话里的纯数字 [12] 也隐去
  let out = text.replace(/\s*\[(?:[0-9a-f]{4}-)?\d+\]/g, '')
  if (streaming) out = out.replace(/\s*\[[0-9a-f]{0,4}-?\d*$/, '') // 流式中途的半个角标（如「[a3f2-」「[」）先藏起
  return out
}
