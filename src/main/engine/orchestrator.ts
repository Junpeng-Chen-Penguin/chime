// 编排引擎：一轮 = 组装上下文 → streamText 多步循环 → 类型化事件流。
// 三个消费方共用事件（界面渲染 / 无界面 JSONL 输出），落库节点化：弹卡时 / 卡片回应后 / 轮终结（同一行 UPSERT）。
// 本文件不依赖 BrowserWindow，界面与能力分离。
// 重启后的等待卡不续跑：启动修复把卡作废（repairConversation），用户直接说、模型重新发起（PRD 定稿修订）。

import { streamText, isStepCount } from 'ai'
import type { ModelMessage, Tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { randomUUID } from 'crypto'
import { getProvider, getConversationKb, getKb, kbStats } from '../db'
import { EMBED_MODEL_ID } from '../model'
import { humanize } from '../ai'
import { buildSystemPrompt, type KbEnv } from './prompts'
import { budgetFor, estimateTokens, recordUsage } from './budget'
import {
  makeSearchTool,
  makeMcpTools,
  makeAskTool,
  makeGrepResultTool,
  makeReadResultTool,
  makeArtifactTool,
  ASK_TOOL_NAME,
  ASK_TOOL_DISPLAY,
  GREP_TOOL_NAME,
  GREP_TOOL_DISPLAY,
  READ_TOOL_NAME,
  READ_TOOL_DISPLAY,
  ARTIFACT_TOOL_NAME,
  ARTIFACT_TOOL_DISPLAY,
  TOOL_ROUND_HARD_LIMIT,
  STEP_COUNT_LIMIT,
  type TurnToolContext
} from './tools'
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
import { unavailableMcpServiceNames } from '../mcp/client'
import { saveUserMessage, saveAssistantTurn, loadHistoryMessages, type TurnItem, type TurnStatus } from './store'

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
function deriveKbEnv(convId: string, notice?: (text: string) => void): KbEnv | null {
  if (!getConversationKb(convId)) return null
  const kb = getKb()
  if (!kb.rootPath) return null // 库已被移除：按无知识库组装
  if (kb.embedModel && kb.embedModel !== EMBED_MODEL_ID) {
    notice?.('本地模型已更换，知识库需重建后才能检索；本轮按无知识库回答')
    return null
  }
  return { name: kb.name, intro: kb.intro, docCount: kbStats().files }
}

export async function runTurn(opts: {
  streamId: string
  convId: string
  text: string
  model: string
  emit: Emit
  saveUser?: boolean // 重试时为 false：用户消息已在库里，不重复写
}): Promise<void> {
  try {
    await runTurnBody(opts)
  } catch (e) {
    // 兜底收场：组装 / 落库等未预期异常也必须发 turn-done，否则渲染端路由不清空、输入框永久锁死
    console.error('[chime] runTurn 未预期异常:', e)
    opts.emit({ type: 'turn-done', streamId: opts.streamId, status: 'error', error: '处理出错，请重试', contextRatio: 0 })
  }
}

async function runTurnBody(opts: Parameters<typeof runTurn>[0]): Promise<void> {
  const { streamId, convId, text, model, emit } = opts
  const p = getProvider()

  if (opts.saveUser !== false) saveUserMessage(convId, text)
  emit({ type: 'turn-start', streamId })

  const msgId = randomUUID()
  if (!p.apiKey) {
    const items: TurnItem[] = [{ t: 'boundary', kind: 'error', text: '请先在设置里配置 API 密钥' }]
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'error' })
    emit({ type: 'turn-done', streamId, status: 'error', error: '请先在设置里配置 API 密钥', contextRatio: 0 })
    return
  }

  const kbEnv = deriveKbEnv(convId, (t) => emit({ type: 'notice', streamId, text: t }))
  await streamCore({
    streamId,
    convId,
    model,
    emit,
    msgId,
    items: [],
    history: loadHistoryMessages(convId),
    kbEnv
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
  history: ModelMessage[]
  kbEnv: KbEnv | null
}): Promise<void> {
  const { streamId, convId, model, emit, msgId, items, kbEnv } = core
  const p = getProvider()

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
    emit({ type: 'item-done', streamId, index: cur, item: items[cur] })
  }
  const finish = (status: TurnStatus, error?: string, usage?: { inputTokens: number; outputTokens: number }, contextRatio = 0): void => {
    // 模型可能发出空的 text/reasoning 段（如开了个头就转去调工具），不落库
    const kept = items.filter((i) => (i.t !== 'text' && i.t !== 'reasoning') || i.text.trim())
    const content = [...kept].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
    saveAssistantTurn(convId, msgId, { content, items: kept, status })
    emit({ type: 'turn-done', streamId, status, error, usage, contextRatio })
  }
  // 弹卡即落库 / 卡片回应后落库：等待中的快照（最终态由 finish 覆盖）
  const persistWaiting = (): void => {
    saveAssistantTurn(convId, msgId, { content: '', items, status: 'waiting' })
  }

  const controller = new AbortController()
  turns.set(streamId, controller)

  // 轮内状态：检索计数与来源池（连续编号）；limitHit = 触接口级禁止（触边界强制作答）
  const toolCtx: TurnToolContext = { pool: [], searches: 0 }
  let limitHit = false
  const toolItemIndex = new Map<string, number>() // toolCallId → items 下标
  const toolStartAt = new Map<string, number>()
  const lateSummaries = new Map<string, string>() // 总量闸先于 tool-result 事件时的暂存（toolCallId → 摘要）

  // 卡片队列（授权卡 + 提问卡共用）：用户回应回来时更新对应 tool item 状态、落库并推送。
  // 回应可能先于 tool-call 事件到达消费循环（自测钩子同步回应），先记下、建行时补上
  const earlyAuth = new Map<string, 'approved' | 'denied' | 'unanswered'>()
  const earlyAsk = new Map<string, Extract<TurnItem, { t: 'tool' }>['ask']>()
  const authOf = (d: CardDecision): 'approved' | 'denied' | 'unanswered' =>
    d === 'aborted' ? 'unanswered' : d
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

  // 超限处理轮内状态：会话基线一次算好，本轮增量随批累计
  const overflow: OverflowCtx = { convId, refs: new Map(), turnFullChars: 0 }
  const sessionBase = sessionFullResultChars(convId)
  const gatedSteps = new Set<number>() // 总量闸按步只跑一次

  // 制品：成功的生成调用不出工具步骤行，tool-result 时把该 item 换成制品卡（成果即过程）
  const artifacts = new Map<string, { id: number; title: string; rowCount: number }>()

  // 工具组装：内置（询问用户、查结果集、生成制品常备，挂库时含检索）+ 缓存中已启用服务的 MCP 工具全量注册（只读缓存，不现场请求服务）
  const mcp = makeMcpTools(controller.signal, cards, overflow)
  const turnTools: Record<string, Tool> = { ...mcp.tools }
  turnTools[ASK_TOOL_NAME] = makeAskTool(controller.signal, cards)
  turnTools[GREP_TOOL_NAME] = makeGrepResultTool(convId)
  turnTools[READ_TOOL_NAME] = makeReadResultTool(convId)
  turnTools[ARTIFACT_TOOL_NAME] = makeArtifactTool(convId, (toolCallId, info) => artifacts.set(toolCallId, info))
  if (kbEnv) turnTools.search_knowledge_base = makeSearchTool(toolCtx)
  // 已启用但连不上的服务：提示一句，本轮按无该服务工具继续，不阻断对话
  const down = unavailableMcpServiceNames()
  if (down.length) {
    emit({ type: 'notice', streamId, text: `服务暂时不可用：${down.join('、')}；本轮按无该服务工具继续` })
  }

  // 组装：系统提示词（固定主干 +（带工具）输出约定 +（挂库）条件段 + 环境信息）+ 消息序列
  const system = buildSystemPrompt(kbEnv, Object.keys(turnTools).length > 0)
  const budget = budgetFor(model)
  let history = core.history
  const sizeOf = (m: ModelMessage): number =>
    estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
  const estimate = (): number => estimateTokens(system) + history.reduce((s, m) => s + sizeOf(m), 0)
  // 规则 3：超预算从最旧成对丢弃，静默；始终保留本条用户消息
  while (history.length > 2 && estimate() > budget) history = history.slice(2)
  const estimatedInput = estimate()
  const contextRatio = Math.min(1, estimatedInput / budget)

  const provider = createOpenAICompatible({
    name: 'chime',
    baseURL: p.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: p.apiKey,
    includeUsage: true
  })

  try {
    const result = streamText({
      model: provider(model),
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
          const batch = (steps[lastIdx].toolResults as { toolCallId: string; toolName: string; output: unknown }[])
            .filter(
              (tr) =>
                typeof tr.output === 'string' &&
                tr.toolName !== GREP_TOOL_NAME &&
                tr.toolName !== READ_TOOL_NAME && // 豁免：取数工具取回的片段不再落库
                tr.toolName !== ASK_TOOL_NAME && // 用户的回答不是外部数据
                !overflow.refs.has(tr.toolCallId) // 单结果闸已处理的不重复
            )
            .map((tr) => ({ toolCallId: tr.toolCallId, toolName: tr.toolName, text: tr.output as string }))
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
          msgs = msgs.filter((m) => !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(BUDGET_NOTE_PREFIX)))
          msgs = [
            ...msgs,
            {
              role: 'user' as const,
              content: hardLimit
                ? `${BUDGET_NOTE_PREFIX}工具调用轮次已达上限，本轮不能再调用任何工具。请立即基于已获得的信息回答用户；信息不足则说明还缺什么，然后停止。）`
                : `${BUDGET_NOTE_PREFIX}工具调用额度已用 ${rounds}/${TOOL_ROUND_HARD_LIMIT} 轮。请减少探索、合并必要的调用、尽快基于已有信息收尾作答。）`
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
          startItem('tool', {
            t: 'tool',
            name: part.toolName,
            id: part.toolCallId,
            display: isAsk
              ? ASK_TOOL_DISPLAY
              : part.toolName === GREP_TOOL_NAME
                ? GREP_TOOL_DISPLAY
                : part.toolName === READ_TOOL_NAME
                  ? READ_TOOL_DISPLAY
                  : part.toolName === ARTIFACT_TOOL_NAME
                  ? ARTIFACT_TOOL_DISPLAY
                  : meta?.display,
            desc: meta?.needsAuth ? meta.desc : undefined,
            auth: meta?.needsAuth ? (earlyAuth.get(part.toolCallId) ?? 'pending') : undefined,
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
            items[idx] = { t: 'artifact', ...art }
            emit({ type: 'item-done', streamId, index: idx, item: items[idx] })
            break
          }
          const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
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
    const answer = [...items].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')
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
    finish('done', undefined, { inputTokens: input, outputTokens: usage.outputTokens ?? 0 }, contextRatio)
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
      items.push({ t: 'boundary', kind: 'error', text: msg })
      finish('error', msg, undefined, contextRatio)
    }
  } finally {
    cards.dispose()
    turns.delete(streamId)
  }
}
