// 编排引擎：一轮 = 组装上下文 → streamText 多步循环 → 类型化事件流。
// 三个消费方共用事件（界面渲染 / 无界面 JSONL 输出），落库节点化：弹卡时 / 卡片回应后 / 轮终结（同一行 UPSERT）。
// 本文件不依赖 BrowserWindow，界面与能力分离。
// 重启后的等待卡不续跑：启动修复把卡作废（repairConversation），用户直接说、模型重新发起（PRD 定稿修订）。

import { streamText, isStepCount } from 'ai'
import type { ModelMessage, Tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import {
  resolveModelRef,
  getConversationKbSelection,
  getConversationMcpSelection,
  getConversationAgent,
  getAgent,
  listKbs,
  kbStatsFor,
  findToolResultIdByCallId,
  insertToolResult,
  getConversationWs,
  setConversationWs,
  touchWsRecent,
  type AgentRow
} from '../db'
import { EMBED_MODEL_ID } from '../model'
import { humanize, markVendorHealth } from '../ai'
import { builtinDisplay } from '../../shared/builtinTools'
import { buildSystemPrompt, type KbEnv } from './prompts'
import { getMcpInstructions } from '../mcp/client'
import { budgetFor, estimateTokens, recordUsage } from './budget'
import {
  makeSearchTool,
  makeMcpTools,
  makeAskTool,
  makeGrepResultTool,
  makeReadResultTool,
  makeArtifactTool,
  ASK_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  ARTIFACT_TOOL_NAME,
  TOOL_ROUND_HARD_LIMIT,
  STEP_COUNT_LIMIT,
  type TurnToolContext
} from './tools'
import { makeFsTools, type FsCard } from './fs-tools'
import { listSkills, makeActivateSkillTool, ACTIVATE_TOOL_NAME } from '../skills'
import { sessionFullResultChars, applyTotalGate, type OverflowCtx } from './overflow'
import {
  CardQueue,
  INTERRUPT_NOT_STARTED,
  INTERRUPT_NOT_STARTED_EXIT,
  INTERRUPT_LOCAL,
  interruptExternal,
  ASK_INTERRUPTED,
  ASK_INTERRUPTED_EXIT,
  type CardDecision,
  type AskOutcome
} from './cards'
import {
  saveUserMessage,
  saveAssistantTurn,
  loadHistoryMessages,
  type TurnItem,
  type TurnStatus
} from './store'

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t']; item: TurnItem }
  | { type: 'item-delta'; streamId: string; index: number; text: string }
  | { type: 'item-done'; streamId: string; index: number; item: TurnItem }
  | { type: 'item-update'; streamId: string; index: number; item: TurnItem } // 状态流转（授权等），非终态
  | {
      type: 'turn-done'
      streamId: string
      status: TurnStatus
      error?: string
      usage?: { inputTokens: number; outputTokens: number }
      contextRatio: number
    }
  | { type: 'notice'; streamId: string; text: string }

export type Emit = (e: ChatEvent) => void

const turns = new Map<string, AbortController>()

export function stopTurn(streamId: string): void {
  turns.get(streamId)?.abort()
}

// 启动修复的收场文案（第一级等卡作废 / 第三级外部 / 第二级本地 / 提问卡作废），store 不依赖 cards、由调用方传入
export const REPAIR_TEXTS = {
  notStarted: INTERRUPT_NOT_STARTED_EXIT,
  external: interruptExternal('应用退出'),
  local: INTERRUPT_LOCAL,
  ask: ASK_INTERRUPTED_EXIT
}

// 额度信号统一前缀：注入时以此识别旧注去重，模型端据此知道是内部信号（随行标注，集中声明拦不住）
const BUDGET_NOTE_PREFIX = '（内部信号，不要向用户提及：'

interface SdkError extends Error {
  statusCode?: number
}

// 模型服务报错 → 用户可读文案（规则 6：超长兜底与规则 5 同口径，不静默重试）
function humanizeError(e: unknown): string {
  const err = e as SdkError
  if (/context|length|token/i.test(err.message ?? '')) return '消息过长，请精简或拆分'
  if (err.statusCode) return humanize(err.statusCode)
  return '网络连接失败，请检查网络后重试'
}

// 挂库判定（组装时）：需重建（本地模型已更换）按无知识库组装并提示，「更新中」则正常挂、由工具返回 busy 语义
// 会话选库 → 检索环境：逐库判定可用性。被移除的静默剔除（控件已展示），
// embed 模型不匹配的剔除并提示（需重建才能检索）
// 会话选用的 Agent（014 Case 4）：id 现查配置（跟随最新），Agent 已删返回 null（Case 5 降级）
function deriveAgent(convId: string): AgentRow | null {
  const { agentId } = getConversationAgent(convId)
  return agentId === null ? null : getAgent(agentId)
}

function deriveKbEnv(
  convId: string,
  agent: AgentRow | null,
  notice?: (text: string) => void
): KbEnv | null {
  // 知识库来源两条：历史会话自带的 kb_selection + Agent 挂的（合并去重；Agent 会话通常只有后者）
  const own = getConversationKbSelection(convId)
  const sel = [...own, ...(agent?.kbSel ?? []).filter((a) => !own.some((o) => o.id === a.id))]
  if (sel.length === 0) return null
  const all = new Map(listKbs().map((k) => [k.id, k]))
  const libraries: KbEnv['libraries'] = []
  const stale: string[] = []
  for (const s of sel) {
    const k = all.get(s.id)
    if (!k || !k.indexedAt) continue // 已移除 / 从未构建成功：不检索（UI 侧标注）
    if (k.embedModel && k.embedModel !== EMBED_MODEL_ID) {
      stale.push(k.name)
      continue
    }
    libraries.push({ id: k.id, name: k.name, intro: k.intro, docCount: kbStatsFor(k.id).files })
  }
  if (stale.length) notice?.(`本地模型已更换，知识库「${stale.join('、')}」需重建后才能检索`)
  return libraries.length ? { libraries } : null
}

export async function runTurn(opts: {
  streamId: string
  convId: string
  text: string
  model: string
  emit: Emit
  saveUser?: boolean // 重试时为 false：用户消息已在库里，不重复写
  refs?: TurnItem[] // 表格行引用 chip（013 Case 2）：随用户消息落库，历史组装时展开
  // 015 Case 1：首条消息随带的工作空间选中集合（合并后全部上授权卡统一确认，Agent 默认值不构成授权）。
  // 已定格（ws_list 非 NULL）的会话忽略此字段
  ws?: { picked: string[]; fromAgent: string[] }
  // 015 Case 6：本轮消息斜杠点名的技能（renderer 已对库校验）——只并入激活工具的可选范围，
  // 不进系统提示词清单段（清单只放 Agent 配的）
  slashSkill?: string
}): Promise<void> {
  try {
    await runTurnBody(opts)
  } catch (e) {
    // 兜底收场：组装 / 落库等未预期异常也必须发 turn-done，否则渲染端路由不清空、输入框永久锁死
    console.error('[chime] runTurn 未预期异常:', e)
    opts.emit({
      type: 'turn-done',
      streamId: opts.streamId,
      status: 'error',
      error: '处理出错，请重试',
      contextRatio: 0
    })
  }
}

async function runTurnBody(opts: Parameters<typeof runTurn>[0]): Promise<void> {
  const { streamId, convId, text, model, emit } = opts
  const p = resolveModelRef(model)

  if (opts.saveUser !== false) saveUserMessage(convId, text, opts.refs)
  emit({ type: 'turn-start', streamId })

  const msgId = randomUUID()
  if (!p || !p.apiKey) {
    const items: TurnItem[] = [{ t: 'boundary', kind: 'error', text: '请先在设置里配置 API 密钥' }]
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'error' })
    emit({
      type: 'turn-done',
      streamId,
      status: 'error',
      error: '请先在设置里配置 API 密钥',
      contextRatio: 0
    })
    return
  }

  const agent = deriveAgent(convId)
  const kbEnv = deriveKbEnv(convId, agent, (t) => emit({ type: 'notice', streamId, text: t }))
  await streamCore({
    streamId,
    convId,
    model,
    emit,
    msgId,
    items: [],
    kbEnv,
    agent,
    ws: opts.ws,
    slashSkill: opts.slashSkill
  })
}

