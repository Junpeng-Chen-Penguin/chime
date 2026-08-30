// 检索工具化：search_knowledge_base 按轮创建（闸门计数与来源池是轮内状态）。
// 返回四态：results / 空 results（查不到）/ error（故障）/ notice（暂时不可用）；
// denied 是工具级闸门——第 4 次检索请求不执行，以工具结果身份告知模型收场。

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { tool, jsonSchema } from 'ai'
import type { Tool } from 'ai'
import { listKbs } from '../db'
import { estimateTokens } from '../../shared/chunker'
import { retrieve } from '../retrieve'
import { callMcpTool, getMcpToolList } from '../mcp/client'
import { SEARCH_TOOL_DESCRIPTION } from './prompts'
import {
  AUTH_DENIED,
  INTERRUPT_NOT_STARTED,
  ASK_INTERRUPTED,
  type CardQueue,
  type AskQuestion
} from './cards'
import {
  guardSingle,
  grepResult,
  readResult,
  FETCH_LIMIT,
  GREP_HEAD_LIMIT,
  READ_LINES_DEFAULT,
  type OverflowCtx
} from './overflow'
import { createArtifact, type ArtifactRef } from './artifact'
import type { SourceSnapshot } from './store'

export const SEARCH_LIMIT_PER_TURN = 3 // 工具级闸门（软约束 3 次的硬性面）
// 接口级禁止：按「轮」计数（一轮内并行多次调用计 1 轮，对齐 Claude Code / Cherry / goose 计轮惯例；07-13 修订，原按次计）。
// 触顶步保留工具清单、toolChoice: none + 注入收尾指令；过半注入预警——见 orchestrator prepareStep
export const TOOL_ROUND_HARD_LIMIT = 16
export const STEP_COUNT_LIMIT = 24 // 防御性兜底步数（v0.4.0 为 10），正常永远先触发硬闸
// 规则 2：单次检索返回入场上限（字符）。6000 → 12000（013 Case 4）：上卷后一条可能是整篇
// （实测最大 3741 字），两篇相关文档同时命中就破 6000，第二篇会被静默丢掉；12000 装得下
// 三篇最大的整篇。对上卷前的形态零影响——6 片合计约 1200 字，远够不着
const RESULT_CHAR_LIMIT = 12000
// 整篇上卷的单篇上限（token）：超过的多为参考表类长文档（如领域模型），用户要的多半是其中一段
const WHOLE_DOC_TOKEN_MAX = 3000

export interface TurnToolContext {
  pool: SourceSnapshot[] // 本轮检索结果池：多次检索连续编号，回答结束按 [n] 反查
  searches: number
  kbIds: number[] // 本会话选用的库（检索范围）
  kbNames: Map<number, string> // 库 id → 名称（来源快照用）
}

// 注册表元信息（统一工具格式的落点）：展示名、用途（服务自带描述）、需要授权
export interface ToolMeta {
  display: string
  desc: string
  needsAuth: boolean
}

