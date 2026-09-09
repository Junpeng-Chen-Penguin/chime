// 延迟加载的 MCP 工具（018 五节）：tools 数组只放十二个内置工具，MCP 工具的定义存在本会话的本地查询表里，
// 不进请求。模型用 tool_search 按自然语言取回定义，用 tool_invoke 转接调用。
// 为什么要转接：AI SDK 收到工具调用后只在交给它的工具表里按名字找执行函数，不在 tools 数组里的工具调不到。
// 查询表存在 conversation.deferred_tools，会话第一轮与点名新服务时追加，只增不减，重启后从列里读。

import { tool, jsonSchema, type Tool } from 'ai'
import { getMcpToolList, type McpToolInfo } from '../mcp/client'
import {
  getConversationDeferredTools,
  setConversationDeferredTools,
  getMcpToolsJson,
  getMcpService
} from '../db'
import { execMcpTool } from './tools'
import { guardSingle, type OverflowCtx } from './overflow'
import { AUTH_DENIED, INTERRUPT_NOT_STARTED, type CardQueue } from './cards'

export const TOOL_SEARCH_NAME = 'tool_search'
export const TOOL_INVOKE_NAME = 'tool_invoke'
const SEARCH_MAX = 3

export interface DeferredTool {
  key: string // 模型填的名字：默认是 MCP 工具原名；同名工具来自不同服务时，后加入的为 `${serviceName}_${name}`
  fullName: string // mcp__<serviceId>__<name>：落库与 Tuner 断言用，与改动前的模型可见名相同
  serviceId: number
  serviceName: string
  title: string // 协议顶层 title 或 annotations.title，展示名优先用它
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean // annotations.readOnlyHint === true
  searchText: string // key、key 下划线换空格、description、参数名与参数说明递归展开，小写
}

export const bareName = (fullName: string): string => fullName.replace(/^mcp__\d+__/, '')

// 参数名与说明递归展开：自然语言检索能命中的关键——模型不必知道工具名里的下划线怎么写
function schemaWords(schema: unknown, out: string[]): void {
  if (!schema || typeof schema !== 'object') return
  const s = schema as Record<string, unknown>
  if (typeof s.description === 'string') out.push(s.description)
  const props = s.properties
  if (props && typeof props === 'object')
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      out.push(k, k.replace(/_/g, ' '))
      schemaWords(v, out)
    }
  if (s.items) schemaWords(s.items, out)
}

function entryOf(t: McpToolInfo, taken: Set<string>): DeferredTool {
  const key = taken.has(t.name) ? `${t.serviceName}_${t.name}` : t.name
  const words = [key, key.replace(/_/g, ' '), t.description]
  schemaWords(t.inputSchema, words)
  return {
    key,
    fullName: `mcp__${t.serviceId}__${t.name}`,
    serviceId: t.serviceId,
    serviceName: t.serviceName,
    title: t.title || (typeof t.annotations?.title === 'string' ? t.annotations.title : ''),
    description: t.description,
    inputSchema: t.inputSchema,
    readOnly: t.annotations?.readOnlyHint === true,
    searchText: words.join('\n').toLowerCase()
  }
}

