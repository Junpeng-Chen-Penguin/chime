// 编排引擎：一轮 = 组装上下文 → streamText 多步循环 → 类型化事件流。
// 三个消费方共用事件（界面渲染 / 无界面 JSONL 输出），落库节点化：弹卡时 / 卡片回应后 / 轮终结（同一行 UPSERT）。
// 本文件不依赖 BrowserWindow，界面与能力分离。
// 重启后的等待卡不续跑：启动修复把卡作废（repairConversation），用户直接说、模型重新发起（PRD 定稿修订）。

import { streamText, isStepCount } from 'ai'
import type { ModelMessage, Tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { randomUUID } from 'crypto'
import { appendFileSync } from 'fs'
import { resolve } from 'path'
import {
  resolveModelRef,
  getConversationKbSelection,
  getConversationMcpSelection,
  getConversationAgent,
  getAgent,
  listKbs,
  kbStatsFor,
  getConversationWs,
  setConversationWs,
  touchWsRecent,
  getConversationSystemPrompt,
  setConversationSystemPrompt,
  addConversationMcpSelection,
  getMcpService,
  setConversationLastContext,
  type AgentRow
} from '../db'
import {
  insertReminder,
  hasUserContext,
  firstMessageAt,
  toldDate,
  skillScope,
  mcpAnnounced,
  todayText,
  dateKey,
  buildUserContext,
  buildSkillListing,
  buildDateChange,
  buildSkillAdded,
  buildMcpAdded,
  buildToolListing,
  toolsAnnounced,
  type ReminderKind,
  type SkillEntry
} from './reminders'
import { kbReady } from '../kb'
import { humanize, markVendorHealth } from '../ai'
import { builtinDisplay } from '../../shared/builtinTools'
import { buildSystemPrompt, type KbEnv } from './prompts'
import { getMcpInstructions, setActiveRootsProvider } from '../mcp/client'
import {
  applyRatio,
  contextWindow,
  estimateTokens,
  recordUsage,
  toolsTokens,
  triggerLine
} from './budget'
import {
  ASK_TOOL_NAME,
  TOOL_ROUND_HARD_LIMIT,
  STEP_COUNT_LIMIT,
  type TurnToolContext
} from './tools'
import type { FsCard } from './fs-tools'
import { listSkills } from '../skills'
import { assembleTurnTools } from './toolset'
import { compactIfNeeded, compactManually } from './compact'
import { sessionFullResultChars, applyTotalGate, NON_DATA_TOOLS, type OverflowCtx } from './overflow'
import {
  ensureDeferredTable,
  entriesOf,
  decideResidentServices,
  definitionsTokens,
  bareName,
  TOOL_INVOKE_NAME
} from './deferred'
import {
  CardQueue,
  INTERRUPT_NOT_STARTED,
  INTERRUPT_NOT_STARTED_EXIT,
  INTERRUPT_LOCAL,
  interruptExternal,
  ASK_INTERRUPTED,
  ASK_INTERRUPTED_EXIT,
  USER_NOT_STARTED,
  USER_LOCAL,
  USER_EXTERNAL,
  type CardDecision,
  type AskOutcome
} from './cards'
import {
  saveUserMessage,
  expandUserMessage,
  saveAssistantTurn,
  loadHistoryMessages,
  loadSessionPool,
  markConvActive,
  unmarkConvActive,
  type TurnItem,
  type EndReason,
  type TurnUsage,
  type ContextUsage,
  type StepUsage as StepUsageRecord
} from './store'
import { estimateTokensBase } from '../../shared/tokens'

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t']; item: TurnItem }
  | { type: 'item-delta'; streamId: string; index: number; text: string }
  | { type: 'item-done'; streamId: string; index: number; item: TurnItem }
  | { type: 'item-update'; streamId: string; index: number; item: TurnItem } // 状态流转（授权等），非终态
  // 本轮新写进消息序列、模型看得到而对话流不显示的提醒消息（会话背景、技能清单、工具名清单、日期变更等）。
  // 给评估方（Tuner）用：评审要看到模型看到的全部材料，否则模型提到工具名清单里的名字会被判成编造
  | { type: 'context-note'; streamId: string; kind: string; text: string }
  | {
      type: 'turn-done'
      streamId: string
      endReason?: EndReason // 空 = 正常完成
      // 驱动协议的兼容字段（Tuner 与 eval 消费）：endReason 合成的收场语义，与 016 前同值域
      status: 'done' | 'stopped' | 'error' | 'interrupted'
      error?: string
      usage?: TurnUsage
      context?: ContextUsage // 本轮的上下文占用拆分（018 Case 10）；出错收场没有
    }

export type Emit = (e: ChatEvent) => void

const turns = new Map<string, AbortController>()

export function stopTurn(streamId: string): void {
  turns.get(streamId)?.abort()
}

// 启动修复的收场文案（第一级等卡作废 / 第三级外部 / 第二级本地 / 提问卡作废），store 不依赖 cards、由调用方传入。
// 016 六节起每级两份：model 给模型（进历史重建），user 给用户（挂 item.userText，进描述位）
export const REPAIR_TEXTS = {
  notStarted: { model: INTERRUPT_NOT_STARTED_EXIT, user: USER_NOT_STARTED },
  external: { model: interruptExternal('应用退出'), user: USER_EXTERNAL },
  local: { model: INTERRUPT_LOCAL, user: USER_LOCAL },
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

function deriveKbEnv(convId: string, agent: AgentRow | null): KbEnv | null {
  // 知识库来源两条：历史会话自带的 kb_selection + Agent 挂的（合并去重；Agent 会话通常只有后者）。
  // 可用性判定收口在 kbReady（016 十节）：需重建的库不挂，状态由输入区与设置页表达，不进对话流
  const own = getConversationKbSelection(convId)
  const sel = [...own, ...(agent?.kbSel ?? []).filter((a) => !own.some((o) => o.id === a.id))]
  if (sel.length === 0) return null
  const all = new Map(listKbs().map((k) => [k.id, k]))
  const libraries: KbEnv['libraries'] = []
  for (const s of sel) {
    const k = all.get(s.id)
    if (!k || !kbReady(k)) continue // 已移除 / 从未构建 / 需重建：不检索（界面侧标注）
    libraries.push({ id: k.id, name: k.name, intro: k.intro, docCount: kbStatsFor(k.id).files })
  }
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
  // 015 Case 6：本轮消息斜杠点名的技能（renderer 已对库校验）——点名清单外的技能时追加进本会话的技能范围
  slashSkill?: string
  // 018 Case 5：本轮消息斜杠点名的 MCP 服务 id；mcpPicked 是上次发送以来在面板里点过的服务，并入会话选用清单
  slashMcp?: number
  mcpPicked?: number[]
  // 018 Case 9 Feature 5：斜杠面板的「压缩上下文」。这一轮不请模型回答，只跑摘要与重建，
  // 界面上与模型调了一次压缩工具一样：用户消息「/压缩上下文」+ 一条压缩调用行 + 状态行
  command?: 'compact'
}): Promise<void> {
  try {
    await runTurnBody(opts)
  } catch (e) {
    // 兜底收场：组装 / 落库等未预期异常也必须发 turn-done，否则渲染端路由不清空、输入框永久锁死
    console.error('[chime] runTurn 未预期异常:', e)
    opts.emit({
      type: 'turn-done',
      streamId: opts.streamId,
      endReason: 'error',
      status: 'error',
      error: '处理出错，请重试'
    })
  }
}

async function runTurnBody(opts: Parameters<typeof runTurn>[0]): Promise<void> {
  const { streamId, convId, text, model, emit } = opts
  const p = resolveModelRef(model)

  // 用户消息不在这里落库（018 四节）：压缩重建的行与本轮的追加消息要排在它前面，
  // 组装完、压缩完才写，见 streamCore。点过的服务先并入选用清单，本轮的工具组装就能带上它
  if (opts.mcpPicked?.length) addConversationMcpSelection(convId, opts.mcpPicked)
  emit({ type: 'turn-start', streamId })

  const msgId = randomUUID()
  if (!p || !p.apiKey) {
    const items: TurnItem[] = [{ t: 'boundary', kind: 'error', text: '请先在设置里配置 API 密钥' }]
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'done', endReason: 'error' })
    emit({
      type: 'turn-done',
      streamId,
      endReason: 'error',
      status: 'error',
      error: '请先在设置里配置 API 密钥'
    })
    return
  }

  if (opts.command === 'compact') {
    await compactTurn({ streamId, convId, model, emit, msgId, text, refs: opts.refs })
    return
  }

  const agent = deriveAgent(convId)
  const kbEnv = deriveKbEnv(convId, agent)
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
    slashSkill: opts.slashSkill,
    slashMcp: opts.slashMcp,
    text,
    refs: opts.refs,
    saveUser: opts.saveUser !== false
  })
}

