// 编排引擎：一轮 = 组装上下文 → streamText 多步循环 → 类型化事件流。
// 三个消费方共用事件（界面渲染 / 无界面 JSONL 输出），落库在轮次终结时一次完成。
// 本文件不依赖 BrowserWindow，界面与能力分离。

import { streamText, isStepCount } from 'ai'
import type { ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { getProvider } from '../db'
import { humanize } from '../ai'
import { buildSystemPrompt } from './prompts'
import { budgetFor, estimateTokens, recordUsage } from './budget'
import { saveUserMessage, saveAssistantTurn, loadHistoryMessages, type TurnItem, type TurnStatus } from './store'

export type ChatEvent =
  | { type: 'turn-start'; streamId: string }
  | { type: 'item-start'; streamId: string; index: number; t: TurnItem['t'] }
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
}): Promise<void> {
  const { streamId, convId, text, model, emit } = opts
  const p = getProvider()

  saveUserMessage(convId, text)
  emit({ type: 'turn-start', streamId })

  const items: TurnItem[] = []
  let cur = -1
  const startItem = (t: TurnItem['t'], item: TurnItem): void => {
    items.push(item)
    cur = items.length - 1
    emit({ type: 'item-start', streamId, index: cur, t })
  }
  const appendText = (delta: string): void => {
    ;(items[cur] as { text: string }).text += delta
    emit({ type: 'item-delta', streamId, index: cur, text: delta })
  }
  const endItem = (): void => {
    emit({ type: 'item-done', streamId, index: cur, item: items[cur] })
  }
  const finish = (status: TurnStatus, error?: string, usage?: { inputTokens: number; outputTokens: number }, contextRatio = 0): void => {
    const content = [...items].reverse().find((i): i is { t: 'text'; text: string } => i.t === 'text')?.text ?? ''
    saveAssistantTurn(convId, { content, items, status })
    emit({ type: 'turn-done', streamId, status, error, usage, contextRatio })
  }

  if (!p.apiKey) {
    items.push({ t: 'boundary', kind: 'error', text: '请先在设置里配置 API 密钥' })
    finish('error', '请先在设置里配置 API 密钥')
    return
  }

  // 组装：系统提示词（本模块无知识库，挂库注入随后续 Case）+ 对话历史（含本条）
  const system = buildSystemPrompt(null)
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

  const controller = new AbortController()
  turns.set(streamId, controller)

  try {
    const result = streamText({
      model: provider(model),
      instructions: system,
      messages: history,
      abortSignal: controller.signal,
      stopWhen: isStepCount(10) // 防御性兜底，正常先触发闸门（闸门随检索工具引入）
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
        case 'error':
          throw part.error
      }
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
