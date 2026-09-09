// Agent 提示词分栏（018 Case 11）：五栏各存各的，拼进系统提示词的工作方式段时才合成一段文字。
// 主进程拼段、渲染端算 token 数，两侧共用这一份定义

export interface PromptSections {
  identity?: string // 身份与职责
  can?: string // 能做什么
  cannot?: string // 不做什么
  background?: string // 业务背景
  rules?: string // 回答规矩
}

export const PROMPT_SECTION_KEYS: (keyof PromptSections)[] = [
  'identity',
  'can',
  'cannot',
  'background',
  'rules'
]

// 栏标题：身份与职责直接跟在「# 工作方式」标题行后，不另加二级标题；其余四栏各带一个
const SECTION_TITLES: Record<Exclude<keyof PromptSections, 'identity'>, string> = {
  can: '能做什么',
  cannot: '不做什么',
  background: '业务背景',
  rules: '回答规矩'
}

export function parsePromptSections(raw: string | null | undefined): PromptSections {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const out: PromptSections = {}
    for (const k of PROMPT_SECTION_KEYS) {
      const s = v?.[k]
      if (typeof s === 'string' && s.trim()) out[k] = s
    }
    return out
  } catch {
    return {}
  }
}

export function promptSectionsEmpty(s: PromptSections): boolean {
  return PROMPT_SECTION_KEYS.every((k) => !s[k]?.trim())
}

// 工作方式段（Case 11 Feature 2）：按栏序拼，空栏连标题一起跳过；五栏全空返回 null，
// 调用方随之不拼这一段、身份段用产品自带那句
export function agentWorkStyle(name: string, s: PromptSections): string | null {
  if (promptSectionsEmpty(s)) return null
  const parts: string[] = [`# 工作方式：${name}`]
  if (s.identity?.trim()) parts.push(s.identity.trim())
  for (const k of ['can', 'cannot', 'background', 'rules'] as const) {
    const v = s[k]?.trim()
    if (v) parts.push(`## ${SECTION_TITLES[k]}\n${v}`)
  }
  return parts.join('\n\n')
}
