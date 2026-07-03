import { WebContents } from 'electron'
import { getProvider } from './db'
import { streamChat, systemPrompt, kbHitPrompt, kbMissPrompt, rewriteQuery, humanize, type ChatMessage } from './ai'
import { retrieve } from './retrieve'

interface HttpError extends Error {
  status?: number
}

const sessions = new Map<string, AbortController>()

export interface SendPayload {
  streamId: string
  model: string
  messages: ChatMessage[]
  kb?: boolean // 知识库会话
}

// 不调模型的本地回复：复用 chunk+done 事件，渲染层按普通回答处理
function localReply(wc: WebContents, streamId: string, text: string): void {
  if (wc.isDestroyed()) return
  wc.send('chat:chunk', { streamId, delta: text, kind: 'content' })
  wc.send('chat:done', { streamId })
}

export async function startChat(wc: WebContents, payload: SendPayload): Promise<void> {
  const { streamId, model, messages } = payload
  const p = getProvider()
  if (!p.apiKey) {
    wc.send('chat:error', { streamId, error: '请先在设置里配置 API 密钥' })
    return
  }

  // 知识库会话：先检索，按命中与否拼装本轮系统提示词；各步骤推给界面做过程展示
  let sysPrompt = systemPrompt()
  if (payload.kb) {
    const step = (key: string, label: string, status: 'start' | 'end', detail?: string): void => {
      if (!wc.isDestroyed()) wc.send('chat:step', { streamId, key, label, status, detail })
    }
    const question = messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    let query = question
    // 多轮追问先改写成独立完整的检索问题；失败降级原句
    if (messages.filter((m) => m.role === 'user').length > 1) {
      step('rewrite', '理解问题', 'start')
      try {
        query = await rewriteQuery({
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          model,
          history: messages.slice(0, -1),
          question
        })
      } catch {
        query = question
      }
      step('rewrite', '理解问题', 'end')
    }
    step('retrieve', '检索知识库', 'start')
    try {
      const r = await retrieve(query)
      if (r.status === 'busy') {
        step('retrieve', '检索知识库', 'end', '知识库更新中')
        localReply(wc, streamId, '知识库正在更新，请稍候再试。')
        return
      }
      if (r.status === 'needs-rebuild') {
        step('retrieve', '检索知识库', 'end', '需要重建')
        localReply(wc, streamId, '本地模型已更换，请到「设置 › 知识库」重新构建后再提问。')
        return
      }
      step(
        'retrieve',
        '检索知识库',
        'end',
        r.status === 'hit' ? `命中 ${r.sources.length} 条相关内容` : '未找到直接相关的内容'
      )
      step('generate', '生成回复', 'start')
      if (r.status === 'hit') {
        wc.send('chat:sources', {
          streamId,
          sources: r.sources.map(({ n, chunkId, filePath, headingPath, startLine, endLine }) => ({
            n,
            chunkId,
            filePath,
            headingPath,
            startLine,
            endLine
          }))
        })
        sysPrompt = kbHitPrompt(r.sources)
      } else {
        sysPrompt = kbMissPrompt()
      }
    } catch (e) {
      wc.send('chat:error', { streamId, error: `知识库检索失败：${(e as Error).message.slice(0, 120)}` })
      return
    }
  }

  const controller = new AbortController()
  sessions.set(streamId, controller)

  // 合并碎 token：缓冲约 16ms 再一次性推给渲染进程（思考与正文分开）
  let cbuf = ''
  let rbuf = ''
  const flush = (): void => {
    if (wc.isDestroyed()) return
    if (rbuf) {
      wc.send('chat:chunk', { streamId, delta: rbuf, kind: 'reasoning' })
      rbuf = ''
    }
    if (cbuf) {
      wc.send('chat:chunk', { streamId, delta: cbuf, kind: 'content' })
      cbuf = ''
    }
  }
  const timer = setInterval(flush, 16)

  try {
    await streamChat({
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      model,
      messages: [{ role: 'system', content: sysPrompt }, ...messages],
      signal: controller.signal,
      onDelta: (d, kind) => {
        if (kind === 'reasoning') rbuf += d
        else cbuf += d
      }
    })
    flush()
    if (!wc.isDestroyed()) wc.send('chat:done', { streamId })
  } catch (e) {
    flush()
    if (wc.isDestroyed()) return
    if (controller.signal.aborted) {
      wc.send('chat:stopped', { streamId }) // 用户主动中断
    } else {
      const status = (e as HttpError).status
      wc.send('chat:error', {
        streamId,
        error: status ? humanize(status) : '网络连接失败，请检查网络后重试'
      })
    }
  } finally {
    clearInterval(timer)
    sessions.delete(streamId)
  }
}

export function stopChat(streamId: string): void {
  sessions.get(streamId)?.abort()
}