// 压缩轮（018 Case 9 Feature 5）：用户消息与回复都标 kind = 'compact'，界面照常显示、不进模型历史。
// 回复只有一条压缩调用行：进行中无 outcome；成功 ok 带省下的量；摘要出错 manual_failed、对话未改动；用户停止 aborted
async function compactTurn(o: {
  streamId: string
  convId: string
  model: string
  emit: Emit
  msgId: string
  text: string
  refs?: TurnItem[]
}): Promise<void> {
  const { streamId, convId, emit, msgId } = o
  saveUserMessage(convId, o.text, o.refs, 'compact')
  const item: Extract<TurnItem, { t: 'compaction' }> = { t: 'compaction' }
  const items: TurnItem[] = [item]
  saveAssistantTurn(convId, msgId, { content: '', items, status: 'running', kind: 'compact' })
  emit({ type: 'item-start', streamId, index: 0, t: 'compaction', item })
  const controller = new AbortController()
  turns.set(streamId, controller)
  try {
    const r = await compactManually(convId, o.model, controller.signal)
    if (r.ok) {
      item.outcome = 'ok'
      if (r.savedTokens) item.savedTokens = r.savedTokens
    } else if (r.reason === 'aborted') item.outcome = 'aborted'
    else {
      item.outcome = 'manual_failed'
      item.reason =
        r.reason === 'no_system'
          ? '会话还没有内容'
          : r.reason === 'no_model'
            ? '模型无法定位'
            : r.reason === 'request'
              ? '摘要请求出错'
              : '摘要返回里没有 summary 标签'
    }
  } finally {
    turns.delete(streamId)
  }
  emit({ type: 'item-done', streamId, index: 0, item })
  const endReason: EndReason | undefined = item.outcome === 'aborted' ? 'stopped' : undefined
  saveAssistantTurn(convId, msgId, { content: '', items, status: 'done', endReason, kind: 'compact' })
  emit({ type: 'turn-done', streamId, endReason, status: endReason ?? 'done' })
}