// MCP 工具动态注册：模型可见名 mcp__服务id__工具名（重名天然隔离），展示名 title 优先、
// 未声明的维持「服务名:工具名」（011 Case 4：内置工具本有中文名，MCP 工具经 title 享受同一待遇）。
// 结果原样交回：成功为纯文本（存储不归一），失败为 { error }（模型据此重试、换路或说明），
// 拒绝授权为 { denied }、停止未执行为 { interrupted }（历史映射原样保留文案）。
// 分级授权（011 Case 4）：默认一律过卡片队列；服务开了「信任只读声明」且工具声明 readOnlyHint
// 为真的直接执行（协议默认非只读，未声明按写操作弹卡）。成功结果过单结果闸（超限落库换摘要）。
export function makeMcpTools(
  signal: AbortSignal,
  cards: CardQueue,
  overflow: OverflowCtx,
  allowed: Set<number> // 本会话选用的服务 id（Case 8）：未选用的服务工具不进清单
): {
  tools: Record<string, Tool>
  meta: Map<string, ToolMeta> // 模型可见名 → 元信息（display/desc 随 tool item 落库，渲染层不反查）
} {
  const tools: Record<string, Tool> = {}
  const meta = new Map<string, ToolMeta>()
  for (const t of getMcpToolList()) {
    if (!allowed.has(t.serviceId)) continue
    const name = `mcp__${t.serviceId}__${t.name}`
    const title = t.title || (typeof t.annotations?.title === 'string' ? t.annotations.title : '')
    const needsAuth = !(t.serviceTrusted && t.annotations?.readOnlyHint === true)
    meta.set(name, {
      display: title || `${t.serviceName}:${t.name}`,
      desc: t.description,
      needsAuth
    })
    tools[name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args, { toolCallId }) => {
        if (needsAuth) {
          const decision = await cards.request(toolCallId, signal, t.name)
          if (decision === 'denied') return { denied: AUTH_DENIED }
          if (decision === 'aborted') return { interrupted: INTERRUPT_NOT_STARTED }
        }
        const r = await execMcpTool(name, (args ?? {}) as Record<string, unknown>, signal)
        if ('error' in r) return r
        return guardSingle(overflow, toolCallId, name, r.text, r.structured)
      }
    })
  }
  return { tools, meta }
}

// 取数内置工具（07-13 二次修订）：拆为 grep_result / read_result 两个，形态照搬模型语料里的 Grep/Read——
// 单工具 mode 切换是语料外结构，模型用不地道。免授权（只读本地已存数据）、超限豁免（取回的片段不再落库）。
// FETCH_TOOL_NAME 为退役工具名，仅供渲染层识别历史会话的旧调用行。
export const FETCH_TOOL_NAME = 'fetch_tool_result'
export const GREP_TOOL_NAME = 'grep_result'
export const READ_TOOL_NAME = 'read_result'

const GREP_TOOL_DESCRIPTION = `在已存的超限结果里逐行正则搜索，相当于对结果内容执行 grep -n。用于结果超限被存库（摘要里有「结果编号 #N」）、需要定位具体内容时；结果编号在本会话内一直有效。

- 不传 resultId 时搜索本会话全部已存结果（相当于 grep 整个目录），命中带来源前缀「#编号:行号:内容」——同一份数据分了多个结果存（如分页拉取）时用这个，一次搜完，不要逐个结果分别搜
- 支持完整正则语法（如 "账单.*超额"）；要查一批关键词时用 | 合并一次搜完（如 "词A|词B|词C"），不要逐词多次调用
- 已存的 JSON 是格式化多行、冒号后有空格：搜字段名写 "tenant_code": 即可，不要按紧凑 JSON 写 "tenant_code":"（会搜不到）
- context：命中行前后各带几行上下文（相当于 grep -C N），默认不带。要看每处命中的具体内容时直接带 context（如 3~5）一次拿全，不要拿到行号后再逐段 read_result
- head_limit：输出最多多少行（相当于 | head -N），默认 ${GREP_HEAD_LIMIT}；offset：跳过前 N 行输出（翻页用）
- 输出「行号:内容」，命中行用冒号、上下文行用连字符、不连续块间以 -- 分隔
- 拿到行号后用 read_result 一次读取整段，不要反复小搜
- 结果编号与这套存取机制是内部机制，任何给用户看的文字不要提及`