// 某个服务此刻能拿到的工具：已连接用内存里的，未连接用上次拉到并存下的（连不上的服务照常可点名）
function serviceTools(serviceId: number): McpToolInfo[] {
  const live = getMcpToolList().filter((t) => t.serviceId === serviceId)
  if (live.length) return live
  const cached = getMcpToolsJson(serviceId)
  if (!cached) return []
  try {
    const v = JSON.parse(cached) as McpToolInfo[]
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// 查询表：读本会话已存的，缺的服务补进去（只追加），有变化就写回
export function ensureDeferredTable(convId: string, serviceIds: Iterable<number>): DeferredTool[] {
  const table = getConversationDeferredTools<DeferredTool>(convId)
  const have = new Set(table.map((e) => e.serviceId))
  const taken = new Set(table.map((e) => e.key))
  let changed = false
  for (const id of serviceIds) {
    if (have.has(id)) continue
    for (const t of serviceTools(id)) {
      const e = entryOf(t, taken)
      taken.add(e.key)
      table.push(e)
      changed = true
    }
  }
  if (changed) setConversationDeferredTools(convId, table)
  return table
}

// ── tool_search ──────────────────────────────────────────────────
// 词项：拉丁字符按非字母数字切词；连续汉字取全部相邻二字组，单个汉字不算。
// 得分 = 词项里出现在 searchText 中的个数；得分大于 0 的按得分降序、表内顺序稳定排序，取前 3
export function searchTerms(query: string): string[] {
  const q = query.toLowerCase()
  const terms = new Set<string>()
  for (const w of q.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue
    if (/^[\p{Script=Han}]+$/u.test(w)) {
      for (let i = 0; i + 1 < w.length; i++) terms.add(w.slice(i, i + 2))
    } else if (/\p{Script=Han}/u.test(w)) {
      // 汉字与字母数字混排：拆成汉字段与其余段各自处理
      for (const seg of w.split(/(\p{Script=Han}+)/u)) {
        if (!seg) continue
        if (/^\p{Script=Han}+$/u.test(seg)) {
          for (let i = 0; i + 1 < seg.length; i++) terms.add(seg.slice(i, i + 2))
        } else terms.add(seg)
      }
    } else terms.add(w)
  }
  return [...terms]
}

export function searchDeferred(table: DeferredTool[], query: string): DeferredTool[] {
  const terms = searchTerms(query)
  if (!terms.length) return []
  return table
    .map((e, i) => ({ e, i, score: terms.filter((t) => e.searchText.includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, SEARCH_MAX)
    .map((x) => x.e)
}

const SEARCH_DESCRIPTION = `查找本会话可用的其他工具。除清单里这些内置工具之外，会话里接入的服务还提供更多工具，它们的名字在对话里的工具名清单里，定义没有放进清单，需要时用本工具取得。
用法：query 写工具名，或写你要做的事、要查的对象，如「查询项目的授权状态」「提交续签汇报」。一次最多返回 3 个最相关的工具，每个带名字、说明和完整参数定义；拿到定义后用 tool_invoke 调用，填工具名与参数。
query 留空时返回本会话全部服务工具的名字和一句话说明，按服务分组，不带参数定义，用来浏览有什么可用。
没有匹配时返回说明和本会话有哪些服务，可以换个说法再找；确实没有对应工具就如实告诉用户做不了。`

// 一句话说明：说明的第一行，超过 80 字截断
function brief(description: string): string {
  const line = description.split('\n').find((l) => l.trim())?.trim() ?? ''
  return line.length > 80 ? line.slice(0, 80) + '…' : line
}

export function browseDeferred(table: DeferredTool[]): { service: string; tools: { name: string; description: string }[] }[] {
  const groups = new Map<string, { name: string; description: string }[]>()
  for (const e of table) {
    const g = groups.get(e.serviceName) ?? []
    g.push({ name: e.key, description: brief(e.description) })
    groups.set(e.serviceName, g)
  }
  return [...groups].map(([service, tools]) => ({ service, tools }))
}

export function makeToolSearchTool(table: DeferredTool[]): Tool {
  return tool({
    description: SEARCH_DESCRIPTION,
    // 类型上写成必填让 tool() 的重载能选中；JSON Schema 里不设 required，模型可以不传
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: '工具名，或要做的事、要查的对象；留空浏览全部' }
      }
    }),
    execute: async ({ query }): Promise<Record<string, unknown>> => {
      const q = typeof query === 'string' ? query.trim() : ''
      if (!q) {
        const services = browseDeferred(table)
        return services.length ? { services } : { notice: '本会话没有接入任何服务' }
      }
      const hits = searchDeferred(table, q)
      if (!hits.length) {
        const services = [...new Set(table.map((e) => e.serviceName))]
        return {
          notice: services.length
            ? `没有匹配的工具。本会话有这些服务：${services.join('、')}`
            : '没有匹配的工具，本会话没有接入任何服务'
        }
      }
      return {
        tools: hits.map((e) => ({ name: e.key, description: e.description, parameters: e.inputSchema }))
      }
    }
  })
}

// ── tool_invoke ──────────────────────────────────────────────────
const INVOKE_DESCRIPTION = `调用一个用 tool_search 找到的工具。name 填查找结果里的工具名，arguments 按该工具的参数定义填。
名字不存在会返回说明，先用 tool_search 确认名字；参数缺项或类型不符会返回该工具的完整定义，照着改正后重调。`

const TYPE_OK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === 'object' && !Array.isArray(v)
}

// 只查顶层：required 里的键都在，每个键的值类型与 properties[key].type 一致。嵌套结构交给服务自己校验
export function validateArgs(entry: DeferredTool, args: Record<string, unknown>): string | null {
  const schema = entry.inputSchema
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const missing = required.filter((k) => args[k] === undefined)
  if (missing.length) return `缺少必填参数：${missing.join('、')}`
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>
  for (const [k, v] of Object.entries(args)) {
    const want = props[k]?.type
    const types = Array.isArray(want) ? want : typeof want === 'string' ? [want] : []
    if (!types.length || v === null) continue
    if (!types.some((t) => TYPE_OK[t as string]?.(v) ?? true)) return `参数 ${k} 的类型应为 ${types.join(' 或 ')}`
  }
  return null
}

export function makeToolInvokeTool(opts: {
  table: DeferredTool[]
  signal: AbortSignal
  cards: CardQueue
  overflow: OverflowCtx
  onAuthPending: (toolCallId: string) => void // 弹卡前把调用行置 pending：渲染层靠它弹卡、禁用输入框
}): Tool {
  const { table, signal, cards, overflow, onAuthPending } = opts
  return tool({
    description: INVOKE_DESCRIPTION,
    inputSchema: jsonSchema<{ name: string; arguments: Record<string, unknown> }>({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'tool_search 返回的工具名' },
        arguments: { type: 'object', description: '按该工具的参数定义填' }
      },
      required: ['name']
    }),
    execute: async (input, { toolCallId }) => {
      const name = typeof input?.name === 'string' ? input.name : ''
      const entry = table.find((e) => e.key === name)
      if (!entry) return { error: `没有叫「${name}」的工具，先用 tool_search 确认名字` }
      const args = (input.arguments && typeof input.arguments === 'object' ? input.arguments : {}) as Record<string, unknown>
      const bad = validateArgs(entry, args)
      if (bad)
        return {
          error: `参数不符：${bad}`,
          tool: { name: entry.key, description: entry.description, parameters: entry.inputSchema }
        }
      // 分级授权与 makeMcpTools 时相同：服务开了信任只读声明且工具声明只读的直接执行，其余过卡片队列
      const trusted = getMcpService(entry.serviceId)?.trusted ?? false
      if (!(trusted && entry.readOnly)) {
        onAuthPending(toolCallId)
        const decision = await cards.request(toolCallId, signal, bareName(entry.fullName))
        if (decision === 'denied') return { denied: AUTH_DENIED }
        if (decision === 'aborted') return { interrupted: INTERRUPT_NOT_STARTED }
      }
      const r = await execMcpTool(entry.fullName, args, signal)
      if ('error' in r) return r
      return guardSingle(overflow, toolCallId, entry.fullName, r.text, r.structured)
    }
  })
}