// 调试开关（只给开发与自测）：CHIME_LOG_REQUESTS=<文件路径> 时把每次模型请求的 body 追加写进该文件，一行一个 JSON。
// 用来核对相邻两次请求的消息序列逐字节是否一致（缓存命中排查），正常运行不设这个变量、不装 fetch
function loggingFetch(): typeof fetch | undefined {
  const path = process.env.CHIME_LOG_REQUESTS
  if (!path) return undefined
  return async (input, init) => {
    try {
      const body = typeof init?.body === 'string' ? init.body : null
      if (body) appendFileSync(path, JSON.stringify({ at: Date.now(), body: JSON.parse(body) }) + '\n')
    } catch {
      /* 调试日志写不进去不影响请求 */
    }
    return fetch(input, init)
  }
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
  slashMcp?: number
  text: string // 本轮用户消息；压缩完成后才落库（重试时已在库里，saveUser 为 false）
  refs?: TurnItem[]
  saveUser: boolean
}): Promise<void> {
  const { streamId, convId, model, emit, msgId, items, kbEnv, agent } = core
  const p = resolveModelRef(model)
  if (!p || !p.apiKey || !p.enabled) {
    saveAssistantTurn(convId, msgId, { content: '', items: [], status: 'done', endReason: 'error' })
    emit({
      type: 'turn-done',
      streamId,
      endReason: 'error',
      status: 'error',
      error: p ? '该模型所属的服务商未启用或未配置密钥' : '模型无法定位，请重新选择'
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
    persistRunning()
  }
  const finish = (
    endReason?: EndReason,
    error?: string,
    usage?: TurnUsage,
    context?: ContextUsage
  ): void => {
    // 模型可能发出空的 text/reasoning 段（如开了个头就转去调工具），不落库
    const kept = items.filter((i) => (i.t !== 'text' && i.t !== 'reasoning') || i.text.trim())
    const content =
      [...kept].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
    saveAssistantTurn(convId, msgId, { content, items: kept, status: 'done', endReason, usage })
    // 占用拆分（018 Case 10）：标题里的总量用第一次请求的实测输入，随会话行存一份供重开会话时取
    if (context) {
      context.actualInput = usage?.steps?.[0]?.inputTokens ?? context.actualInput
      setConversationLastContext(convId, JSON.stringify(context))
    }
    emit({ type: 'turn-done', streamId, endReason, status: endReason ?? 'done', error, usage, context })
  }
  // 弹卡即落库 / 卡片回应后落库：等待中的快照（最终态由 finish 覆盖）
  const persistWaiting = (): void => {
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'waiting' })
  }
  // 016 三节：进行中快照。item 级节点（item-done / item-update）覆盖写，
  // 退出时丢的只是最后一段没写完的流式文字；item-delta 不写库
  const persistRunning = (): void => {
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'running' })
  }
  // 有调用必有结果：没拿到结果的调用按三级文案补齐——
  // 等卡/排队（已标未回应）→ 第一级；MCP 在途 → 第三级（是否生效未知）；本地在途 → 第二级。
  // 停止与出错两种收场共用（016 Case 14：出错也补，不留停在进行中的行）
  const settleUnfinished = (cause: '用户停止' | '出错中止'): void => {
    items.forEach((it, idx) => {
      if (it.t !== 'tool' || it.result !== undefined) return
      if (it.auth === 'pending') it.auth = 'unanswered' // execute 未及入队时兜底
      if (it.ask) {
        // 提问卡被打断：记「未回应」，收 PRD 提问卡收场文案
        it.ask = { state: 'unanswered' }
        it.result = { interrupted: ASK_INTERRUPTED }
      } else if (it.auth === 'unanswered') {
        it.result = { interrupted: INTERRUPT_NOT_STARTED }
        it.userText = USER_NOT_STARTED
      } else if (it.auth === 'approved') {
        it.result = { interrupted: interruptExternal(cause) }
        it.userText = USER_EXTERNAL
      } else {
        it.result = { interrupted: INTERRUPT_LOCAL }
        it.userText = USER_LOCAL
      }
      emit({ type: 'item-update', streamId, index: idx, item: it })
    })
  }
  // 空壳 running 行（016 Case 13）挪到用户消息落库之后再写（018 四节）：它的 created_at 只在首次写入时定，
  // 写早了会排在本轮用户消息前面
  markConvActive(convId)

  const controller = new AbortController()
  turns.set(streamId, controller)
  // roots 登记（015 T1）：本轮内 MCP 服务端反查 roots 时，返回本会话的授权目录清单（现查，
  // 轮内新授权的目录立即可见）；轮结束在 finally 注销
  setActiveRootsProvider(() => getConversationWs(convId) ?? [])

  // 轮内状态：检索计数与来源池（连续编号）；limitHit = 触接口级禁止（触边界强制作答）
  const toolCtx: TurnToolContext = {
    pool: [],
    poolByCall: new Map(),
    searches: 0,
    kbIds: kbEnv?.libraries.map((l) => l.id) ?? [],
    kbNames: new Map(kbEnv?.libraries.map((l) => [l.id, l.name]) ?? [])
  }
  // 016 Case 11：触顶后模型仍可发第 17 次调用，执行层拦截返回失败（模型与用户都看得到），
  // 再下一步才接口级禁止。边界行随之取消，信息在失败的调用行上
  const overLimit = { hit: false }
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
  // 转接调用的目标工具名（018 五节）：toolCallId → mcp__<id>__<name>，总量闸落库时用它记 tool_name
  const invokeNames = new Map<string, string>()

  // 工具组装：内置（询问用户、查结果集、生成制品常备，挂库时含检索）+ 缓存中已启用服务的 MCP 工具全量注册（只读缓存，不现场请求服务）。
  // 服务范围 = 会话自加的 ∪ Agent 挂的（Agent 的服务已删/停用时不在缓存里，自然跳过——Case 5 降级）
  const mcpSelection = new Set([
    ...getConversationMcpSelection(convId),
    ...(agent?.mcpSel ?? []).map((e) => e.id)
  ])

  // 系统提示词会话定格（018 三节）：第一轮拼一次存进会话行，此后每轮原样读出。
  // 中途改 Agent 提示词、库的增删、服务连断、跨天，都不回改它——变了的事走消息序列里的提醒消息。
  // 会话授权目录清单进环境信息（015 Case 2）：定格块已跑过，此处非 NULL
  let system = getConversationSystemPrompt(convId)
  if (system === null) {
    system = buildSystemPrompt({
      agent: agent ? { name: agent.name, sections: agent.promptSections } : null,
      kbLibraries: (kbEnv?.libraries ?? []).map((l) => ({ name: l.name, intro: l.intro })),
      wsDirs: getConversationWs(convId) ?? [],
      mcpInstructions: getMcpInstructions(mcpSelection)
    })
    setConversationSystemPrompt(convId, system)
  }

  // 会话引导（018 四节）：没有会话背景消息的会话（新会话，或改动前创建的）补两行——
  // 会话背景消息装当天日期，技能清单消息装本会话的技能范围（通用会话取本地全部，Agent 会话取配置的），
  // 排在全部消息之前。生成之后内容固定，跨天与技能库变动都走追加消息
  const skillLib = new Map(listSkills().map((s) => [s.name, s.description]))
  const skillEntries = (names: string[]): SkillEntry[] =>
    names.filter((n) => skillLib.has(n)).map((n) => ({ name: n, description: skillLib.get(n)! }))
  const hadUserContext = hasUserContext(convId)
  if (!hadUserContext) {
    const first = firstMessageAt(convId)
    const at = first === null ? Date.now() : first - 2
    const today = todayText()
    const uc = buildUserContext(today)
    insertReminder(convId, 'user_context', uc, { date: dateKey(today) }, at)
    emit({ type: 'context-note', streamId, kind: 'user_context', text: uc })
    const initial = skillEntries(agent ? agent.skillSel : [...skillLib.keys()])
    if (initial.length) {
      const sl = buildSkillListing(initial)
      insertReminder(convId, 'skill_listing', sl, { skills: initial.map((s) => s.name) }, at + 1)
      emit({ type: 'context-note', streamId, kind: 'skill_listing', text: sl })
    }
  }
  // 常驻还是延迟（018 五节，验收修订）：会话第一轮按门槛判一次记进会话行，中途点名的服务一律延迟。
  // 常驻服务的定义每轮从缓存的工具清单重建挂进 tools 数组；延迟服务的进本会话的查询表，只增不减
  const residentIds = decideResidentServices(convId, mcpSelection, model, hadUserContext)
  const resident = entriesOf([...mcpSelection].filter((id) => residentIds.has(id)))
  const deferred = ensureDeferredTable(convId, [...mcpSelection].filter((id) => !residentIds.has(id)))
  // 追加消息（018 四节）：这一刻算出本轮有哪些变化要告知模型，先放内存，压缩完再落库。
  // 次序固定：日期已变更 → 技能清单新增 → 用户新增了服务 → 工具名清单。
  // 工具名清单照 Claude Code 的 deferred_tools_delta：查询表里有、还没播报过名字的服务，把它们的工具名发一次——
  // 新会话第一轮就是全量，中途点名新服务就是那一个服务的。重试时这几条上一次已落库，不再生成
  const slashName = core.slashSkill && skillLib.has(core.slashSkill) ? core.slashSkill : null
  const scope = skillScope(convId)
  const pendingRows: { kind: ReminderKind; content: string; items: Record<string, unknown> | null }[] =
    []
  if (core.saveUser) {
    const today = todayText()
    if (toldDate(convId) !== dateKey(today))
      pendingRows.push({
        kind: 'date_change',
        content: buildDateChange(today),
        items: { date: dateKey(today) }
      })
    if (slashName && !scope.includes(slashName))
      pendingRows.push({
        kind: 'skill_added',
        content: buildSkillAdded(skillEntries([slashName])),
        items: { skills: [slashName] }
      })
    // 服务说明的追加消息只给中途才进会话的服务：会话开始就有的服务，说明已在系统提示词的已连接服务说明段里。
    // 第一轮（还没有会话背景消息）点名的服务同样算会话开始就有的；之后点名的，看它的工具名播报过没有
    const named = core.slashMcp !== undefined ? getMcpService(core.slashMcp) : null
    const announcedBefore = toolsAnnounced(convId)
    if (named && hadUserContext && !announcedBefore.has(named.id) && !mcpAnnounced(convId, named.id)) {
      const instr = getMcpInstructions(new Set([named.id]))[0]?.instructions ?? ''
      pendingRows.push({
        kind: 'mcp_added',
        content: buildMcpAdded(named.name, instr),
        items: { serviceId: named.id }
      })
    }
    const announced = announcedBefore
    const fresh = [...resident, ...deferred].filter((e) => !announced.has(e.serviceId))
    if (fresh.length) {
      const groups = new Map<number, { serviceName: string; names: string[]; resident: boolean }>()
      for (const e of fresh) {
        const g = groups.get(e.serviceId) ?? {
          serviceName: e.serviceName,
          names: [],
          resident: residentIds.has(e.serviceId)
        }
        g.names.push(e.key)
        groups.set(e.serviceId, g)
      }
      pendingRows.push({
        kind: 'tool_listing',
        content: buildToolListing([...groups.values()]),
        items: { serviceIds: [...groups.keys()] }
      })
    }
  }

  // 工具清单（018 Case 2）：十二个内置工具无条件挂载、顺序固定，tools 数组在所有会话完全一致。
  // MCP 工具不进清单：定义存进本会话的查询表，模型用 tool_search 找回、tool_invoke 转接调用。
  // history 在下方组装后才赋值，激活工具经 getHistory 延迟取（执行必在流式循环内，晚于赋值）
  let history: ModelMessage[] = []
  // 历史还原：延迟服务的调用还原成转接（给出查询表里的名字），常驻服务的照原名（返回 null）
  const keyOf = (fullName: string): string | null => {
    const m = /^mcp__(\d+)__/.exec(fullName)
    if (m && residentIds.has(Number(m[1]))) return null
    return deferred.find((e) => e.fullName === fullName)?.key ?? bareName(fullName)
  }
  // 转接调用要弹授权卡时先把调用行置 pending（渲染层靠它弹卡、禁用输入框）；行还没建时记下来，建行时补
  const invokePending = new Set<string>()
  const onInvokeAuth = (toolCallId: string): void => {
    invokePending.add(toolCallId)
    const idx = toolItemIndex.get(toolCallId)
    if (idx === undefined) return
    const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
    if (item.auth) return
    item.auth = 'pending'
    persistWaiting()
    emit({ type: 'item-update', streamId, index: idx, item })
  }
  // 技能：可激活范围 = 本会话的技能范围（会话开始定格、点名清单外的技能时追加，018 Case 6）∪ 本轮点名
  const activeSkillNames = [...new Set([...scope, ...(slashName ? [slashName] : [])])]
  const turnTools: Record<string, Tool> = assembleTurnTools({
    convId,
    signal: controller.signal,
    cards,
    overflow,
    onFsCard,
    toolCtx,
    skillNames: activeSkillNames,
    getHistory: () => history,
    onArtifact: (toolCallId, info) => artifacts.set(toolCallId, info),
    deferred,
    resident,
    onInvokeAuth
  })
  // 结果清单里的展示名（七节）：内置工具查登记表，MCP 工具查常驻条目与查询表
  const displayOf = (toolName: string): string =>
    builtinDisplay(toolName) ??
    (() => {
      const e = resident.find((x) => x.fullName === toolName) ?? deferred.find((x) => x.fullName === toolName)
      return e ? e.title || `${e.serviceName}:${bareName(e.fullName)}` : toolName
    })()

  // 两份文案的旁路（016 六节）：工具错误结果里的 userText 是给用户看的那句，
  // 在进 SDK 之前剥下来存这里——execute 返回值会原样发给模型，userText 不进模型。
  // tool-result 到达消费循环时按 callId 取回，挂到 item.userText
  const userTexts = new Map<string, string>()
  for (const [name, t] of Object.entries(turnTools)) {
    const orig = t.execute
    if (!orig) continue
    turnTools[name] = {
      ...t,
      execute: async (args, options) => {
        if (overLimit.hit) {
          // 016 Case 11：第 17 次调用不执行，返回失败结果；下一步起接口级禁止
          userTexts.set(options.toolCallId, '已达调用上限')
          return {
            error: `已达工具调用上限（${TOOL_ROUND_HARD_LIMIT} 轮），这次调用未执行。请立即基于已获得的信息回答用户`
          }
        }
        const out = (await orig(args, options)) as unknown
        if (out && typeof out === 'object' && 'userText' in out) {
          const { userText, ...rest } = out as { userText: string } & Record<string, unknown>
          if (userText) userTexts.set(options.toolCallId, userText)
          return rest
        }
        return out
      }
    } as Tool
  }

  // 触发线（018 二节）：窗口 − 压缩预留。估算 = 工具清单 + 系统提示词 + 消息序列，各乘该模型的校准比值。
  // 工具清单改动前不进估算，它占单次请求的四成上下
  const line = triggerLine(model)
  // 工具清单的估算拆两份：十二个内置工具归「内置工具」，常驻 MCP 工具的定义归「MCP 工具」（与工具名清单同类）
  const toolsTok = applyRatio(model, toolsTokens(turnTools))
  const residentTok = resident.length ? definitionsTokens(model, resident) : 0
  // 历史里的 MCP 调用按查询表里的名字还原成 tool_invoke 转接（018 五节）
  let bundle = loadHistoryMessages(convId, keyOf)
  history = bundle.messages
  const sizeOf = (m: ModelMessage): number =>
    estimateTokens(model, typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  // 本轮还没落库的追加消息与用户消息也进估算（它们马上要跟在历史后面发出去）
  let pendingTexts = [...pendingRows.map((r) => r.content), ...(core.saveUser ? [core.text] : [])]
  const estimateOf = (h: ModelMessage[]): number =>
    toolsTok +
    estimateTokens(model, system) +
    h.reduce((s, m) => s + sizeOf(m), 0) +
    pendingTexts.reduce((s, t) => s + estimateTokens(model, t), 0)
  const estimate = (): number => estimateOf(history)

  const provider = createOpenAICompatible({
    name: 'chime',
    baseURL: p.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: p.apiKey,
    includeUsage: true,
    fetch: loggingFetch()
  })
  // 附加参数（PRD Case 6）：某家独有的非标准开关随每次请求发出，靠配置不靠改代码
  const extraBody = Object.keys(p.extraParams).length ? p.extraParams : undefined

  // 压缩三级（018 七节）：一级清旧的工具返回换成结果编号，二级请模型写摘要并重建，三级整对丢弃。
  // 逻辑在 compact.ts，这里只接结果：压缩后的历史、要不要画分界线、摘要请求被用户停止时按停止收场
  const outcome = await compactIfNeeded({
    onLevel2: () => startItem('compaction', { t: 'compaction' }),
    convId,
    lm: provider(p.model),
    system,
    tools: turnTools,
    history,
    bundle,
    estimateOf,
    line,
    signal: controller.signal,
    skillEntries: skillEntries(scope),
    displayOf,
    keyOf,
    deferred,
    resident,
    residentIds,
    retry: !core.saveUser
  })
  // 压缩调用行收尾（018 Case 9）：一级清完仍超线才有这一行；按走到哪一级填结果，渲染层据此换动词与描述
  const compRow = items.find((i): i is Extract<TurnItem, { t: 'compaction' }> => i.t === 'compaction')
  if (compRow) {
    if (outcome.aborted) compRow.outcome = 'aborted'
    else if (outcome.summarized) compRow.outcome = outcome.dropped ? 'ok_dropped' : 'ok'
    else compRow.outcome = outcome.reason?.includes('停用') ? 'disabled' : 'failed'
    if (outcome.savedTokens) compRow.savedTokens = outcome.savedTokens
    if (outcome.reason) compRow.reason = outcome.reason
    emit({ type: 'item-done', streamId, index: items.indexOf(compRow), item: compRow })
  }
  const bundleBefore = bundle
  history = outcome.history
  bundle = outcome.bundle
  // 本轮的行现在才写（018 四节）：追加消息在前、用户消息在后，都排在压缩重建的行之后；
  // 写完追加到内存里的 history 末尾，再写空壳 running 行（016 Case 13）。重试时这几行已在库里，只写空壳
  if (core.saveUser) {
    // 这一轮同时点名了新服务又触发了压缩时，重建已经把全量工具名清单写进去了，本轮那条增量不再写
    if (outcome.dropped || outcome.bundle !== bundleBefore) {
      const done = toolsAnnounced(convId)
      const i = pendingRows.findIndex((r) => r.kind === 'tool_listing')
      if (i >= 0) {
        const ids = (pendingRows[i].items?.serviceIds as number[]) ?? []
        if (ids.every((id) => done.has(id))) pendingRows.splice(i, 1)
      }
    }
    for (const r of pendingRows) {
      insertReminder(convId, r.kind, r.content, r.items)
      emit({ type: 'context-note', streamId, kind: r.kind, text: r.content })
    }
    saveUserMessage(convId, core.text, core.refs)
    history = [
      ...history,
      ...pendingRows.map((r): ModelMessage => ({ role: 'user', content: r.content })),
      { role: 'user', content: expandUserMessage(core.text, core.refs) }
    ]
    pendingTexts = []
  }
  persistRunning()
  if (outcome.aborted) {
    // 摘要请求期间用户点了停止：用户消息照常落库（界面上已显示），本轮按停止收场，不计入摘要失败
    finish('stopped')
    return
  }
  const estimatedInput = estimate()
  // 占用拆分（018 Case 10）：技能类 = 技能清单、技能新增、重建的技能正文这几种提醒行，加激活技能工具的返回；
  // 对话 = 消息序列其余全部。延迟加载的工具定义按查询表里的名字、说明、参数估
  const skillKinds = new Set(['skill_listing', 'skill_added', 'skill_bodies'])
  const skillMsgIdx = new Set(
    bundle.reminders.filter((r) => skillKinds.has(r.kind)).map((r) => r.msgIdx)
  )
  // 工具名清单消息计入「MCP 工具」分类，不算进对话
  const mcpMsgIdx = new Set(
    bundle.reminders.filter((r) => r.kind === 'tool_listing').map((r) => r.msgIdx)
  )
  let skillTok = 0
  let mcpTok = 0
  const perSkill = new Map<string, number>(activeSkillNames.map((n) => [n, 0]))
  history.forEach((m, i) => {
    if (skillMsgIdx.has(i)) {
      skillTok += sizeOf(m)
      return
    }
    if (mcpMsgIdx.has(i)) {
      mcpTok += sizeOf(m)
      return
    }
    if ((m as { role: string }).role !== 'tool' || !Array.isArray(m.content)) return
    for (const part of m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]) {
      if (part.type !== 'tool-result' || part.toolName !== 'activate_skill') continue
      if (typeof part.output?.value !== 'string') continue
      const t = estimateTokens(model, part.output.value)
      skillTok += t
      const mm = /^【技能：(.+?)】/.exec(part.output.value)
      if (mm) perSkill.set(mm[1], (perSkill.get(mm[1]) ?? 0) + t)
    }
  })
  const byService = new Map<string, { count: number; tokens: number }>()
  let deferredTok = 0
  for (const e of deferred) {
    const t = applyRatio(
      model,
      estimateTokensBase(
        JSON.stringify({ name: e.key, description: e.description, parameters: e.inputSchema })
      )
    )
    deferredTok += t
    const s = byService.get(e.serviceName) ?? { count: 0, tokens: 0 }
    byService.set(e.serviceName, { count: s.count + 1, tokens: s.tokens + t })
  }
  const ctxUsage: ContextUsage = {
    window: contextWindow(model),
    actualInput: null,
    builtinTools: Math.max(0, toolsTok - residentTok),
    mcpTools: mcpTok + residentTok,
    systemPrompt: estimateTokens(model, system),
    skills: skillTok,
    messages: Math.max(0, history.reduce((s, m) => s + sizeOf(m), 0) - skillTok - mcpTok),
    deferred: {
      tokens: deferredTok,
      count: deferred.length,
      byService: [...byService].map(([name, v]) => ({ name, ...v }))
    },
    skillItems: [...perSkill].map(([name, tokens]) => ({ name, tokens }))
  }

  // 停止时的用量（016 Case 14）：onAbort 交回已完成的各步，逐步加总。
  // 一步都没完成时保持 undefined——页脚按「拿不到不显示」走，不显示 0。
  // 等授权中停止走异常路径、onAbort 不触发（验收实测），收场时再从 steps 兜取一次
  type StepUsage = {
    usage: {
      inputTokens?: number
      outputTokens?: number
      inputTokenDetails?: { cacheReadTokens?: number }
    }
  }
  const stepOf = (st: StepUsage): StepUsageRecord => ({
    inputTokens: st.usage.inputTokens ?? 0,
    outputTokens: st.usage.outputTokens ?? 0,
    cachedInputTokens: st.usage.inputTokenDetails?.cacheReadTokens ?? 0
  })
  // 各次请求的用量按顺序记全（018 一节），合计从它们加出来
  const usageOf = (steps: readonly StepUsageRecord[]): TurnUsage | undefined => {
    if (!steps.length) return undefined
    return {
      inputTokens: steps.reduce((s, st) => s + st.inputTokens, 0),
      outputTokens: steps.reduce((s, st) => s + st.outputTokens, 0),
      cachedInputTokens: steps.reduce((s, st) => s + st.cachedInputTokens, 0),
      steps: [...steps]
    }
  }
  const sumSteps = (steps: readonly StepUsage[]): TurnUsage | undefined =>
    usageOf(steps.map(stepOf))
  let abortedUsage: TurnUsage | undefined
  let stepsPromise: Promise<readonly StepUsage[]> | null = null
  // finish-step 逐次记录（首选来源）：LLM 请求一结束就有该次 usage，不等这一步的工具跑完。
  // 并行调用等授权时停止，onAbort 与 steps 都是空的，只有这里有数
  const streamed: StepUsageRecord[] = []
  let stepNo = 0 // 本轮第几次模型请求（从 0 起），挂到该请求发出的调用上
  const stoppedUsage = async (): Promise<TurnUsage | undefined> => {
    if (streamed.length) return usageOf(streamed)
    if (abortedUsage) return abortedUsage
    const st = stepsPromise ? await stepsPromise.catch(() => []) : []
    return sumSteps(st)
  }
  try {
    const result = streamText({
      model: provider(p.model),
      providerOptions: extraBody ? ({ chime: extraBody } as never) : undefined,
      instructions: system,
      messages: history,
      abortSignal: controller.signal,
      onAbort: ({ steps }) => {
        abortedUsage = sumSteps(steps as readonly StepUsage[])
      },
      tools: Object.keys(turnTools).length ? turnTools : undefined,
      // 三件事（07-13 修订：计轮 + 触顶告知，原为触顶静默摘工具清单——模型不知情会把调用吐进正文）：
      // 接口级禁止（含工具调用的轮数触顶后保留清单但禁止选择 + 注入收尾指令，模型只能作答）+
      // 额度过半预警（goose 同款，注入轻提示让模型收敛探索）+
      // 总量闸（上一步结果集齐、交给模型之前统一判定——批内从大到小落库改摘要，已给过的不回头改）
      prepareStep: ({ steps, messages }) => {
        const rounds = steps.filter((st) => st.toolCalls.length > 0).length
        // 触顶（rounds 达 16）：这一步放行、执行层拦截；再下一步（>16）接口级禁止
        if (rounds >= TOOL_ROUND_HARD_LIMIT) overLimit.hit = true
        const hardLimit = rounds > TOOL_ROUND_HARD_LIMIT

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
                !NON_DATA_TOOLS.has(tr.toolName) && // 非数据工具的返回不落库（018 五节）
                !overflow.refs.has(tr.toolCallId) // 单结果闸已处理的不重复
            )
            .map((tr) => ({
              toolCallId: tr.toolCallId,
              // 转接调用落库时记真正的 MCP 工具名，结果清单的展示名靠它查（018 五节）
              toolName: invokeNames.get(tr.toolCallId) ?? tr.toolName,
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
              persistRunning() // 摘要替换是批量 item-update，收口写一次
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

    stepsPromise = result.steps as unknown as Promise<readonly StepUsage[]>
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
        case 'tool-input-start': {
          // 016 Case 6：参数开始生成就出调用行，不等参数齐。初始化只依赖 toolName，全在这里做；
          // 需授权/提问的调用初始为 pending（排队/弹卡由渲染层从 items 推导）。
          // 转接调用（018 五节）此时还不知道目标工具，先按 tool_invoke 建行，tool-call 时改写
          const isAsk = part.toolName === ASK_TOOL_NAME
          const fsEarly = earlyFsCard.get(part.id) // 文件工具的申请授权卡先于本事件挂载时
          startItem('tool', {
            t: 'tool',
            name: part.toolName,
            id: part.id, // 与后续 tool-call 的 toolCallId 同值
            step: stepNo,
            display: builtinDisplay(part.toolName),
            auth:
              invokePending.has(part.id) || fsEarly
                ? (earlyAuth.get(part.id) ?? 'pending')
                : undefined,
            fsCard: fsEarly,
            ask: isAsk ? (earlyAsk.get(part.id) ?? { state: 'pending' }) : undefined,
            inputStreaming: true,
            args: {}
          })
          toolItemIndex.set(part.id, cur)
          const it = items[cur] as Extract<TurnItem, { t: 'tool' }>
          if (it.auth === 'pending' || it.ask?.state === 'pending') persistWaiting() // 弹卡即落库
          break
        }
        case 'tool-call': {
          // 参数已齐。行在 tool-input-start 已建就补齐 args；没建过（SDK 修复调用等路径
          // 单发 tool-call）就整行新建，兜底与旧行为一致。
          // 转接调用（018 五节）：input.name 在查询表里就把这一行改写成目标工具——name 记 mcp__<id>__<name>、
          // args 记真正的参数、display 用工具的展示名。item-done 带出的名字与改动前一致，Tuner 断言与渲染层都不用改
          const isAsk = part.toolName === ASK_TOOL_NAME
          const fsEarly = earlyFsCard.get(part.toolCallId)
          const rawInput = (part.input ?? {}) as Record<string, unknown>
          const entry =
            part.toolName === TOOL_INVOKE_NAME
              ? deferred.find((e) => e.key === rawInput.name)
              : undefined
          const shown = entry
            ? {
                name: entry.fullName,
                args: (rawInput.arguments && typeof rawInput.arguments === 'object'
                  ? rawInput.arguments
                  : {}) as Record<string, unknown>,
                display: entry.title || `${entry.serviceName}:${bareName(entry.fullName)}`,
                desc: entry.description
              }
            : { name: part.toolName, args: rawInput, display: builtinDisplay(part.toolName), desc: undefined }
          if (entry) invokeNames.set(part.toolCallId, entry.fullName)
          const existing = toolItemIndex.get(part.toolCallId)
          if (existing !== undefined && items[existing]?.t === 'tool') {
            const it = items[existing] as Extract<TurnItem, { t: 'tool' }>
            delete it.inputStreaming
            it.name = shown.name
            it.args = shown.args
            it.display = shown.display
            if (shown.desc) it.desc = shown.desc
            // 参数期间可能有 early* 补挂到来，取最新
            if (fsEarly) it.fsCard = fsEarly
            const lateAuth = earlyAuth.get(part.toolCallId)
            if (lateAuth) it.auth = lateAuth
            else if (invokePending.has(part.toolCallId) && !it.auth) it.auth = 'pending'
            const lateAsk = earlyAsk.get(part.toolCallId)
            if (lateAsk) it.ask = lateAsk
            emit({ type: 'item-update', streamId, index: existing, item: it })
          } else {
            startItem('tool', {
              t: 'tool',
              name: shown.name,
              id: part.toolCallId,
              step: stepNo,
              display: shown.display,
              desc: shown.desc,
              auth:
                invokePending.has(part.toolCallId) || fsEarly
                  ? (earlyAuth.get(part.toolCallId) ?? 'pending')
                  : undefined,
              fsCard: fsEarly,
              ask: isAsk ? (earlyAsk.get(part.toolCallId) ?? { state: 'pending' }) : undefined,
              args: shown.args
            })
            toolItemIndex.set(part.toolCallId, cur)
          }
          // 执行耗时从参数齐了才起算，参数生成时间不算进 ms
          toolStartAt.set(part.toolCallId, Date.now())
          const idx = toolItemIndex.get(part.toolCallId)!
          const it = items[idx] as Extract<TurnItem, { t: 'tool' }>
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
            persistRunning()
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
          // 检索的完整来源条目随 item 落库（018 Case 7）：来源清单按整个会话查编号
          const pool = toolCtx.poolByCall.get(part.toolCallId)
          if (pool?.length) item.pool = pool
          const userText = userTexts.get(part.toolCallId)
          if (userText) item.userText = userText // 给用户的失败说明（016 六节）
          const ref = overflow.refs.get(part.toolCallId)
          if (ref !== undefined) item.resultRef = ref
          item.ms = Date.now() - (toolStartAt.get(part.toolCallId) ?? Date.now())
          emit({ type: 'item-done', streamId, index: idx, item })
          persistRunning()
          break
        }
        case 'finish-step':
          streamed.push(stepOf(part))
          stepNo++
          break
        case 'error':
          throw part.error
      }
    }

    // 来源结算：流式结束后扫描回答里的资料编号 [a3f2-1]，在整个会话的来源池里反查（018 Case 7：
    // 追问时引用前几轮的资料也能列出来源）；找不到的编号正文照原样显示、清单里不列；无编号则无来源区
    const answer = [...items]
      .reverse()
      .find((i): i is { t: 'text'; text: string } => i.t === 'text')
    if (answer) {
      const cited = new Set([...answer.text.matchAll(/\[([0-9a-f]{4}-\d+)\]/g)].map((m) => m[1]))
      if (cited.size) {
        const seen = new Set<string>()
        const list = [...toolCtx.pool, ...loadSessionPool(convId)].filter((s) => {
          if (!cited.has(s.n) || seen.has(s.n)) return false
          seen.add(s.n)
          return true
        })
        if (list.length) {
          startItem('sources', { t: 'sources', list })
          endItem()
        }
      }
    }

    // abort 后 fullStream 不抛错、正常关闭；已有完成步时 result.usage 也能解析出值，
    // 不拦这一道会把停止轮当成正常完成收场（016 评审验出）。
    // 停止收场：已流出内容保留，用量取 onAbort 收到的已完成各步合计
    if (controller.signal.aborted) {
      settleUnfinished('用户停止')
      finish('stopped', undefined, await stoppedUsage(), ctxUsage)
      return
    }

    const usage = await result.usage
    const input = usage.inputTokens ?? 0
    // 校准用首次请求的实测（018 二节）：估算的是轮初那一次组装，与它配对的是第一次请求
    recordUsage(model, estimatedInput, streamed[0]?.inputTokens ?? 0)
    markVendorHealth(p.vendor, true)
    finish(
      undefined, // 正常完成：无结束原因
      undefined,
      {
        inputTokens: input,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        // 分步从流里取：result.usage 是全部步骤的合计（AI SDK 文档），没有分步
        steps: [...streamed]
      },
      ctxUsage
    )
  } catch (e) {
    if (controller.signal.aborted) {
      // 等授权中停止、一步没完成的停止都从这里进
      settleUnfinished('用户停止')
      finish('stopped', undefined, await stoppedUsage(), ctxUsage)
    } else {
      const msg = humanizeError(e)
      // 鉴权 / 服务端错误 → 标记该服务商异常（控件警示 + 前往设置），下次成功或检测通过后解除
      const sc = (e as SdkError).statusCode
      if (sc && (sc === 401 || sc === 403 || sc >= 500)) markVendorHealth(p.vendor, false, msg)
      // 出错也补齐未完成的调用（016 Case 14 功能点 4），不留停在进行中的行
      settleUnfinished('出错中止')
      items.push({ t: 'boundary', kind: 'error', text: msg })
      finish('error', msg, undefined, ctxUsage)
    }
  } finally {
    setActiveRootsProvider(null)
    cards.dispose()
    turns.delete(streamId)
    unmarkConvActive(convId)
  }
}
