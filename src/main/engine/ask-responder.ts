// 询问应答器（v1.1.1 Case 3）：评估通道按用例的应答档案代替用户回答提问卡。
// 两级：规则匹配（档案含选项原文，零成本、结果确定）→ 兜底模型（只许输出选项编号）→ 未回答。
// 只从封闭选项里选，不生成自由文本（提问卡的"其他"自由输入行不使用）。

import type { AskQuestion } from './cards'

export interface AskAnswerDetail {
  question: string
  answer: string | null // 多选用「、」连接（与界面提交格式一致）；null = 未回答
  source: 'rule' | 'model' | 'unanswered'
  reason?: string // 未回答时的原因
}

// 规则匹配：档案文本包含选项原文即命中。单选恰好一个命中才算数（多命中是歧义，交兜底模型）；
// 多选全部命中项都选
export function matchByRule(profile: string, q: AskQuestion): string[] | null {
  const hits = q.options.filter((o) => o.label && profile.includes(o.label)).map((o) => o.label)
  if (q.multiSelect) return hits.length ? hits : null
  return hits.length === 1 ? hits : null
}

// 兜底模型输出解析：只接受编号（多选可逗号/顿号分隔）；0、越界、单选多编号、含其他文字均视为非法
export function parseModelChoice(text: string, q: AskQuestion): string[] | null {
  const t = text.trim()
  if (!/^[\d,，、\s]+$/.test(t)) return null
  const idx = [...new Set(t.split(/[,，、\s]+/).filter(Boolean).map(Number))]
  if (!idx.length || idx.some((n) => !Number.isInteger(n) || n < 1 || n > q.options.length)) return null
  if (!q.multiSelect && idx.length > 1) return null
  return idx.map((n) => q.options[n - 1].label)
}

const RESPONDER_SYSTEM =
  '你是自动化测试的应答器，代替用户回答封闭选项问题。根据「意图档案」选出最符合用户意图的选项。' +
  '只输出选项编号（如：2）；标注可多选的题可输出多个编号用逗号分隔；档案完全判断不出时输出 0。不要输出任何其他文字。'

// 逐题应答：规则先行，对不上才走兜底模型；模型输出非法或调用失败按"未回答"记录原因，不阻塞执行。
// callModel 注入（评估通道传 Chime 默认模型的非流式调用），本模块保持纯逻辑可自检
export async function answerWithProfile(
  profile: string,
  questions: AskQuestion[],
  callModel: (system: string, user: string) => Promise<string>
): Promise<AskAnswerDetail[]> {
  const out: AskAnswerDetail[] = []
  for (const q of questions) {
    const ruleHit = matchByRule(profile, q)
    if (ruleHit) {
      out.push({ question: q.question, answer: ruleHit.join('、'), source: 'rule' })
      continue
    }
    try {
      const numbered = q.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
      const user = `意图档案：\n${profile}\n\n问题：${q.question}${q.multiSelect ? '（可多选）' : ''}\n选项：\n${numbered}`
      const text = await callModel(RESPONDER_SYSTEM, user)
      const picked = parseModelChoice(text, q)
      if (picked) out.push({ question: q.question, answer: picked.join('、'), source: 'model' })
      else
        out.push({
          question: q.question,
          answer: null,
          source: 'unanswered',
          reason: `兜底模型输出不是合法选项编号：${text.trim().slice(0, 50) || '（空）'}`
        })
    } catch (e) {
      out.push({
        question: q.question,
        answer: null,
        source: 'unanswered',
        reason: `兜底调用失败：${String(e).slice(0, 100)}`
      })
    }
  }
  return out
}
