// 检索工具化：search_knowledge_base 按轮创建（闸门计数与来源池是轮内状态）。
// 返回四态：results / 空 results（查不到）/ error（故障）/ notice（暂时不可用）；
// denied 是工具级闸门——第 4 次检索请求不执行，以工具结果身份告知模型收场。

import { tool, jsonSchema } from 'ai'
import { retrieve } from '../retrieve'
import { SEARCH_TOOL_DESCRIPTION } from './prompts'
import type { SourceSnapshot } from './store'

export const SEARCH_LIMIT_PER_TURN = 3 // 工具级闸门（软约束 3 次的硬性面）
export const TOOL_REQUEST_HARD_LIMIT = 6 // 接口级禁止：请求总数（含被拒）触顶即摘工具清单
const RESULT_CHAR_LIMIT = 6000 // 规则 2：单次工具返回入场上限（字符，联调校准）

export interface TurnToolContext {
  pool: SourceSnapshot[] // 本轮检索结果池：多次检索连续编号，回答结束按 [n] 反查
  searches: number
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