const READ_TOOL_DESCRIPTION = `按行号读取已存超限结果（结果编号 #N）的一段原文，相当于 sed -n 'N,Mp'。与 grep_result 配合：先搜索定位拿行号，再用本工具一次读取整段。

- offset：起始行号（从 1 起），仅在内容太大一次读不完、或已知要读哪一段时提供
- limit：读取行数，默认从头读 ${READ_LINES_DEFAULT} 行；要看完整记录就把 limit 给足，不要几行几行地多次小读
- 输出「行号:内容」；单次最多返回 ${FETCH_LIMIT} 字，超出会提示从哪行续读
- 结果编号与这套存取机制是内部机制，任何给用户看的文字不要提及`

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 返回类型由 tool() 泛型推导
export function makeGrepResultTool(convId: string) {
  return tool({
    description: GREP_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{
      resultId?: number
      pattern: string
      '-i'?: boolean
      context?: number
      head_limit?: number
      offset?: number
    }>({
      type: 'object',
      properties: {
        resultId: {
          type: 'number',
          description: '结果编号（摘要里的 #N，传数字 N）。不传则搜本会话全部已存结果'
        },
        pattern: { type: 'string', description: '正则表达式，逐行匹配；多个关键词用 | 合并' },
        '-i': { type: 'boolean', description: '忽略大小写（默认区分）' },
        context: { type: 'number', description: '命中行前后各带几行上下文（相当于 grep -C N）' },
        head_limit: {
          type: 'number',
          description: `输出最多多少行（相当于 | head -N），默认 ${GREP_HEAD_LIMIT}`
        },
        offset: { type: 'number', description: '跳过前 N 行输出再取 head_limit 行（翻页用）' }
      },
      required: ['pattern']
    }),
    execute: async (args) => grepResult(convId, args ?? ({} as never))
  })
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 返回类型由 tool() 泛型推导
export function makeReadResultTool(convId: string) {
  return tool({
    description: READ_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ resultId: number; offset?: number; limit?: number }>({
      type: 'object',
      properties: {
        resultId: { type: 'number', description: '结果编号（摘要里的 #N，传数字 N）' },
        offset: {
          type: 'number',
          description: '起始行号（从 1 起）。仅在内容太大一次读不完时提供'
        },
        limit: {
          type: 'number',
          description: `读取行数，默认 ${READ_LINES_DEFAULT}。一次给足，不要小读多次`
        }
      },
      required: ['resultId']
    }),
    execute: async (args) => readResult(convId, args ?? ({} as never))
  })
}

// 「询问用户」内置工具：模型缺信息时停下来弹提问卡（命名沿用 Claude Code 的 AskUserQuestion）。
// execute 挂起等用户回应，四条出路各对应一份固定文案（PRD 出路表），模型的后续行为由文案驱动。
export const ASK_TOOL_NAME = 'ask_user_question'

