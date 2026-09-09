// 压缩三级（018 七节）：估算到触发线时——
// 一级：清除旧的工具返回，换成结果编号指针（只改本轮内存里的消息序列，库里原文不动）；
// 二级：请模型把前半段对话写成摘要，用摘要与几条重建消息替换掉摘要之前的全部消息（落库，此后从这里重建历史）；
// 三级：摘要失败、连续失败已停用、或重建后仍超线时，从最早的正文消息起整对丢弃（每轮重算，不落库）。
// 摘要请求带与正常轮次相同的系统提示词与工具清单、禁止调用工具：请求开头与上一轮一致，整段历史命中缓存

import { generateText, type LanguageModel, type ModelMessage, type Tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { join } from 'path'
import { estimateTokensBase } from '../../shared/tokens'
import { builtinDisplay } from '../../shared/builtinTools'
import {
  findToolResultIdByCallId,
  insertToolResult,
  listToolResults,
  getConversationCompaction,
  setConversationCompaction,
  bumpConversationCompactFailures,
  getConversationSystemPrompt,
  getConversationAgent,
  getAgent,
  getConversationMcpSelection,
  getDb,
  resolveModelRef
} from '../db'
import { getSkill, listSkills, ACTIVATE_TOOL_NAME, SKILL_BODY_PREFIX } from '../skills'
import { skillsRoot } from './fs-tools'
import { NON_DATA_TOOLS, type OverflowCtx } from './overflow'
import { loadHistoryMessages, isConvActive, type HistoryBundle } from './store'
import {
  insertReminder,
  skillScope,
  todayText,
  dateKey,
  buildUserContext,
  buildSkillListing,
  buildSummary,
  buildSkillBodies,
  buildResultIndex,
  mcpAddedContents,
  previousSkillBodies,
  SKILL_TRUNCATION_MARK,
  REMINDER_ROLE,
  type SkillEntry
} from './reminders'
import { ensureDeferredTable, bareName, type DeferredTool } from './deferred'
import { assembleTurnTools, definitionsOnly } from './toolset'
import type { CardQueue } from './cards'
import type { TurnToolContext } from './tools'

export const MAX_COMPACT_FAILURES = 3 // 连续失败满 3 次停用自动摘要（Claude Code 同值）
export const SUMMARY_MAX_OUTPUT = 20_000 // 与 COMPACT_RESERVE 里的摘要输出预留同口径
const SKILL_BODY_MAX = 5_000
const SKILL_BODIES_MAX = 25_000
const RELIEF_KEEP_RECENT = 5
const RELIEF_MIN_SAVE_TOKENS = 20_000

// 用 <system-reminder> 包起来（系统段已说明这类文字由系统加入）：自测时模型把这条指令当成了用户的最后一条消息，
// 写进了「用户的请求与意图」与「全部用户消息」
export const SUMMARY_PROMPT = `<system-reminder>
这条指令由系统发出，不是用户说的话，不要把它写进摘要。只输出文字，不要调用任何工具。

你的任务是把上面这段对话写成一份详细的摘要，重点放在用户明确提出的要求，以及你已经做过的事情。

先在 <analysis> 标签里梳理你的思路，确认下面每一项都覆盖到了。然后在 <summary> 标签里写出摘要，按这九节组织：

1. 用户的请求与意图：完整记下用户提过的全部要求
2. 关键的业务概念与规则：对话里出现过的业务概念、规则、术语
3. 查到的资料与数据：查到了什么，来自哪个工具或哪份资料，带上原文里的关键数值
4. 出过的问题与用户的纠正：出过哪些错，怎么改的；用户纠正过你什么，原话是怎么说的
5. 问题解决的过程：解决了哪些问题，还有哪些在查
6. 全部用户消息：逐条列出用户说过的每一句话，工具返回不算。这些对理解用户的反馈和意图变化很关键
7. 待办：用户明确要求你做、还没做完的事
8. 当前在做什么：写这份摘要之前你正在做的那件事，写具体
9. 下一步：接着要做的那一步。带上最近对话里的原话引用，逐字照抄，避免任务解读走样。上一件事已经做完的，只在用户明确要求过的范围内写下一步
</system-reminder>`

export type SummaryFailure = 'request' | 'no_summary_tag' | 'aborted'

// ── 二级：摘要请求 ─────────────────────────────────────────────
export async function summarize(o: {
  lm: LanguageModel
  system: string
  tools: Record<string, Tool>
  messages: ModelMessage[]
  signal?: AbortSignal
}): Promise<{ ok: true; text: string } | { ok: false; reason: SummaryFailure }> {
  try {
    const r = await generateText({
      model: o.lm,
      instructions: o.system,
      messages: [...o.messages, { role: 'user', content: SUMMARY_PROMPT }],
      tools: o.tools,
      toolChoice: 'none',
      maxOutputTokens: SUMMARY_MAX_OUTPUT,
      abortSignal: o.signal
    })
    const m = /<summary>([\s\S]*?)<\/summary>/.exec(r.text)
    if (!m || !m[1].trim()) return { ok: false, reason: 'no_summary_tag' }
    return { ok: true, text: m[1].trim() }
  } catch {
    return { ok: false, reason: o.signal?.aborted ? 'aborted' : 'request' }
  }
}

// ── 重建 ─────────────────────────────────────────────────────
function truncateTokens(text: string, max: number): string {
  if (estimateTokensBase(text) <= max) return text
  let cut = text
  while (estimateTokensBase(cut) > max && cut.length > 0) {
    const ratio = max / estimateTokensBase(cut)
    cut = cut.slice(0, Math.max(0, Math.floor(cut.length * ratio) - 1))
  }
  return `${cut}\n\n${SKILL_TRUNCATION_MARK}`
}

// 摘要范围里激活过的技能名：扫 tool 消息里激活工具的成功返回（以「【技能：名字】」开头），最近的在前
function activatedIn(messages: ModelMessage[]): string[] {
  const out: string[] = []
  for (const m of [...messages].reverse()) {
    if ((m as { role: string }).role !== 'tool' || !Array.isArray(m.content)) continue
    for (const p of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
      if (p.type !== 'tool-result' || p.toolName !== ACTIVATE_TOOL_NAME) continue
      const v = typeof p.output?.value === 'string' ? p.output.value : ''
      const mm = /^【技能：(.+?)】/.exec(v)
      if (mm && v.startsWith(SKILL_BODY_PREFIX(mm[1])) && !out.includes(mm[1])) out.push(mm[1])
    }
  }
  return out
}

export function rebuildAfterSummary(o: {
  convId: string
  summary: string
  summarized: ModelMessage[] // 摘要范围，找激活过的技能用
  skillEntries: SkillEntry[] // 本会话的技能范围（skill_listing 重新生成）
  displayOf: (toolName: string) => string
  createdAtBase?: number // 重试路径：该轮首行的 created_at − 7；缺省当前时间
}): void {
  const at = o.createdAtBase ?? Date.now()
  let i = 0
  const today = todayText()
  insertReminder(o.convId, 'user_context', buildUserContext(today), { date: dateKey(today) }, at + i++)
  if (o.skillEntries.length)
    insertReminder(
      o.convId,
      'skill_listing',
      buildSkillListing(o.skillEntries),
      { skills: o.skillEntries.map((s) => s.name) },
      at + i++
    )
  insertReminder(o.convId, 'summary', buildSummary(o.summary), null, at + i++)

  // 已激活技能的正文：本段激活的 ∪ 上次重建记下的；单个超 5000 tokens 截头部，合计超 25000 从这一个起不拼
  const names = [...activatedIn(o.summarized)]
  for (const n of previousSkillBodies(o.convId)) if (!names.includes(n)) names.push(n)
  const bodies: { name: string; dir: string; body: string }[] = []
  let total = 0
  for (const name of names) {
    const detail = getSkill(name)
    if (!detail) continue
    const md = detail.files.find((f) => f.path === 'SKILL.md')?.content ?? ''
    const body = truncateTokens(md, SKILL_BODY_MAX)
    const n = estimateTokensBase(body)
    if (total + n > SKILL_BODIES_MAX) break
    total += n
    bodies.push({ name, dir: join(skillsRoot(), name), body })
  }
  if (bodies.length)
    insertReminder(
      o.convId,
      'skill_bodies',
      buildSkillBodies(bodies),
      { skills: bodies.map((b) => b.name) },
      at + i++
    )

  const results = listToolResults(o.convId)
  if (results.length)
    insertReminder(
      o.convId,
      'result_index',
      buildResultIndex(
        results.map((r) => ({ id: r.id, display: o.displayOf(r.toolName), chars: r.chars }))
      ),
      null,
      at + i++
    )
  for (const content of mcpAddedContents(o.convId))
    insertReminder(o.convId, 'mcp_replay', content, null, at + i++)

  setConversationCompaction(o.convId, at, 0)
}

// 重试路径：末条用户消息往前跳过连续的提醒消息行，得到这一轮的首行 created_at
function lastTurnFirstRowAt(convId: string): number | null {
  const rows = getDb()
    .prepare(
      'SELECT role, created_at AS at FROM message WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC'
    )
    .all(convId) as { role: string; at: number }[]
  const u = rows.findIndex((r) => r.role === 'user')
  if (u < 0) return null
  let at = rows[u].at
  for (let k = u + 1; k < rows.length && rows[k].role === REMINDER_ROLE; k++) at = rows[k].at
  return at
}

// 重试路径：内存里的 history 末尾是上一次的追加消息与用户消息，摘要输入截到它们之前
function currentTurnStart(history: ModelMessage[], bundle: HistoryBundle): number {
  const reminderIdx = new Set(bundle.reminders.map((r) => r.msgIdx))
  let i = history.length - 1
  while (i >= 0 && !((history[i] as { role: string }).role === 'user' && !reminderIdx.has(i))) i--
  if (i < 0) return history.length
  while (i - 1 >= 0 && reminderIdx.has(i - 1)) i--
  return i
}

// ── 三级：整对丢弃 ─────────────────────────────────────────────
// 起点是会话引导行与重建行之后的第一条正文消息。切口修整（V1 实测 2026-08-18）：盲切两条可能把带 tool_calls
// 的 assistant 消息切掉、留下孤立的 tool 消息在队首，DeepSeek 对此报 400——切完把队首孤立 tool 丢掉
function dropOldest(
  history: ModelMessage[],
  start: number,
  over: (h: ModelMessage[]) => boolean
): { history: ModelMessage[]; dropped: boolean } {
  let h = history
  let dropped = false
  while (h.length > start + 2 && over(h)) {
    h = [...h.slice(0, start), ...h.slice(start + 2)]
    while (h.length > start && (h[start] as { role?: string }).role === 'tool')
      h = [...h.slice(0, start), ...h.slice(start + 1)]
    dropped = true
  }
  return { history: h, dropped }
}

// ── 判定顺序 ─────────────────────────────────────────────────
export interface CompactOutcome {
  history: ModelMessage[]
  bundle: HistoryBundle
  dropped: boolean // 走到了三级
  savedTokens?: number
  reason?: string // 走到三级的原因
  aborted?: boolean // 摘要请求被用户停止：本轮按停止收场，不计失败
}

export async function compactIfNeeded(o: {
  convId: string
  lm: LanguageModel
  system: string
  tools: Record<string, Tool>
  history: ModelMessage[]
  bundle: HistoryBundle
  estimateOf: (h: ModelMessage[]) => number
  line: number
  signal: AbortSignal
  skillEntries: SkillEntry[]
  displayOf: (toolName: string) => string
  keyOf: (fullName: string) => string
  retry: boolean
}): Promise<CompactOutcome> {
  let { history, bundle } = o
  const over = (h: ModelMessage[]): boolean => o.estimateOf(h) >= o.line
  if (!over(history)) return { history, bundle, dropped: false }

  // 一级：按时间从早到晚清工具返回，保留最近 5 条；不足 500 字符的跳过；全部候选省不下 20000 tokens 不动手；
  // 清到低于触发线就停。被清内容幂等入库（同一调用复用编号），模型凭编号随时查回
  const candidates = bundle.toolOutputs.filter((c) => !NON_DATA_TOOLS.has(c.toolName))
  const clearable = candidates.slice(0, Math.max(0, candidates.length - RELIEF_KEEP_RECENT))
  const partOf = (c: (typeof clearable)[number]): { output: { value: string } } | null => {
    const msg = history[c.msgIdx] as unknown as { content?: { output?: { value?: unknown } }[] }
    const part = msg?.content?.[c.partIdx]
    return part?.output && typeof part.output.value === 'string' && part.output.value.length >= 500
      ? (part as { output: { value: string } })
      : null
  }
  const savable = clearable.reduce((s, c) => s + estimateTokensBase(partOf(c)?.output.value ?? ''), 0)
  if (savable >= RELIEF_MIN_SAVE_TOKENS) {
    for (const c of clearable) {
      if (!over(history)) break
      const p = partOf(c)
      if (!p) continue
      const id =
        c.resultRef ??
        findToolResultIdByCallId(c.toolCallId) ??
        insertToolResult({
          conversationId: o.convId,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          content: p.output.value
        })
      p.output.value = `（这段返回已移出对话释放空间，完整内容在结果编号 #${id}——用 grep_result 搜关键词、read_result 按行读取；任何给用户看的文字不要提编号或存取机制）`
    }
  }
  if (!over(history)) return { history, bundle, dropped: false }

  // 二级
  let reason: string
  const { failures } = getConversationCompaction(o.convId)
  if (failures >= MAX_COMPACT_FAILURES) reason = '摘要连续失败已停用'
  else {
    const cut = o.retry ? currentTurnStart(history, bundle) : history.length
    const res = await summarize({
      lm: o.lm,
      system: o.system,
      tools: o.tools,
      messages: history.slice(0, cut),
      signal: o.signal
    })
    if (!res.ok) {
      if (res.reason === 'aborted') return { history, bundle, dropped: false, aborted: true }
      bumpConversationCompactFailures(o.convId)
      reason = res.reason === 'request' ? '摘要请求出错' : '摘要返回里没有 summary 标签'
    } else {
      const base = o.retry ? (lastTurnFirstRowAt(o.convId) ?? Date.now()) - 7 : undefined
      rebuildAfterSummary({
        convId: o.convId,
        summary: res.text,
        summarized: history.slice(0, cut),
        skillEntries: o.skillEntries,
        displayOf: o.displayOf,
        createdAtBase: base
      })
      bundle = loadHistoryMessages(o.convId, o.keyOf)
      history = bundle.messages
      if (!over(history)) return { history, bundle, dropped: false }
      reason = '重建后仍超线'
    }
  }

  // 三级
  const before = o.estimateOf(history)
  const r = dropOldest(history, bundle.dialogStart, over)
  const saved = before - o.estimateOf(r.history)
  return {
    history: r.history,
    bundle,
    dropped: r.dropped,
    savedTokens: saved > 0 ? saved : undefined,
    reason
  }
}

// ── 手动压缩（Case 9 Feature 5）────────────────────────────────
// 不经过 runTurn：直接跑摘要与重建。没发过一轮（没有系统提示词）或有轮在跑时不做
export async function compactNow(
  convId: string,
  model: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const system = getConversationSystemPrompt(convId)
  if (system === null) return { ok: false, error: '会话还没有内容' }
  if (isConvActive(convId)) return { ok: false, error: '回复进行中' }
  const p = resolveModelRef(model)
  if (!p || !p.apiKey) return { ok: false, error: '模型无法定位' }
  const provider = createOpenAICompatible({
    name: 'chime',
    baseURL: p.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: p.apiKey,
    includeUsage: true
  })
  const { agentId } = getConversationAgent(convId)
  const agent = agentId === null ? null : getAgent(agentId)
  const mcpSelection = new Set([
    ...getConversationMcpSelection(convId),
    ...(agent?.mcpSel ?? []).map((e) => e.id)
  ])
  const deferred: DeferredTool[] = ensureDeferredTable(convId, mcpSelection)
  const keyOf = (fullName: string): string =>
    deferred.find((e) => e.fullName === fullName)?.key ?? bareName(fullName)
  const displayOf = (toolName: string): string =>
    builtinDisplay(toolName) ??
    (() => {
      const e = deferred.find((x) => x.fullName === toolName)
      return e ? e.title || `${e.serviceName}:${bareName(e.fullName)}` : toolName
    })()
  const skillLib = new Map(listSkills().map((s) => [s.name, s.description]))
  const skillEntries: SkillEntry[] = skillScope(convId)
    .filter((n) => skillLib.has(n))
    .map((n) => ({ name: n, description: skillLib.get(n)! }))
  const bundle = loadHistoryMessages(convId, keyOf)
  // 与正常轮次逐字相同的工具清单（只留定义）：卡片队列等轮内上下文这里用不上，永远不执行
  const dummy = new AbortController().signal
  const toolCtx: TurnToolContext = { pool: [], poolByCall: new Map(), searches: 0, kbIds: [], kbNames: new Map() }
  const tools = definitionsOnly(
    assembleTurnTools({
      convId,
      signal: dummy,
      cards: {} as CardQueue,
      overflow: { convId, refs: new Map(), turnFullChars: 0 } as OverflowCtx,
      onFsCard: () => {},
      toolCtx,
      skillNames: skillEntries.map((s) => s.name),
      getHistory: () => bundle.messages,
      onArtifact: () => {},
      deferred,
      onInvokeAuth: () => {}
    })
  )
  const res = await summarize({ lm: provider(p.model), system, tools, messages: bundle.messages })
  if (!res.ok)
    return {
      ok: false,
      error: res.reason === 'request' ? '摘要请求出错' : '模型没有返回摘要'
    }
  rebuildAfterSummary({
    convId,
    summary: res.text,
    summarized: bundle.messages,
    skillEntries,
    displayOf
  })
  return { ok: true }
}
