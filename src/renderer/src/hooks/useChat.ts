import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceRef } from '../../../preload/index.d'

export type MsgStatus = 'done' | 'streaming' | 'stopped' | 'error'

export interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  thinkMs?: number
  status: MsgStatus
  error?: string
  createdAt: number
  sources?: SourceRef[]
  steps?: { key: string; label: string; detail?: string; done: boolean }[] // 知识库会话的处理过程（不落库）
}

let seq = 0
const uid = (p: string): string => `${p}-${Date.now()}-${seq++}`

export interface ChatHandle {
  threads: Record<string, Msg[]>
  streamingConv: string | null
  hydrate: (convId: string, msgs: Msg[]) => void
  send: (convId: string, model: string, text: string, kb?: boolean) => void
  stop: () => void
  retry: (convId: string, model: string, msgId: string, kb?: boolean) => void
}

export function useChat(onChange?: () => void): ChatHandle {
  const [threads, setThreads] = useState<Record<string, Msg[]>>({})
  const [streamingConv, setStreamingConv] = useState<string | null>(null)
  const threadsRef = useRef(threads)
  const routeRef = useRef<{ convId: string; msgId: string; streamId: string; createdAt: number } | null>(null)
  const liveRef = useRef<{ content: string; reasoning: string; sources?: SourceRef[] }>({
    content: '',
    reasoning: ''
  })
  const thinkStartRef = useRef(0)
  const thinkDoneRef = useRef(false)
  const titledRef = useRef(new Set<string>())
  const onChangeRef = useRef(onChange)

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

  const persist = useCallback((convId: string, m: Msg) => {
    window.api.saveMessage({
      id: m.id,
      conversationId: convId,
      role: m.role,
      content: m.content,
      reasoning: m.reasoning ?? null,
      status: m.status,
      createdAt: m.createdAt,
      sources: m.sources?.length ? JSON.stringify(m.sources) : null
    })
  }, [])

  useEffect(() => {
    const off = window.api.onChatEvent((evt) => {
      const r = routeRef.current
      if (!r || r.streamId !== evt.streamId) return
      if (evt.type === 'step') {
        patch(r.convId, r.msgId, (m) => {
          const steps = [...(m.steps ?? [])]
          const i = steps.findIndex((s) => s.key === evt.key)
          if (evt.status === 'start') {
            if (i < 0) steps.push({ key: evt.key!, label: evt.label!, done: false })
          } else if (i >= 0) {
            steps[i] = { ...steps[i], done: true, detail: evt.detail }
          } else {
            steps.push({ key: evt.key!, label: evt.label!, done: true, detail: evt.detail })
          }
          return { ...m, steps }
        })
        return
      }
      if (evt.type === 'sources') {
        // 来源清单先于流式到达；随消息保留（即使随后停止/报错）
        liveRef.current.sources = evt.sources ?? []
        patch(r.convId, r.msgId, (m) => ({ ...m, sources: evt.sources ?? [] }))
        return
      }
      if (evt.type === 'chunk') {
        const delta = evt.delta ?? ''
        if (evt.kind === 'reasoning') {
          if (!thinkStartRef.current) thinkStartRef.current = Date.now()
          liveRef.current.reasoning += delta
          patch(r.convId, r.msgId, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + delta }))
        } else {
          liveRef.current.content += delta
          let dur: number | undefined
          if (thinkStartRef.current && !thinkDoneRef.current) {
            thinkDoneRef.current = true
            dur = Date.now() - thinkStartRef.current
          }
          patch(r.convId, r.msgId, (m) => ({
            ...m,
            content: m.content + delta,
            thinkMs: m.thinkMs ?? dur
          }))
        }
        return
      }
      const status: MsgStatus =
        evt.type === 'done' ? 'done' : evt.type === 'stopped' ? 'stopped' : 'error'
      // 只思考未出正文就结束：也记下思考时长
      const tailDur =
        thinkStartRef.current && !thinkDoneRef.current ? Date.now() - thinkStartRef.current : undefined
      patch(r.convId, r.msgId, (m) => ({
        ...m,
        status,
        error: evt.error,
        thinkMs: m.thinkMs ?? tailDur,
        steps: m.steps?.map((s) => ({ ...s, done: true })) // 收尾时全部步骤置完成
      }))
      persist(r.convId, {
        id: r.msgId,
        role: 'assistant',
        content: liveRef.current.content,
        reasoning: liveRef.current.reasoning || undefined,
        status,
        createdAt: r.createdAt,
        sources: liveRef.current.sources
      })
      onChangeRef.current?.()
      // 首轮回复成功后，让模型生成精炼标题（每会话仅一次）
      if (status === 'done') {
        const thread = threadsRef.current[r.convId] ?? []
        const userText = thread.find((m) => m.role === 'user')?.content ?? ''
        if (userText && !titledRef.current.has(r.convId)) {
          const userCount = thread.filter((m) => m.role === 'user').length
          if (userCount === 1) {
            titledRef.current.add(r.convId)
            window.api
              .autoTitle({ convId: r.convId, userText, assistantText: liveRef.current.content })
              .then((t) => {
                if (t) onChangeRef.current?.()
              })
          }
        }
      }
      routeRef.current = null
      setStreamingConv(null)
    })
    return off
  }, [patch, persist])

  const startStream = useCallback(
    (
      convId: string,
      model: string,
      history: Msg[],
      assistant: { id: string; createdAt: number },
      kb: boolean
    ) => {
      const streamId = uid('s')
      routeRef.current = { convId, msgId: assistant.id, streamId, createdAt: assistant.createdAt }
      liveRef.current = { content: '', reasoning: '' }
      thinkStartRef.current = 0
      thinkDoneRef.current = false
      setStreamingConv(convId)
      const messages = history
        .filter((m) => m.status !== 'error' && m.content !== '')
        .map((m) => ({ role: m.role, content: m.content }))
      window.api.sendChat({ streamId, model, messages, kb })
    },
    []
  )

  const hydrate = useCallback((convId: string, msgs: Msg[]) => {
    setThreads((t) => (t[convId] ? t : { ...t, [convId]: msgs }))
  }, [])

  const send = useCallback(
    (convId: string, model: string, text: string, kb = false) => {
      if (routeRef.current) return
      const now = Date.now()
      const userMsg: Msg = { id: uid('u'), role: 'user', content: text, status: 'done', createdAt: now }
      const asstMsg: Msg = {
        id: uid('a'),
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: now + 1
      }
      setThreads((t) => ({ ...t, [convId]: [...(t[convId] ?? []), userMsg, asstMsg] }))
      const history = [...(threadsRef.current[convId] ?? []), userMsg]
      persist(convId, userMsg)
      onChangeRef.current?.()
      startStream(convId, model, history, asstMsg, kb)
    },
    [persist, startStream]
  )

  const retry = useCallback(
    (convId: string, model: string, msgId: string, kb = false) => {
      if (routeRef.current) return
      const thread = threadsRef.current[convId] ?? []
      const idx = thread.findIndex((m) => m.id === msgId)
      if (idx < 0) return
      const history = thread.slice(0, idx)
      const createdAt = thread[idx].createdAt
      patch(convId, msgId, (m) => ({
        ...m,
        content: '',
        reasoning: undefined,
        sources: undefined,
        status: 'streaming',
        error: undefined
      }))
      startStream(convId, model, history, { id: msgId, createdAt }, kb)
    },
    [patch, startStream]
  )

  const stop = useCallback(() => {
    const r = routeRef.current
    if (r) window.api.stopChat(r.streamId)
  }, [])

  return { threads, streamingConv, hydrate, send, stop, retry }
}
