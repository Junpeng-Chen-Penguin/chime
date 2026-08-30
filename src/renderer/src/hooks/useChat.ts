import { useCallback, useEffect, useRef, useState } from 'react'
import type { TurnItem, AskOutcomePayload } from '../../../preload/index.d'

// interrupted = 应用退出打断、启动修复后收场（仅出现在水合的历史消息里）
export type MsgStatus = 'done' | 'streaming' | 'stopped' | 'error' | 'interrupted'

// 表格行引用（013 Case 2）与斜杠点名 chip（015 Case 6）：随用户消息发送的 TurnItem 分支
export type RefItem = Extract<TurnItem, { t: 'ref' }>
export type SkillRefItem = Extract<TurnItem, { t: 'skillref' }>
export type UserItem = RefItem | SkillRefItem

export interface Usage {
  input: number
  output: number
  cached: number
}

export interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string // assistant：最终回答文本（复制、自动标题用）
  items?: TurnItem[] // assistant：一轮的有序过程
  usage?: Usage // 正常收尾才有；中断轮无（不显示不估算）
  status: MsgStatus
  error?: string
  tailOpen?: boolean // 末位块还在流式中（016 状态行四档判定用；展示态，不落库）
  createdAt: number
}

let seq = 0
const uid = (p: string): string => `${p}-${Date.now()}-${seq++}`

export interface ChatHandle {
  threads: Record<string, Msg[]>
  streamingConv: string | null
  contextRatio: Record<string, number> // 每会话最近一轮的上下文用量比例（>0.7 轻提示）
  hydrate: (convId: string, msgs: Msg[]) => void
  // ws：首条消息随带的工作空间选中集合（015 Case 1），之后的消息不带（主进程已定格、会忽略）；
  // slashSkill：本轮消息的有效斜杠点名（015 Case 6，App 已对库校验）
  send: (
    convId: string,
    model: string,
    text: string,
    refs?: UserItem[],
    ws?: { picked: string[]; fromAgent: string[] },
    slashSkill?: string
  ) => void
  stop: () => void
  retry: (convId: string, model: string) => void
  respondCard: (toolCallId: string, decision: 'approved' | 'denied' | 'always') => void
  respondAsk: (toolCallId: string, outcome: AskOutcomePayload) => void
  interruptAskAndSend: (
    convId: string,
    model: string,
    text: string,
    refs?: UserItem[],
    slashSkill?: string
  ) => void
}