// 流式核心：工具组装、卡片队列、streamText 循环、来源结算、落库收场
async function streamCore(core: {
  streamId: string
  convId: string
  model: string
  emit: Emit
  msgId: string
  items: TurnItem[]
  kbEnv: KbEnv | null
  agent: AgentRow | null
  ws?: { picked: string[]; fromAgent: string[] }
  slashSkill?: string
}): Promise<void> {
  const { streamId, convId, model, emit, msgId, items, kbEnv, agent } = core
  const p = resolveModelRef(model)
  if (!p || !p.apiKey || !p.enabled) {
    saveAssistantTurn(convId, msgId, { content: '', items: [], status: 'error' })
    emit({
      type: 'turn-done',
      streamId,
      status: 'error',
      error: p ? '该模型所属的服务商未启用或未配置密钥' : '模型无法定位，请重新选择',
      contextRatio: 0
    })
    return
  }

  let cur = -1
  const startItem = (t: TurnItem['t'], item: TurnItem): void => {
    items.push(item)
    cur = items.length - 1
    emit({ type: 'item-start', streamId, index: cur, t, item })
  }
  const appendText = (delta: string): void => {
    ;(items[cur] as { text: string }).text += delta
    emit({ type: 'item-delta', streamId, index: cur, text: delta })
  }
  const endItem = (): void => {
    // 上游 SDK（@ai-sdk/openai-compatible）在 tool_calls 到达时不关闭文本块，text-end 拖到
    // 整条流末尾才发；此时 cur 已被 tool-call 移到工具 item，直接收尾会给同一次工具调用
    // 发出第二条 item-done（事件流消费方会看到假的重复调用）。只有 cur 仍指向文本类 item 才收尾
    const it = items[cur]
    if (!it || (it.t !== 'text' && it.t !== 'reasoning')) return
    emit({ type: 'item-done', streamId, index: cur, item: it })
  }
  const finish = (
    status: TurnStatus,
    error?: string,
    usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
    contextRatio = 0
  ): void => {
    // 模型可能发出空的 text/reasoning 段（如开了个头就转去调工具），不落库
    const kept = items.filter((i) => (i.t !== 'text' && i.t !== 'reasoning') || i.text.trim())
    const content =
      [...kept].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
    saveAssistantTurn(convId, msgId, { content, items: kept, status, usage })
    emit({ type: 'turn-done', streamId, status, error, usage, contextRatio })
  }
  // 弹卡即落库 / 卡片回应后落库：等待中的快照（最终态由 finish 覆盖）
  const persistWaiting = (): void => {
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'waiting' })
  }

  const controller = new AbortController()
  turns.set(streamId, controller)

  // 轮内状态：检索计数与来源池（连续编号）；limitHit = 触接口级禁止（触边界强制作答）
  const toolCtx: TurnToolContext = {
    pool: [],
    searches: 0,
    kbIds: kbEnv?.libraries.map((l) => l.id) ?? [],
    kbNames: new Map(kbEnv?.libraries.map((l) => [l.id, l.name]) ?? [])
  }
  let limitHit = false
  const toolItemIndex = new Map<string, number>() // toolCallId → items 下标
  const toolStartAt = new Map<string, number>()
  const lateSummaries = new Map<string, string>() // 总量闸先于 tool-result 事件时的暂存（toolCallId → 摘要）

  // 卡片队列（授权卡 + 提问卡共用）：用户回应回来时更新对应 tool item 状态、落库并推送。
  // 回应可能先于 tool-call 事件到达消费循环（自测钩子同步回应），先记下、建行时补上
  const earlyAuth = new Map<string, 'approved' | 'denied' | 'unanswered'>()
  const earlyAsk = new Map<string, Extract<TurnItem, { t: 'tool' }>['ask']>()
  const authOf = (d: CardDecision): 'approved' | 'denied' | 'unanswered' =>
    d === 'aborted' ? 'unanswered' : d === 'always' ? 'approved' : d // 「总是允许」的记录动作在发起处，这里只是状态展示
  const askOf = (o: AskOutcome): Extract<TurnItem, { t: 'tool' }>['ask'] =>
    o.kind === 'answers'
      ? { state: 'answered', answers: o.answers }
      : o.kind === 'declined'
        ? { state: 'skipped' }
        : { state: 'unanswered' }
  const cards = new CardQueue(
    streamId,
    controller.signal,
    (toolCallId, decision) => {
      const idx = toolItemIndex.get(toolCallId)
      if (idx === undefined) {
        earlyAuth.set(toolCallId, authOf(decision))
        return
      }
      const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
      item.auth = authOf(decision)
      if (decision !== 'aborted') persistWaiting() // 卡片回应后节点（停止收场由 catch 统一落库）
      emit({ type: 'item-update', streamId, index: idx, item })
    },
    (toolCallId, outcome) => {
      const idx = toolItemIndex.get(toolCallId)
      if (idx === undefined) {
        earlyAsk.set(toolCallId, askOf(outcome))
        return
      }
      const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
      item.ask = askOf(outcome)
      if (outcome.kind !== 'aborted') persistWaiting()
      emit({ type: 'item-update', streamId, index: idx, item })
    }
  )

  // 申请授权卡载荷（015 C2）：文件工具 execute 判定白名单外时挂载载荷并置 pending（弹卡即落库）。
  // 与 earlyAuth 同因：execute 的判定可能先于 tool-call 事件到达消费循环
  const earlyFsCard = new Map<string, FsCard>()
  const onFsCard = (toolCallId: string, card: FsCard): void => {
    const idx = toolItemIndex.get(toolCallId)
    if (idx === undefined) {
      earlyFsCard.set(toolCallId, card)
      return
    }
    const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
    item.fsCard = card
    item.auth = 'pending'
    persistWaiting()
    emit({ type: 'item-update', streamId, index: idx, item })
  }

  // 工作空间定格（015 Case 1，2026-08-17 拍板修订）：授权已在目录进入选中集合那一刻由界面弹窗完成
  //（勾选清单项、Agent 带入默认、亲手选文件夹都先确认），首条消息静默把选中集合复制为会话授权清单。
  // 驱动会话（--eval）无界面：Agent 默认目录随创建定格即授权（驱动线预期）。授权不跨会话，无持久记录
  if (getConversationWs(convId) === null) {
    const allSel = [
      ...new Set(
        [...(core.ws?.picked ?? []), ...(core.ws?.fromAgent ?? agent?.wsSel ?? [])].map((x) =>
          resolve(x)
        )
      )
    ]
    setConversationWs(convId, allSel)
    if (allSel.length) touchWsRecent(allSel)
  }

  // 超限处理轮内状态：会话基线一次算好，本轮增量随批累计
  const overflow: OverflowCtx = { convId, refs: new Map(), turnFullChars: 0 }
  const sessionBase = sessionFullResultChars(convId)
  const gatedSteps = new Set<number>() // 总量闸按步只跑一次

  // 制品：成功的生成调用不出工具步骤行，tool-result 时把该 item 换成制品卡（成果即过程）
  const artifacts = new Map<string, { id: number; title: string; rowCount: number }>()

  // 工具组装：内置（询问用户、查结果集、生成制品常备，挂库时含检索）+ 缓存中已启用服务的 MCP 工具全量注册（只读缓存，不现场请求服务）。
  // 服务范围 = 会话自加的 ∪ Agent 挂的（Agent 的服务已删/停用时不在缓存里，自然跳过——Case 5 降级）
  const mcpSelection = new Set([
    ...getConversationMcpSelection(convId),
    ...(agent?.mcpSel ?? []).map((e) => e.id)
  ])
  const mcp = makeMcpTools(controller.signal, cards, overflow, mcpSelection)
  const turnTools: Record<string, Tool> = { ...mcp.tools }
  turnTools[ASK_TOOL_NAME] = makeAskTool(controller.signal, cards)
  turnTools[GREP_TOOL_NAME] = makeGrepResultTool(convId)
  turnTools[READ_TOOL_NAME] = makeReadResultTool(convId)
  turnTools[ARTIFACT_TOOL_NAME] = makeArtifactTool(convId, (toolCallId, info) =>
    artifacts.set(toolCallId, info)
  )
  // 文件工具（015 C2 读/列；C3 加写/编辑）：无条件挂载，白名单校验在 execute 内
  Object.assign(
    turnTools,
    makeFsTools({ convId, signal: controller.signal, cards, overflow, onFsCard })
  )
  // 技能（015 C5）：Agent 清单现场对库过滤（已删除的自然剔除）。可激活范围 = Agent 清单 ∪
  // 本轮斜杠点名（C6，主进程对库再校验一道），非空才注册激活工具；提示词清单段只放 Agent 配的。
  // history 在下方组装后才赋值，激活工具经 getHistory 延迟取（执行必在流式循环内，晚于赋值）
  let history: ModelMessage[] = []
  const skillLib = new Map(listSkills().map((s) => [s.name, s.description]))
  const turnSkills = (agent?.skillSel ?? [])
    .filter((n) => skillLib.has(n))
    .map((n) => ({ name: n, description: skillLib.get(n)! }))
  const slashName = core.slashSkill && skillLib.has(core.slashSkill) ? core.slashSkill : null
  const activeSkillNames = [
    ...new Set([...turnSkills.map((s) => s.name), ...(slashName ? [slashName] : [])])
  ]
  if (activeSkillNames.length)
    turnTools[ACTIVATE_TOOL_NAME] = makeActivateSkillTool({
      names: activeSkillNames,
      getHistory: () => history
    })
  if (kbEnv) turnTools.search_knowledge_base = makeSearchTool(toolCtx)
  // 已启用但连不上的服务：工具静默不挂载，不进对话流提醒（07-13 修订——状态常驻输入框标识，与主流一致）

  // 组装：系统提示词（身份段 + 固定主干 + 输出约定 +（关联知识库）条件段 + 环境信息）+ 消息序列
  // 会话授权目录清单进环境信息（Case 2）：定格块已跑过，此处非 NULL；轮内申请授权通过的下一轮生效
  const system = buildSystemPrompt(
    kbEnv,
    getMcpInstructions(mcpSelection),
    agent?.prompt ?? null,
    getConversationWs(convId) ?? [],
    turnSkills,
    activeSkillNames.length > 0
  )
  const budget = budgetFor(model)
  // 历史加载放在 turnTools 组装之后（014 Case 5）：把本轮实际挂载的工具名传进去，
  // 已消失的工具在历史返回里标「已不可用」——模型会把历史当成当前能力的依据（实测）
  const bundle = loadHistoryMessages(convId, new Set(Object.keys(turnTools)))
  history = bundle.messages
  const sizeOf = (m: ModelMessage): number =>
    estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  const estimate = (): number => estimateTokens(system) + history.reduce((s, m) => s + sizeOf(m), 0)

  // 压力分级（07-14 核心改造，Claude Code 微压缩同构）：
  // L0 压力低不动；L1 超 70% 从最老的工具返回清起、换原地指针——只清数据不动对话主干，
  // 保最近 5 条；可省不足 2 万 token 不动手（清除打破服务端缓存，要么省一大笔要么不折腾）；
  // 检索返回不清（已定点转换成文档名）、提问卡问答不清（体积小且是关键上下文）、
  // 技能正文不清（是行事指令不是外部数据；清了摘要样例仍带头部标注，去重会误判已激活）。
  // 被清内容幂等入库（同一调用复用编号），模型凭编号随时查回，不必重调外部接口。
  const L1_PRESSURE = 0.7
  const RELIEF_KEEP_RECENT = 5
  const RELIEF_MIN_SAVE_TOKENS = 20_000
  const RELIEF_SKIP = new Set(['search_knowledge_base', ASK_TOOL_NAME, ACTIVATE_TOOL_NAME])
  if (estimate() > budget * L1_PRESSURE) {
    const candidates = bundle.toolOutputs.filter((c) => !RELIEF_SKIP.has(c.toolName))
    const clearable = candidates.slice(0, Math.max(0, candidates.length - RELIEF_KEEP_RECENT))
    const partOf = (c: (typeof clearable)[number]): { output: { value: string } } | null => {
      const msg = history[c.msgIdx] as unknown as { content?: { output?: { value?: unknown } }[] }
      const part = msg?.content?.[c.partIdx]
      return part?.output && typeof part.output.value === 'string'
        ? (part as { output: { value: string } })
        : null
    }
    const savable = clearable.reduce((s, c) => s + estimateTokens(partOf(c)?.output.value ?? ''), 0)
    if (savable >= RELIEF_MIN_SAVE_TOKENS) {
      for (const c of clearable) {
        if (estimate() <= budget * L1_PRESSURE) break
        const p = partOf(c)
        if (!p || p.output.value.length < 500) continue // 太小的不清：指针比内容还长
        const id =
          c.resultRef ??
          findToolResultIdByCallId(c.toolCallId) ??
          insertToolResult({
            conversationId: convId,
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            content: p.output.value
          })
        p.output.value = `（这段返回已移出对话释放空间，完整内容在结果编号 #${id}——用 grep_result 搜关键词、read_result 按行读取；任何给用户看的文字不要提编号或存取机制）`
      }
    }
  }
  // L2 最后防线：清完仍超预算才丢最旧消息对，且不再静默——丢的可能是任务开头的指令，用户须知情。
  // 切口修整（V1 实测 2026-08-18）：盲切两条可能把带 tool_calls 的 assistant 消息切掉、留下孤立的
  // tool 消息在队首，DeepSeek 对此报 400（tool 消息必须跟在 tool_calls 之后）——切完把队首孤立 tool 丢掉
  let droppedOldest = false
  while (history.length > 2 && estimate() > budget) {
    history = history.slice(2)
    while (history.length && (history[0] as { role?: string }).role === 'tool')
      history = history.slice(1)
    droppedOldest = true
  }
  if (droppedOldest)
    emit({ type: 'notice', streamId, text: '对话过长，最早的内容已让位；建议新开会话继续这个话题' })
  const estimatedInput = estimate()
  const contextRatio = Math.min(1, estimatedInput / budget)

  const provider = createOpenAICompatible({
    name: 'chime',
    baseURL: p.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: p.apiKey,
    includeUsage: true
  })
  // 附加参数（PRD Case 6）：某家独有的非标准开关随每次请求发出，靠配置不靠改代码
  const extraBody = Object.keys(p.extraParams).length ? p.extraParams : undefined

  try {
    const result = streamText({
      model: provider(p.model),
      providerOptions: extraBody ? ({ chime: extraBody } as never) : undefined,
      instructions: system,
      messages: history,
      abortSignal: controller.signal,
      tools: Object.keys(turnTools).length ? turnTools : undefined,
      // 三件事（07-13 修订：计轮 + 触顶告知，原为触顶静默摘工具清单——模型不知情会把调用吐进正文）：
      // 接口级禁止（含工具调用的轮数触顶后保留清单但禁止选择 + 注入收尾指令，模型只能作答）+
      // 额度过半预警（goose 同款，注入轻提示让模型收敛探索）+
      // 总量闸（上一步结果集齐、交给模型之前统一判定——批内从大到小落库改摘要，已给过的不回头改）
      prepareStep: ({ steps, messages }) => {
        const rounds = steps.filter((st) => st.toolCalls.length > 0).length
        const hardLimit = rounds >= TOOL_ROUND_HARD_LIMIT
        if (hardLimit) limitHit = true

        const lastIdx = steps.length - 1
        let gated: Map<string, string> | null = null
        if (lastIdx >= 0 && !gatedSteps.has(lastIdx)) {
          gatedSteps.add(lastIdx)
          const batch = (
            steps[lastIdx].toolResults as {
              toolCallId: string
              toolName: string
              output: unknown
            }[]
          )
            .filter(
              (tr) =>
                typeof tr.output === 'string' &&
                tr.toolName !== GREP_TOOL_NAME &&
                tr.toolName !== READ_TOOL_NAME && // 豁免：取数工具取回的片段不再落库
                tr.toolName !== ASK_TOOL_NAME && // 用户的回答不是外部数据
                tr.toolName !== ACTIVATE_TOOL_NAME && // 技能正文是指令不是外部数据，与 ask 同理
                !overflow.refs.has(tr.toolCallId) // 单结果闸已处理的不重复
            )
            .map((tr) => ({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              text: tr.output as string
            }))
          if (batch.length) {
            const replaced = applyTotalGate(overflow, sessionBase, batch)
            if (replaced.size) {
              gated = replaced
              for (const [callId, summary] of replaced) {
                const idx = toolItemIndex.get(callId)
                if (idx === undefined) {
                  lateSummaries.set(callId, summary) // tool-result 事件还没到消费循环，建行时补
                  continue
                }
                const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
                item.result = summary
                item.resultRef = overflow.refs.get(callId)
                emit({ type: 'item-update', streamId, index: idx, item })
              }
            }
          }
        }

        // 额度信号（内部属性随行标注，且每步去旧注新，避免 override 带到后续步时重复累积）
        const needNote = hardLimit || rounds * 2 >= TOOL_ROUND_HARD_LIMIT
        if (!hardLimit && !gated && !needNote) return undefined
        let msgs = messages
        if (gated) {
          // 改写消息序列：被落库的结果以摘要文本替代原文（override 会带到后续步）
          msgs = msgs.map((m) => {
            if (m.role !== 'tool' || !Array.isArray(m.content)) return m
            return {
              ...m,
              content: m.content.map((part) => {
                const p = part as { type: string; toolCallId?: string }
                if (p.type === 'tool-result' && p.toolCallId && gated!.has(p.toolCallId)) {
                  return { ...part, output: { type: 'text', value: gated!.get(p.toolCallId)! } }
                }
                return part
              })
            } as typeof m
          })
        }
        if (needNote) {
          msgs = msgs.filter(
            (m) =>
              !(
                m.role === 'user' &&
                typeof m.content === 'string' &&
                m.content.startsWith(BUDGET_NOTE_PREFIX)
              )
          )
          msgs = [
            ...msgs,
            {
              role: 'user' as const,
              content: hardLimit
                ? `${BUDGET_NOTE_PREFIX}工具调用轮次已达上限，本轮不能再调用任何工具。请立即基于已获得的信息回答用户；信息不足则说明还缺什么，然后停止。）`
                : // 07-14 修订：原文案「尽快基于已有信息收尾作答」会压过分页工作流条款——模型把取剩余分页也当探索砍掉，
                  // 只答第一页就收场。预警只砍试探性调用，作答必需的取数（剩余分页、制品生成）明确豁免
                  `${BUDGET_NOTE_PREFIX}工具调用额度已用 ${rounds}/${TOOL_ROUND_HARD_LIMIT} 轮。请把剩余额度用在回答必需的调用上：停止试探性的搜索和阅读；已知总页数的剩余分页在同一轮一次取完，不可只答部分页；该生成制品的照常生成；必需数据齐了立即作答。）`
            }
          ]
        }
        return {
          ...(hardLimit ? { toolChoice: 'none' as const } : {}),
          messages: msgs
        }
      },
      stopWhen: isStepCount(STEP_COUNT_LIMIT) // 防御性兜底，正常永远先触发硬闸
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-start':
          startItem('reasoning', { t: 'reasoning', text: '' })
          break
        case 'text-start':
          startItem('text', { t: 'text', text: '' })
          break
        case 'reasoning-delta':
        case 'text-delta':
          appendText(part.text)
          break
        case 'reasoning-end':
        case 'text-end':
          endItem()
          break
        case 'tool-call': {
          // 工具步骤无 delta：item-start 即「执行中」；需授权/提问的调用初始为 pending（排队/弹卡由渲染层从 items 推导）
          const meta = mcp.meta.get(part.toolName)
          const isAsk = part.toolName === ASK_TOOL_NAME
          const fsEarly = earlyFsCard.get(part.toolCallId) // 文件工具的申请授权卡先于本事件挂载时
          startItem('tool', {
            t: 'tool',
            name: part.toolName,
            id: part.toolCallId,
            display: builtinDisplay(part.toolName) ?? meta?.display,
            desc: meta?.needsAuth ? meta.desc : undefined,
            auth:
              meta?.needsAuth || fsEarly
                ? (earlyAuth.get(part.toolCallId) ?? 'pending')
                : undefined,
            fsCard: fsEarly,
            ask: isAsk ? (earlyAsk.get(part.toolCallId) ?? { state: 'pending' }) : undefined,
            args: (part.input ?? {}) as Record<string, unknown>
          })
          toolItemIndex.set(part.toolCallId, cur)
          toolStartAt.set(part.toolCallId, Date.now())
          const it = items[cur] as Extract<TurnItem, { t: 'tool' }>
          if (it.auth === 'pending' || it.ask?.state === 'pending') persistWaiting() // 弹卡即落库
          break
        }
        case 'tool-result': {
          const idx = toolItemIndex.get(part.toolCallId)
          if (idx === undefined) break
          // 制品生成成功：工具步骤行原地换成制品卡（成果即过程；失败保持普通工具行带错误）
          const art = artifacts.get(part.toolCallId)
          if (art) {
            // 内置工具规范：改写显示形态时保留这次调用的入参与返回，评分与回放靠它还原"用户看到了什么"，
            // 下一轮的历史重建靠它把制品还原成一次工具调用（写成一句助手台词会被模型当成自己说过的话模仿）
            const call = items[idx] as Extract<TurnItem, { t: 'tool' }>
            items[idx] = {
              t: 'artifact',
              ...art,
              args: call.args,
              callId: part.toolCallId,
              result: String(part.output)
            }
            emit({ type: 'item-done', streamId, index: idx, item: items[idx] })
            break
          }
          const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
          // 提问卡被校验拦下（014 Case 7）：卡片没弹出，tool-call 时预置的 pending 状态必须收掉，
          // 否则界面留一张永远等不到回应的假卡，且落库后重开会话还在
          if (
            item.name === ASK_TOOL_NAME &&
            typeof part.output === 'string' &&
            part.output.startsWith('这次提问没有发出')
          )
            delete item.ask
          // 超限结果：item 存摘要（全量在结果库），resultRef 指向结果编号
          item.result = lateSummaries.get(part.toolCallId) ?? part.output
          const ref = overflow.refs.get(part.toolCallId)
          if (ref !== undefined) item.resultRef = ref
          item.ms = Date.now() - (toolStartAt.get(part.toolCallId) ?? Date.now())
          emit({ type: 'item-done', streamId, index: idx, item })
          break
        }
        case 'error':
          throw part.error
      }
    }

    // 来源结算（B 路线）：流式结束后扫描回答的 [n] 反查结果池；无 [n] 则无来源区
    const answer = [...items]
      .reverse()
      .find((i): i is { t: 'text'; text: string } => i.t === 'text')
    if (answer && toolCtx.pool.length) {
      const cited = [...new Set([...answer.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
      const list = toolCtx.pool.filter((s) => cited.includes(s.n))
      if (list.length) {
        startItem('sources', { t: 'sources', list })
        endItem()
      }
    }
    if (limitHit) {
      startItem('boundary', { t: 'boundary', kind: 'limit' })
      endItem()
    }

    const usage = await result.usage
    const input = usage.inputTokens ?? 0
    recordUsage(estimatedInput, input)
    markVendorHealth(p.vendor, true)
    finish(
      'done',
      undefined,
      {
        inputTokens: input,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0
      },
      contextRatio
    )
  } catch (e) {
    if (controller.signal.aborted) {
      // 停止是正常收场：已流出内容保留，标 stopped。
      // 有调用必有结果：没拿到结果的调用按三级文案补齐——
      // 等卡/排队（已标未回应）→ 第一级；MCP 在途 → 第三级（是否生效未知）；本地在途 → 第二级
      items.forEach((it, idx) => {
        if (it.t !== 'tool' || it.result !== undefined) return
        if (it.auth === 'pending') it.auth = 'unanswered' // execute 未及入队时兜底
        if (it.ask) {
          // 提问卡被停止：记「未回应」，收 PRD 提问卡收场文案
          it.ask = { state: 'unanswered' }
          it.result = { interrupted: ASK_INTERRUPTED }
        } else {
          it.result = {
            interrupted:
              it.auth === 'unanswered'
                ? INTERRUPT_NOT_STARTED
                : it.auth === 'approved'
                  ? interruptExternal('用户停止')
                  : INTERRUPT_LOCAL
          }
        }
        emit({ type: 'item-update', streamId, index: idx, item: it })
      })
      finish('stopped', undefined, undefined, contextRatio)
    } else {
      const msg = humanizeError(e)
      // 鉴权 / 服务端错误 → 标记该服务商异常（控件警示 + 前往设置），下次成功或检测通过后解除
      const sc = (e as SdkError).statusCode
      if (sc && (sc === 401 || sc === 403 || sc >= 500)) markVendorHealth(p.vendor, false, msg)
      items.push({ t: 'boundary', kind: 'error', text: msg })
      finish('error', msg, undefined, contextRatio)
    }
  } finally {
    cards.dispose()
    turns.delete(streamId)
  }
}
