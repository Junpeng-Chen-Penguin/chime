export interface DetectResult {
  ok: boolean
  latencyMs?: number
  models?: string[]
  error?: string
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

interface HttpError extends Error {
  status?: number
}

// 拉取服务商的模型列表（OpenAI 兼容：GET {base}/models）
export async function listModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string[]> {
  const res = await fetch(`${normalizeBase(baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  })
  if (!res.ok) {
    const err: HttpError = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const json = (await res.json()) as { data?: Array<{ id: string }> }
  const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
  if (!ids.length) throw new Error('该服务未返回任何模型')
  return ids
}

// 检测连接：先拉模型，再发一条极短请求确认能真正对话；15s 超时
export async function detect(baseUrl: string, apiKey: string): Promise<DetectResult> {
  if (!apiKey) return { ok: false, error: '请先填写 API 密钥' }
  if (!normalizeBase(baseUrl)) return { ok: false, error: '请先填写服务地址' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const start = Date.now()
  try {
    const models = await listModels(baseUrl, apiKey, controller.signal)
    const res = await fetch(`${normalizeBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: models[0],
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    })
    if (!res.ok) return { ok: false, error: humanize(res.status) }
    return { ok: true, latencyMs: Date.now() - start, models }
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, error: '连接超时，请检查网络或服务地址' }
    const status = (e as HttpError).status
    if (status) return { ok: false, error: humanize(status) }
    return { ok: false, error: '连接失败，请检查网络或服务地址' }
  } finally {
    clearTimeout(timer)
  }
}

export function humanize(status: number): string {
  if (status === 401 || status === 403) return 'API 密钥无效'
  if (status === 404) return '服务地址不正确'
  if (status === 429) return '请求过于频繁，请稍后再试'
  if (status >= 500) return '服务暂时不可用，请稍后再试'
  return `连接失败（HTTP ${status}）`
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 流式对话：解析 OpenAI 兼容的 SSE，逐段回调内容增量
export async function streamChat(opts: {
  baseUrl: string
  apiKey: string
  model: string
  messages: ChatMessage[]
  signal: AbortSignal
  onDelta: (text: string, kind: 'content' | 'reasoning') => void
}): Promise<void> {
  const res = await fetch(`${normalizeBase(opts.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
    signal: opts.signal
  })
  if (!res.ok) {
    const err: HttpError = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  if (!res.body) throw new Error('无响应内容')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? '' // 保留可能不完整的最后一行
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) opts.onDelta(delta.reasoning_content, 'reasoning')
        if (delta?.content) opts.onDelta(delta.content, 'content')
      } catch {
        // 跨 chunk 的半行 JSON，忽略
      }
    }
  }
}

function sanitizeTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, ' ')
  // 去掉首尾引号、句末标点
  t = t.replace(/^["'「『《]+|["'」』》]+$/g, '').replace(/[。.!！?？、,，;；:：]+$/g, '')
  return t.slice(0, 20)
}

// 用模型把首轮对话概括成一个短标题；失败抛错由调用方兜底
export async function generateTitle(opts: {
  baseUrl: string
  apiKey: string
  model: string
  userText: string
  assistantText: string
}): Promise<string> {
  const prompt = [
    '用不超过 12 个字概括下面这段对话的主题，作为会话标题。',
    '只输出标题本身，不要标点、引号或任何多余内容。',
    '',
    `用户：${opts.userText.slice(0, 600)}`,
    `回答：${opts.assistantText.slice(0, 600)}`
  ].join('\n')

  const res = await fetch(`${normalizeBase(opts.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      stream: false
    })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return sanitizeTitle(json.choices?.[0]?.message?.content ?? '')
}

// 多轮追问的查询改写：把带指代的追问还原成独立完整的检索问题。
// 3s 超时或失败由调用方降级用原句。
export async function rewriteQuery(opts: {
  baseUrl: string
  apiKey: string
  model: string
  history: { role: string; content: string }[]
  question: string
}): Promise<string> {
  const recent = opts.history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? '用户' : '回答'}：${m.content.slice(0, 300)}`)
    .join('\n')
  const prompt = [
    '下面是一段对话和用户的新问题。把新问题改写成一句不依赖上下文、独立完整的检索问题。',
    '只输出改写后的问题本身，不要解释。若新问题本身已完整，原样输出。',
    '',
    recent,
    `新问题：${opts.question.slice(0, 300)}`
  ].join('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`${normalizeBase(opts.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        stream: false
      }),
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const out = (json.choices?.[0]?.message?.content ?? '').trim()
    return out || opts.question
  } finally {
    clearTimeout(timer)
  }
}

// 知识库会话的系统提示词（PRD Case 3 附）。每轮按检索结果动态拼装:规则稳定在前,资料随轮在后
export const KB_FALLBACK_TEXT =
  '知识库中暂时没有找到与这个问题相关的内容。你可以换个问法再试，或联系知识维护者确认相关文档是否已收录。'

export function kbHitPrompt(sources: { n: number; filePath: string; headingPath: string; content: string }[]): string {
  const materials = sources
    .map((s) => `[${s.n}] ${s.filePath}${s.headingPath ? ' › ' + s.headingPath : ''}\n${s.content}`)
    .join('\n\n')
  return [
    '你是基于知识库回答问题的助手。本轮已从知识库中检索到以下资料。',
    '',
    '回答规则：',
    '1. 只依据下方资料回答，资料没有提到的内容不要推测或补充。',
    '2. 用自然的语言组织回答，不要逐字照抄资料，也不要罗列资料原文。',
    '3. 引用了某条资料时，在该句末尾标注对应编号，如 [1]；一句话用到多条资料就标多个，如 [1][2]。不要标注没有用到的资料，不要编造编号。',
    '4. 资料只覆盖了问题的一部分时，回答覆盖到的部分，并明确说明其余部分知识库中没有找到；不要硬凑完整答案。',
    '5. 资料之间有冲突时，指出冲突并分别说明。',
    '6. 结合之前的对话理解当前问题（如「那按天的呢」这类指代），但事实内容仍只依据资料。',
    '',
    '资料：',
    materials
  ].join('\n')
}

export function kbMissPrompt(): string {
  return [
    '你是基于知识库回答问题的助手。本轮没有从知识库中检索到与用户问题相关的资料。',
    '',
    '处理规则：',
    `1. 如果用户是在询问业务或知识库内容（例：「XX 模块的计费规则是什么」「这个字段是什么含义」），原样回复：「${KB_FALLBACK_TEXT}」不要用你自己的知识回答业务问题，也不要依据之前对话中出现过的资料内容作答。`,
    '2. 如果是与知识库无关的通用请求（例：「帮我把这段话改通顺」「翻译一下」「谢谢」），正常回答即可，不要提知识库。',
    '3. 拿不准属于哪类时，按第 1 条处理。'
  ].join('\n')
}

export function systemPrompt(): string {
  const d = new Date()
  const date = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return [
    `今天是 ${date}。`,
    '用简洁、直接的中文回答；能一句说清就不用三句，省掉铺垫和客套。',
    '说自然的中文，别堆专业黑话和生造词；少用列表和加粗，多用平实的成段表达。'
  ].join('\n')
}