// chat:event 的 items 归约器：对话历史所有权在主进程，这里只维护展示态
export function useChat(onChange?: () => void): ChatHandle {
  const [threads, setThreads] = useState<Record<string, Msg[]>>({})
  const [streamingConv, setStreamingConv] = useState<string | null>(null)
  const [contextRatio, setContextRatio] = useState<Record<string, number>>({})
  const threadsRef = useRef(threads)
  const routeRef = useRef<{ convId: string; msgId: string; streamId: string } | null>(null)
  const titledRef = useRef(new Set<string>())
  const onChangeRef = useRef(onChange)
  const pendingSendRef = useRef<{
    convId: string
    model: string
    text: string
    refs?: UserItem[]
    slashSkill?: string
  } | null>(null)
  const sendRef = useRef<
    (
      convId: string,
      model: string,
      text: string,
      refs?: UserItem[],
      ws?: { picked: string[]; fromAgent: string[] },
      slashSkill?: string
    ) => void
  >(() => {})

  useEffect(() => {
    threadsRef.current = threads
  }, [threads])
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const patch = useCallback((convId: string, msgId: string, fn: (m: Msg) => Msg) => {
    setThreads((t) => ({
      ...t,
      [convId]: (t[convId] ?? []).map((m) => (m.id === msgId ? fn(m) : m))
    }))
  }, [])

  useEffect(() => {
    const off = window.api.onChatEvent((evt) => {
      const r = routeRef.current
      if (!r || r.streamId !== evt.streamId) return
      switch (evt.type) {
        case 'turn-start':
          onChangeRef.current?.() // 主进程已写入用户消息（首条自动成标题），刷新侧栏
          return
        case 'item-start':
          patch(r.convId, r.msgId, (m) => {
            const items = [...(m.items ?? [])]
            items[evt.index] = evt.item
            return { ...m, items, tailOpen: true }
          })
          return
        case 'item-delta':
          patch(r.convId, r.msgId, (m) => {
            const items = [...(m.items ?? [])]
            const it = items[evt.index]
            if (it && (it.t === 'text' || it.t === 'reasoning')) {
              items[evt.index] = { ...it, text: it.text + evt.text }
            }
            return { ...m, items }
          })
          return
        case 'item-done':
          patch(r.convId, r.msgId, (m) => {
            const items = [...(m.items ?? [])]
            items[evt.index] = evt.item
            // 只有末位块的收尾才关掉流式标（文本块的 done 可能拖到流末尾才补发）
            return { ...m, items, tailOpen: evt.index === items.length - 1 ? false : m.tailOpen }
          })
          return
        case 'item-update':
          patch(r.convId, r.msgId, (m) => {
            const items = [...(m.items ?? [])]
            items[evt.index] = evt.item
            return { ...m, items }
          })
          return
        case 'turn-done': {
          // 016：主进程只报结束原因，展示态由这里合成（空原因即正常完成）
          const status: MsgStatus = evt.endReason ?? 'done'
          let answer = ''
          patch(r.convId, r.msgId, (m) => {
            answer =
              [...(m.items ?? [])]
                .reverse()
                .find((i): i is { t: 'text'; text: string } => i.t === 'text' && !!i.text.trim())
                ?.text ?? ''
            const u = evt.usage
            return {
              ...m,
              status,
              error: evt.error,
              content: answer,
              usage: u
                ? { input: u.inputTokens, output: u.outputTokens, cached: u.cachedInputTokens ?? 0 }
                : m.usage
            }
          })
          setContextRatio((c) => ({ ...c, [r.convId]: evt.contextRatio }))
          onChangeRef.current?.()
          // 首轮回复成功后，让模型生成精炼标题（每会话仅一次）
          if (status === 'done') {
            const thread = threadsRef.current[r.convId] ?? []
            const userText = thread.find((m) => m.role === 'user')?.content ?? ''
            const userCount = thread.filter((m) => m.role === 'user').length
            if (userText && userCount === 1 && !titledRef.current.has(r.convId)) {
              titledRef.current.add(r.convId)
              window.api
                .autoTitle({ convId: r.convId, userText, assistantText: answer })
                .then((t) => {
                  if (t) onChangeRef.current?.()
                })
            }
          }
          routeRef.current = null
          setStreamingConv(null)
          // 打字中断提问：本轮收场后立刻把用户输入作为新消息发出
          const p = pendingSendRef.current
          if (p) {
            pendingSendRef.current = null
            sendRef.current(p.convId, p.model, p.text, p.refs, undefined, p.slashSkill)
          }
          return
        }
      }
    })
    return off
  }, [patch])

  const hydrate = useCallback((convId: string, msgs: Msg[]) => {
    setThreads((t) => (t[convId] ? t : { ...t, [convId]: msgs }))
  }, [])

  const begin = useCallback((convId: string, msgId: string): string => {
    const streamId = uid('s')
    routeRef.current = { convId, msgId, streamId }
    setStreamingConv(convId)
    return streamId
  }, [])

  const send: ChatHandle['send'] = useCallback(
    (
      convId,
      model,
      text,
      refs?: UserItem[],
      ws?: { picked: string[]; fromAgent: string[] },
      slashSkill?: string
    ) => {
      if (routeRef.current) return
      const now = Date.now()
      const userMsg: Msg = {
        id: uid('u'),
        role: 'user',
        content: text,
        items: refs?.length ? refs : undefined,
        status: 'done',
        createdAt: now
      }
      const asstMsg: Msg = {
        id: uid('a'),
        role: 'assistant',
        content: '',
        items: [],
        status: 'streaming',
        createdAt: now + 1
      }
      setThreads((t) => ({ ...t, [convId]: [...(t[convId] ?? []), userMsg, asstMsg] }))
      const streamId = begin(convId, asstMsg.id)
      window.api.sendChat({ streamId, convId, text, model, refs, ws, slashSkill })
    },
    [begin]
  )
  sendRef.current = send

  // 重试 / 重新生成：只对末轮回答有效（主进程删末轮 assistant 行后按历史重跑）
  const retry = useCallback(
    (convId: string, model: string) => {
      if (routeRef.current) return
      const thread = threadsRef.current[convId] ?? []
      const last = [...thread].reverse().find((m) => m.role === 'assistant')
      if (!last) return
      patch(convId, last.id, (m) => ({
        ...m,
        content: '',
        items: [],
        status: 'streaming',
        error: undefined,
        notice: undefined
      }))
      const streamId = begin(convId, last.id)
      window.api.retryChat({ streamId, convId, model })
    },
    [begin, patch]
  )

  const stop = useCallback(() => {
    const r = routeRef.current
    if (r) window.api.stopChat(r.streamId)
  }, [])

  // 授权卡回应：路由到当前流（等待期间没有活跃请求，但轮未结束、streamId 仍有效）
  const respondCard = useCallback(
    (toolCallId: string, decision: 'approved' | 'denied' | 'always') => {
      const r = routeRef.current
      if (r) window.api.cardRespond({ streamId: r.streamId, toolCallId, decision })
    },
    []
  )

  // 提问卡回应（作答 / 放弃整卡）
  const respondAsk = useCallback((toolCallId: string, outcome: AskOutcomePayload) => {
    const r = routeRef.current
    if (r) window.api.askRespond({ streamId: r.streamId, toolCallId, outcome })
  }, [])

  // 提问卡等待中打字发送 = 中断提问 + 开启新一轮（Claude 同此）：
  // 停止本轮（卡记未回应），本轮收场事件到达后把输入的文字作为新消息发出
  const interruptAskAndSend = useCallback(
    (convId: string, model: string, text: string, refs?: UserItem[], slashSkill?: string) => {
      const r = routeRef.current
      if (!r) return
      pendingSendRef.current = { convId, model, text, refs, slashSkill }
      window.api.stopChat(r.streamId)
    },
    []
  )

  return {
    threads,
    streamingConv,
    contextRatio,
    hydrate,
    send,
    stop,
    retry,
    respondCard,
    respondAsk,
    interruptAskAndSend
  }
}
