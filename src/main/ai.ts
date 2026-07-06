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
