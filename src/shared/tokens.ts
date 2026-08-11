// token 基础估算：汉字 × 0.6 + 其他字符 ÷ 4。
// 主进程 budget.ts 在此之上乘 API 实测校准比值；渲染端（Agent 提示词的 token 数提示）直接用基础值——
// 显示用途，恒定系数够用，公式只此一份，两侧不漂移
export function estimateTokensBase(text: string): number {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length
  return Math.ceil(han * 0.6 + (text.length - han) / 4)
}