const ASK_TOOL_DESCRIPTION = `向用户提出选择题收集信息，问题以选择卡片呈现。

什么时候用：
- 只在答案能落在几个明确候选里时使用：几个方案选一个、确认某个操作、选范围或口径
- 调用工具前缺必填参数、执行前需要用户定夺时，缺几个信息就一次问齐，不要连环发起提问
- 答案完全开放、你给不出真实候选时（如让用户自由填写一个名称），不要用这个工具——直接在回复正文里向用户提问

问几个：
- 尽量只问 1 个，最多不超过 3 个。问题越少，用户回答得越快
- 例：缺「统计月份」与「是否含税」两个口径，就一次问 2 题，不要先问月份、等回答后再问含税

问题怎么写（question 字段）：
- 一句完整的问句，不超过 25 个字，问题里交代清楚差别（选项没有附加说明）
- 例：「这份对账单按哪个月份统计？」

选项怎么写（options 的 label 字段）：
- 选项必须是答案本身，每个不超过 12 个字
- 有推荐选项时放在第一位，label 末尾标注「（推荐）」
- 例：「2026 年 6 月（推荐）」「2026 年 5 月」
- 不要写「我直接输入」「见下方」这类操作指引选项
- 不要自设「其他」「以上都不是」——卡片界面自带「其他」自由输入行，再提供就会重复出现两个

返回语义：
- 「用户的回答：…」= 逐题作答结果，标「未回答」的题用户选择跳过
- 用户选择不回答时：不要换个说法重复问——包括在正文里再列一遍选项、以问句结尾再次征询；按已有信息继续，无法继续就用陈述句说明缺什么，然后停下等用户指示`

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 返回类型由 tool() 泛型推导
export function makeAskTool(signal: AbortSignal, cards: CardQueue) {
  return tool({
    description: ASK_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ questions: AskQuestion[] }>({
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: '要问用户的问题。尽量只问 1 个，最多 3 个，缺几个信息一次问齐',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题文字，完整的一句问句，不超过 25 个字' },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                description: '选项（2-4 个），推荐项放第一位并在 label 末尾标注「（推荐）」',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '选项文字：简短明确（不超过十几个字），就是答案本身'
                    }
                  },
                  required: ['label']
                }
              },
              multiSelect: { type: 'boolean', description: '是否允许多选，默认单选' }
            },
            required: ['question', 'options']
          }
        }
      },
      required: ['questions']
    }),
    execute: async ({ questions }, { toolCallId }) => {
      // 运行时强校验（014 Case 7）：参数结构里的 minItems 只是给模型看的声明，模型不照做没人拦——
      // 实测近两轮回归 5 次传空选项照样弹卡。不合格不弹卡，返回文案说清三件事：没生效、为什么、下一步
      if (!questions?.length)
        return '这次提问没有发出：没有携带任何问题。要问用户就带上问题和至少 2 个候选选项；答案完全开放时不要用这个工具，直接在回复正文里向用户提问。'
      const bad = questions
        .map((q, i) => ({ i, n: q.options?.length ?? 0 }))
        .filter((x) => x.n < 2)
      if (bad.length)
        return `这次提问没有发出：${bad.map((x) => `第 ${x.i + 1} 个问题只给了 ${x.n} 个选项`).join('；')}，少于 2 个。答案完全开放时（要人名、租户名、日期这类）不要用这个工具，直接在回复正文里向用户提问。选项能列全且不少于 2 个时才用这个工具。`
      const outcome = await cards.requestAsk(toolCallId, questions ?? [], signal)
      switch (outcome.kind) {
        case 'answers':
          return `用户的回答：\n${outcome.answers.map((a) => `${a.question}=${a.answer ?? '未回答'}`).join('\n')}`
        case 'declined':
          return '用户选择不回答这些问题。不要换个说法重复问——不要在正文里再列一遍选项，也不要以问句结尾再次征询。按已有信息继续；无法继续就用陈述句说明缺什么，然后停下等用户指示。'
        case 'aborted':
          return { interrupted: ASK_INTERRUPTED }
      }
    }
  })
}

