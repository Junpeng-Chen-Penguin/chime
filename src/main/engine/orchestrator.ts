// 编排引擎：一轮 = 组装上下文 → streamText 多步循环 → 类型化事件流。
// 三个消费方共用事件（界面渲染 / 无界面 JSONL 输出），落库在轮次终结时一次完成。
// 本文件不依赖 BrowserWindow，界面与能力分离。

import { streamText, isStepCount } from 'ai'
import type { ModelMessage, Tool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getProvider, getConversationKb, getKb, kbStats } from '../db'
import { EMBED_MODEL_ID } from '../model'
import { humanize } from '../ai'
import { buildSystemPrompt, type KbEnv } from './prompts'
import { budgetFor, estimateTokens, recordUsage } from './budget'
import { makeSearchTool, makeMcpTools, TOOL_REQUEST_HARD_LIMIT, STEP_COUNT_LIMIT, type TurnToolContext } from './tools'
import { unavailableMcpServiceNames } from '../mcp/client'
import { saveUserMessage, saveAssistantTurn, loadHistoryMessages, type TurnItem, type TurnStatus } from './store'

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t']; item: TurnItem }
  | { type: 'item-delta'; streamId: string; index: number; text: string }
  | { type: 'item-done'; streamId: string; index: number; item: TurnItem }
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

export async function runTurn(opts: {
  streamId: string
  convId: string
  text: string
  model: string
  emit: Emit
  saveUser?: boolean // 重试时为 false：用户消息已在库里，不重复写
}): Promise<void> {
  const { streamId, convId, text, model, emit } = opts
  const p = getProvider()

  if (opts.saveUser !== false) saveUserMessage(convId, text)
  emit({ type: 'turn-start', streamId })

  const items: TurnItem[] = []
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
    saveAssistantTurn(convId, { content, items: kept, status })
    emit({ type: 'turn-done', streamId, status, error, usage, contextRatio })
  }

  if (!p.apiKey) {
    items.push({ t: 'boundary', kind: 'error', text: '请先在设置里配置 API 密钥' })
    finish('error', '请先在设置里配置 API 密钥')
    return
  }

  // 挂库判定在组装时：需重建（本地模型已更换）按无知识库组装并提示，「更新中」则正常挂、由工具返回 busy 语义
  let kbEnv: KbEnv | null = null
  if (getConversationKb(convId)) {
    const kb = getKb()
    if (!kb.rootPath) {
      // 库已被移除：按无知识库组装
    } else if (kb.embedModel && kb.embedModel !== EMBED_MODEL_ID) {
      emit({ type: 'notice', streamId, text: '本地模型已更换，知识库需重建后才能检索；本轮按无知识库回答' })
    } else {
      kbEnv = { name: kb.name, intro: kb.intro, docCount: kbStats().files }
    }
  }

  const controller = new AbortController()
  turns.set(streamId, controller)

  // 轮内状态：检索计数与来源池（连续编号）；limitHit = 触接口级禁止（触边界强制作答）
  const toolCtx: TurnToolContext = { pool: [], searches: 0 }
  let limitHit = false
  const toolItemIndex = new Map<string, number>() // toolCallId → items 下标
  const toolStartAt = new Map<string, number>()

  // 工具组装：内置（挂库时含检索）+ 缓存中已启用服务的 MCP 工具全量注册（只读缓存，不现场请求服务）
  const mcp = makeMcpTools(controller.signal)
  const turnTools: Record<string, Tool> = { ...mcp.tools }
  if (kbEnv) turnTools.search_knowledge_base = makeSearchTool(toolCtx)
  // 已启用但连不上的服务：提示一句，本轮按无该服务工具继续，不阻断对话
  const down = unavailableMcpServiceNames()
  if (down.length) {
    emit({ type: 'notice', streamId, text: `服务暂时不可用：${down.join('、')}；本轮按无该服务工具继续` })
  }

  // 组装：系统提示词（固定主干 +（带工具）输出约定 +（挂库）条件段 + 环境信息）+ 对话历史（含本条）
  const system = buildSystemPrompt(kbEnv, Object.keys(turnTools).length > 0)
  const budget = budgetFor(model)
  let history: ModelMessage[] = loadHistoryMessages(convId)
  const estimate = (): number =>
    estimateTokens(system) + history.reduce((s, m) => s + estimateTokens(String(m.content)), 0)
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
      // 接口级禁止（最硬）：请求总数（含被拒）触顶后不再下发工具清单，模型只能作答
      prepareStep: ({ steps }) => {
        const requested = steps.reduce((s, st) => s + st.toolCalls.length, 0)
        if (requested >= TOOL_REQUEST_HARD_LIMIT) {
          limitHit = true
          return { activeTools: [] }
        }
        return undefined
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
        case 'tool-call':
          // 工具步骤无 delta：item-start 即「执行中」
          startItem('tool', {
            t: 'tool',
            name: part.toolName,
            display: mcp.displays.get(part.toolName),
            args: (part.input ?? {}) as Record<string, unknown>
          })
          toolItemIndex.set(part.toolCallId, cur)
          toolStartAt.set(part.toolCallId, Date.now())
          break
        case 'tool-result': {
          const idx = toolItemIndex.get(part.toolCallId)
          if (idx === undefined) break
          const item = items[idx] as Extract<TurnItem, { t: 'tool' }>
          item.result = part.output
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
      // 停止是正常收场：已流出内容保留，标 stopped
      finish('stopped', undefined, undefined, contextRatio)
    } else {
      const msg = humanizeError(e)
      items.push({ t: 'boundary', kind: 'error', text: msg })
      finish('error', msg, undefined, contextRatio)
    }
  } finally {
    turns.delete(streamId)
  }
}
