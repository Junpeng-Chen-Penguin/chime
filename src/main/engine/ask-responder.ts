// 询问应答器（v1.1.1 Case 3）：评估通道按用例的应答档案代替用户回答提问卡。
// 一级模型判断：选项能选就出编号，选项不合适或压根没选项就出答案原文（等同界面「其他」自由输入行），
// 判断不出记未回答。真实用户能填的字，模拟用户也要能填——否则「提供一个人名」这类问题永远走不通。
//
// 曾有一级规则匹配（档案文本包含选项原文即命中），2026-08-03 删除：档案要写「问到 X 时选 Y」，
// X 就是问题里的词，中文里 X 与选项文字重合是常态，会稳定选中相反答案（实测用例 14、17 三轮全中）。
// 换写法躲不掉——只要档案提到问题就可能撞上选项。稳定给出错误答案比偶尔波动更糟。

import type { AskQuestion } from './cards'

export interface AskAnswerDetail {
  question: string
  answer: string | null // 多选用「、」连接（与界面提交格式一致）；null = 未回答
  source: 'option' | 'text' | 'unanswered' // option=选中选项，text=自由输入
  reason?: string // 未回答时的原因
}

// 自由文本上限：用户在「其他」框里不会打长文。超限视为模型在解释而非作答
const TEXT_MAX = 50

export type ParsedAnswer = { picked: string[] } | { text: string } | null

// 模型输出解析：纯编号且落在选项范围内 → 选项；0 → 判断不出；其余非空文本 → 自由输入。
// 纯数字但越界（如输出一个日期）不算非法，当自由输入处理；单选给多个编号是矛盾输出，判未回答。
export function parseModelAnswer(text: string, q: AskQuestion): ParsedAnswer {
  const t = text.trim()
  if (!t) return null
  if (/^[\d,，、\s]+$/.test(t)) {
    const idx = [...new Set(t.split(/[,，、\s]+/).filter(Boolean).map(Number))]
    if (idx.includes(0)) return null
    if (!q.multiSelect && idx.length > 1) return null
    if (idx.every((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length))
      return { picked: idx.map((n) => q.options[n - 1].label) }
    // 越界数字：不是编号，当用户手填的值（日期、编号、工号）
  }
  return t.length <= TEXT_MAX ? { text: t } : null
}

const RESPONDER_SYSTEM =
  '你是自动化测试的应答器，代替用户回答提问卡。依据「意图档案」判断这个用户会怎么答，按以下三种之一输出：\n' +
  '1. 档案指向某个选项时：只输出该选项编号（如：2）；标注可多选的题可输出多个编号，用逗号分隔\n' +
  '2. 题目没有给选项，或给的选项都不合适、而档案里能看出用户会填什么时：直接输出那个答案本身（相当于用户在卡片的「其他」里手填）。只写答案，不要写「用户会填」之类的话，不要解释\n' +
  '3. 档案完全判断不出时：输出 0\n' +
  '除上述内容外不要输出任何文字。'

// 逐题应答：模型输出非法或调用失败按「未回答」记录原因，不阻塞执行。
// callModel 注入（评估通道传 Chime 默认模型的非流式调用），本模块保持纯逻辑可自检
export async function answerWithProfile(
  profile: string,
  questions: AskQuestion[],
  callModel: (system: string, user: string) => Promise<string>
): Promise<AskAnswerDetail[]> {
  const out: AskAnswerDetail[] = []
  for (const q of questions) {
    try {
      const numbered = q.options.length
        ? q.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')
        : '（这题没有选项，需要直接写出答案）'
      const user = `意图档案：\n${profile}\n\n问题：${q.question}${q.multiSelect ? '（可多选）' : ''}\n选项：\n${numbered}`
      const text = await callModel(RESPONDER_SYSTEM, user)
      const parsed = parseModelAnswer(text, q)
      if (parsed && 'picked' in parsed)
        out.push({ question: q.question, answer: parsed.picked.join('、'), source: 'option' })
      else if (parsed) out.push({ question: q.question, answer: parsed.text, source: 'text' })
      else
        out.push({
          question: q.question,
          answer: null,
          source: 'unanswered',
          reason: `模型输出既不是合法编号也不是可用答案：${text.trim().slice(0, 50) || '（空）'}`
        })
    } catch (e) {
      out.push({
        question: q.question,
        answer: null,
        source: 'unanswered',
        reason: `模型调用失败：${String(e).slice(0, 100)}`
      })
    }
  }
  return out
}
