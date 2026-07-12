// 检索工具化：search_knowledge_base 按轮创建（闸门计数与来源池是轮内状态）。
// 返回四态：results / 空 results（查不到）/ error（故障）/ notice（暂时不可用）；
// denied 是工具级闸门——第 4 次检索请求不执行，以工具结果身份告知模型收场。

import { tool, jsonSchema } from 'ai'
import type { Tool } from 'ai'
import { retrieve } from '../retrieve'
import { callMcpTool, getMcpToolList } from '../mcp/client'
import { SEARCH_TOOL_DESCRIPTION } from './prompts'
import { AUTH_DENIED, INTERRUPT_NOT_STARTED, type CardQueue } from './cards'
import type { SourceSnapshot } from './store'

export const SEARCH_LIMIT_PER_TURN = 3 // 工具级闸门（软约束 3 次的硬性面）
// 接口级禁止：请求总数（含被拒）触顶即摘工具清单。
// v0.5.0 放宽（6 → 16）：一次多系统查数（提问 + 多调用 + 取数 + 制品）约 6–10 次调用，旧值必触闸
export const TOOL_REQUEST_HARD_LIMIT = 16
export const STEP_COUNT_LIMIT = 24 // 防御性兜底步数（v0.4.0 为 10），正常永远先触发硬闸
const RESULT_CHAR_LIMIT = 6000 // 规则 2：单次工具返回入场上限（字符，联调校准）

export interface TurnToolContext {
  pool: SourceSnapshot[] // 本轮检索结果池：多次检索连续编号，回答结束按 [n] 反查
  searches: number
}

// 注册表元信息（统一工具格式的落点）：展示名、用途（服务自带描述）、需要授权
export interface ToolMeta {
  display: string
  desc: string
  needsAuth: boolean
}

// MCP 工具动态注册：模型可见名 mcp__服务id__工具名（重名天然隔离），展示名「服务名:工具名」。
// 结果原样交回：成功为纯文本（存储不归一），失败为 { error }（模型据此重试、换路或说明），
// 拒绝授权为 { denied }、停止未执行为 { interrupted }（历史映射原样保留文案）。
// MCP 工具统一需授权：execute 先过卡片队列，同意才发起调用。
export function makeMcpTools(signal: AbortSignal, cards: CardQueue): {
  tools: Record<string, Tool>
  meta: Map<string, ToolMeta> // 模型可见名 → 元信息（display/desc 随 tool item 落库，渲染层不反查）
} {
  const tools: Record<string, Tool> = {}
  const meta = new Map<string, ToolMeta>()
  for (const t of getMcpToolList()) {
    const name = `mcp__${t.serviceId}__${t.name}`
    meta.set(name, { display: `${t.serviceName}:${t.name}`, desc: t.description, needsAuth: true })
    tools[name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args, { toolCallId }) => {
        const decision = await cards.request(toolCallId, signal)
        if (decision === 'denied') return { denied: AUTH_DENIED }
        if (decision === 'aborted') return { interrupted: INTERRUPT_NOT_STARTED }
        return execMcpTool(name, (args ?? {}) as Record<string, unknown>, signal)
      }
    })
  }
  return { tools, meta }
}

// 按模型可见名执行 MCP 调用：成功纯文本，失败 { error }
async function execMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<string | { error: string }> {
  const m = /^mcp__(\d+)__(.+)$/.exec(name)
  if (!m) return { error: `未知工具：${name}` }
  try {
    const r = await callMcpTool(Number(m[1]), m[2], args, signal)
    const text = ((r.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    if (r.isError) return { error: text || '调用失败' }
    return text
  } catch (e) {
    return { error: `调用失败：${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 返回类型由 tool() 泛型推导
export function makeSearchTool(ctx: TurnToolContext) {
  return tool({
    description: SEARCH_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: '自包含的检索短语，补全对话中的代词和省略' }
      },
      required: ['query']
    }),
    execute: async ({ query }) => {
      // 入参校验：模型偶发空参数调用，空检索词不进链路、不耗次数，回一条它能自我纠正的说明
      if (typeof query !== 'string' || !query.trim()) {
        return { invalid: '缺少检索词：请把要查的内容写成自包含的检索短语，通过 query 参数重新调用' }
      }
      if (ctx.searches >= SEARCH_LIMIT_PER_TURN) {
        return { denied: '已达检索上限，请基于已有结果作答' }
      }
      ctx.searches++
      try {
        const r = await retrieve(query)
        if (r.status === 'busy') return { notice: '知识库正在更新，请稍后再试' }
        if (r.status === 'needs-rebuild') return { notice: '知识库暂时不可用' } // 组装时已按无库拦下，此为兜底
        if (r.status === 'miss') return { results: [] }

        // 结果续接本轮来源池，连续编号
        const start = ctx.pool.length
        const numbered = r.sources.map((s, i) => ({
          n: start + i + 1,
          chunkId: s.chunkId,
          filePath: s.filePath,
          headingPath: s.headingPath,
          startLine: s.startLine,
          endLine: s.endLine,
          content: s.content
        }))
        ctx.pool.push(...numbered)

        // 入场截断：超出上限的条目不进模型上下文，并向模型标注（不误把部分当全量）
        const results: { n: number; file: string; heading: string; content: string }[] = []
        let used = 0
        for (const s of numbered) {
          if (results.length && used + s.content.length > RESULT_CHAR_LIMIT) continue
          used += s.content.length
          results.push({ n: s.n, file: s.filePath, heading: s.headingPath, content: s.content })
        }
        return results.length < numbered.length
          ? { results, truncated: `已截断，完整结果共 ${numbered.length} 条` }
          : { results }
      } catch (e) {
        return { error: `检索发生故障：${(e as Error).message.slice(0, 120)}` }
      }
    }
  })
}