// 按模型可见名执行 MCP 调用：成功为文本 + 可选结构化数据（服务带 structuredContent 时），失败 { error }
async function execMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ text: string; structured?: unknown } | { error: string }> {
  const m = /^mcp__(\d+)__(.+)$/.exec(name)
  if (!m) return { error: `未知工具：${name}` }
  try {
    const r = await callMcpTool(Number(m[1]), m[2], args, signal)
    const text = ((r.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
    if (r.isError) return { error: text || '调用失败' }
    return { text, structured: r.structuredContent }
  } catch (e) {
    return { error: `调用失败：${String((e as Error)?.message ?? e).slice(0, 200)}` }
  }
}

// 「生成制品」内置工具：模型判断用户需要亲眼查看/核对数据时，生成表格制品（对话流出卡、侧板查看）。
// 免授权（只产出展示内容，不动外部系统）。成功时引擎以制品卡呈现（不出工具步骤行）。
export const ARTIFACT_TOOL_NAME = 'create_artifact'

// 触发规则（何时生成）在系统提示词的输出约定里，这里只写接口用法（v1.1.0 Case 8：注入位置决定遵循强度）
const ARTIFACT_TOOL_DESCRIPTION = `把一批行列结构的数据生成表格制品，用户点开在侧板查看全貌。何时生成以系统提示词的输出约定为准。

数据怎么给（二选一）：
- data：数据量小时直接给——对象数组（键为列名），或规整的分隔文本
- ref：数据已存库（有内部取数编号）时只给引用——{ resultId, keyword? 或 start/length? }，系统按引用取数填进制品，你不要誊写数据

使用要求：
- 仅适合行列结构的数据（清单、明细、统计行）；散文式内容不适合
- title 用用户视角起名（如「A公司 2026年6月 账单明细」）；数据是什么、怎么筛的在对话正文里说，制品只装数据本体
- 生成制品是回答的收尾动作：卡片出现后正文只写结论，不要再复述表格内容
- 制品、取数编号都是内部机制，任何给用户看的文字不要提及——包括不说「已整理成表格」「已生成制品」这类话，用户在界面上看得到
- 数据解析不成行列时会返回错误、不生成制品——此时在回答里直接说明或换个方式给出内容`

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- 返回类型由 tool() 泛型推导
export function makeArtifactTool(
  convId: string,
  onArtifact: (toolCallId: string, info: { id: number; title: string; rowCount: number }) => void
) {
  return tool({
    description: ARTIFACT_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ type: 'table'; title: string; data?: unknown; ref?: ArtifactRef }>({
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['table'],
          description: '制品类型，本版仅 table（数据表格）'
        },
        title: { type: 'string', description: '制品标题，用户视角命名，不超过 20 个字' },
        data: { description: '直接内容：对象数组（键为列名）或规整分隔文本。与 ref 二选一' },
        ref: {
          type: 'object',
          description: '数据引用：从已存结果取数，数据不经你誊写。与 data 二选一',
          properties: {
            resultId: { type: 'number', description: '内部取数编号（#N 传 N）' },
            keyword: { type: 'string', description: '只取包含关键词的行（可选）' },
            start: { type: 'number', description: '起始字符位置（可选）' },
            length: { type: 'number', description: '长度（可选）' }
          },
          required: ['resultId']
        }
      },
      required: ['type', 'title']
    }),
    execute: async (args, { toolCallId }) => {
      const r = createArtifact(convId, args ?? {})
      if ('error' in r) return r
      onArtifact(toolCallId, r)
      // 返回写成非自然语言的状态标记，不能是一句能说出口的话。改过两次：
      // 一改去掉行为指导（原文案「…简短收束即可，不要复述表格内容」），仍复发；
      // 二改才认清根因——只要返回是通顺的中文（「已生成制品，13 行。」），它在历史里出现两遍后
      // 模型就会跳过调用直接复述（2026-08-03 实测：第 3 轮零调用却声称「已生成表格制品（10 行）」）。
      // rows 保留：正文报条数要用这个程序数出来的值，不许自己数
      return `[artifact ok rows=${r.rowCount}]`
    }
  })
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
        return {
          invalid: '缺少检索词：请把要查的内容写成自包含的检索短语，通过 query 参数重新调用'
        }
      }
      if (ctx.searches >= SEARCH_LIMIT_PER_TURN) {
        // 到上限分两种（013 Case 6）：一条结果都没有时「基于已有结果作答」等于让模型凭空编
        return ctx.pool.length
          ? { denied: '已达检索上限，请基于已有结果作答' }
          : {
              denied:
                '已达检索上限且没有任何命中：如实告知用户知识库中没有找到相关内容，不要用你自己的知识补充没有资料依据的回答'
            }
      }
      ctx.searches++
      try {
        const r = await retrieve(query, ctx.kbIds)
        if (r.status === 'busy') return { notice: '知识库正在更新，请稍后再试' }
        if (r.status === 'needs-rebuild') return { notice: '知识库暂时不可用' } // 组装时已按无库拦下，此为兜底
        if (r.status === 'miss') {
          // 空结果带说明与下一步（013 Case 6）：裸空数组让模型自己发明下一步——
          // badcase A8（拒绝后只报状态不给动作）与 S6（空结果不报默认）的同族第三例。
          // 报剩余次数让它自己规划；不描述知识库怎么组织（那是某一个库的观察，不是通用事实）
          const left = SEARCH_LIMIT_PER_TURN - ctx.searches
          return {
            results: [],
            notice:
              left > 0
                ? `本次检索没有命中。本轮还可检索 ${left} 次，可换一个角度或换一组业务概念词再查`
                : ctx.pool.length
                  ? '本次检索没有命中，检索次数已用完，基于已查到的结果作答'
                  : '本次检索没有命中且次数已用完：如实告知用户知识库中没有找到相关内容，不要用你自己的知识补充没有资料依据的回答'
          }
        }

        // 结果续接本轮来源池，连续编号
        const start = ctx.pool.length
        const numbered = r.sources.map((s, i) => ({
          n: start + i + 1,
          chunkId: s.chunkId,
          kbId: s.kbId,
          kbName: ctx.kbNames.get(s.kbId) ?? '',
          filePath: s.filePath,
          headingPath: s.headingPath,
          startLine: s.startLine,
          endLine: s.endLine,
          content: s.content
        }))
        ctx.pool.push(...numbered)

        // 按文档上卷（013 Case 4）：同一篇命中 2 片以上，用整篇原文替换这几片——命中多片
        // 说明整篇就是用户要找的，而未命中的邻段（如「入口与角色」）往往正是缺的那块答案。
        // 整篇直接读磁盘，不从片拼（切块丢了空行与文件头、超长表格切片带合成表头，拼不回原文）；
        // 读不到（文件被删改）或整篇超限则保持原片。分组键带库：多库可能有同名同路径文档。
        // 做在 TOP_SOURCES 截断之后：先截再合，腾出的位置不补——第 7 名之后本就是重排
        // 判定不够相关的。来源池 pool 保持逐片快照，侧板高亮机制不变
        type Entry = (typeof numbered)[number] & { whole?: boolean }
        const groups = new Map<string, typeof numbered>()
        for (const s of numbered) {
          const k = `${s.kbId}:${s.filePath}`
          const g = groups.get(k)
          if (g) g.push(s)
          else groups.set(k, [s])
        }
        let display: Entry[] = numbered
        if ([...groups.values()].some((g) => g.length >= 2)) {
          const roots = new Map(listKbs().map((k) => [k.id, k.rootPath]))
          const merged: Entry[] = []
          const seen = new Set<string>()
          for (const s of numbered) {
            const k = `${s.kbId}:${s.filePath}`
            const g = groups.get(k)!
            if (g.length < 2) {
              merged.push(s)
              continue
            }
            if (seen.has(k)) continue
            seen.add(k)
            let whole: string | null = null
            const root = roots.get(s.kbId)
            if (root) {
              try {
                const abs = resolve(root, s.filePath)
                // 与 doc:open 相同的路径逃逸校验
                if (abs.startsWith(resolve(root))) {
                  const text = readFileSync(abs, 'utf8')
                  if (estimateTokens(text) <= WHOLE_DOC_TOKEN_MAX) whole = text
                }
              } catch {
                // 文件被删或被移：保持原片
              }
            }
            if (whole === null) merged.push(...g)
            else merged.push({ ...s, content: whole, whole: true })
          }
          display = merged
        }

        // 入场截断：超出上限的条目不进模型上下文，并向模型标注丢了什么（不误把部分当全量）
        const results: { n: number; file: string; heading: string; content: string }[] = []
        const dropped: string[] = []
        let used = 0
        for (const s of display) {
          if (results.length && used + s.content.length > RESULT_CHAR_LIMIT) {
            dropped.push(s.whole ? `《${s.filePath}》（整篇）` : `《${s.filePath}》的一段`)
            continue
          }
          used += s.content.length
          results.push({
            n: s.n,
            file: s.filePath,
            heading: s.whole ? '〔整篇原文〕' : s.headingPath,
            content: s.content
          })
        }
        return dropped.length
          ? { results, truncated: `因篇幅上限未能放入：${[...new Set(dropped)].join('、')}` }
          : { results }
      } catch (e) {
        return { error: `检索发生故障：${(e as Error).message.slice(0, 120)}`, userText: '检索出错' }
      }
    }
  })
}
