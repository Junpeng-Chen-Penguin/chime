// MCP 连接层：每个已启用服务一个官方 SDK Client，连接成功后拉工具清单缓存住。
// 对话组装只读缓存，不现场请求服务；清单变更通知到达时重拉。
// 失败语义从简：调用失败标脏、下次调用前重连；缓存不持久化，启动连不上即当次「服务不可用」。

import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { listMcpServices, type McpServiceRow } from '../db'

// SDK 默认 60s 对数据导出类工具不足；有进度通知时重置计时
export const MCP_CALL_TIMEOUT_MS = 120_000

export type McpServiceStatus = 'connected' | 'error' | 'auth'

export interface McpToolInfo {
  serviceId: number
  serviceName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

interface ServiceState {
  config: McpServiceRow
  client: Client | null
  tools: McpToolInfo[]
  instructions: string // 服务级说明（握手返回，011 Case 6）；未声明为空串
  status: McpServiceStatus
  error?: string
  dirty: boolean // 调用失败后置位，下次调用前重连
}

const states = new Map<number, ServiceState>()

// 状态变更回调（设置页「认证失效」标识的通道），index.ts 注册
let statusListener: (() => void) | null = null
export function onMcpStatusChange(cb: () => void): void {
  statusListener = cb
}
const notify = (): void => statusListener?.()

// 认证失效识别：优先看 HTTP 状态码（StreamableHTTPError.code），报错文本仅兜底
function isAuthError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code
  if (code === 401 || code === 403) return true
  return /\b40[13]\b|unauthorized/i.test(String((e as Error)?.message ?? e))
}

function shortMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200)
}

function makeClient(config: McpServiceRow): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: 'chime', version: app.getVersion() })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers }
  })
  return { client, transport }
}

async function refreshTools(st: ServiceState): Promise<void> {
  if (!st.client) return
  const { tools } = await st.client.listTools()
  st.tools = tools.map((t) => ({
    serviceId: st.config.id,
    serviceName: st.config.name,
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema as Record<string, unknown>,
    outputSchema: t.outputSchema as Record<string, unknown> | undefined,
    annotations: t.annotations as Record<string, unknown> | undefined
  }))
}

async function doConnect(st: ServiceState): Promise<void> {
  await st.client?.close().catch(() => {})
  st.client = null
  st.tools = []
  try {
    const { client, transport } = makeClient(st.config)
    await client.connect(transport)
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void refreshTools(st)
        .then(notify)
        .catch(() => {
          st.dirty = true
        })
    })
    st.client = client
    st.instructions = client.getInstructions()?.trim() ?? ''
    await refreshTools(st)
    st.status = 'connected'
    st.dirty = false
    st.error = undefined
  } catch (e) {
    st.client = null
    st.status = isAuthError(e) ? 'auth' : 'error'
    st.error = shortMessage(e)
  }
  notify()
}

// 与库中配置对齐：启用的连上、停用与删除的断开。应用启动与设置变更后调用。
export async function syncMcpServices(): Promise<void> {
  const rows = listMcpServices()
  const seen = new Set<number>()
  const pending: Promise<void>[] = []
  for (const row of rows) {
    seen.add(row.id)
    if (!row.enabled) {
      const st = states.get(row.id)
      if (st) {
        void st.client?.close().catch(() => {})
        states.delete(row.id)
      }
      continue
    }
    const st = states.get(row.id)
    const configChanged = st && JSON.stringify(st.config) !== JSON.stringify(row)
    if (!st || configChanged || st.status !== 'connected') {
      const next: ServiceState = { config: row, client: st?.client ?? null, tools: [], instructions: '', status: 'error', dirty: false }
      states.set(row.id, next)
      pending.push(doConnect(next))
    }
  }
  for (const [id, st] of states) {
    if (!seen.has(id)) {
      void st.client?.close().catch(() => {})
      states.delete(id)
    }
  }
  await Promise.allSettled(pending)
}

// 对话组装读这里：全部已连接服务的缓存清单
export function getMcpToolList(): McpToolInfo[] {
  const out: McpToolInfo[] = []
  for (const st of states.values()) {
    if (st.status === 'connected') out.push(...st.tools)
  }
  return out
}

// 对话组装读这里（011 Case 6）：所选服务中已连接、有工具、且声明了 instructions 的
export function getMcpInstructions(selected: Set<number>): { name: string; instructions: string }[] {
  const out: { name: string; instructions: string }[] = []
  for (const st of states.values()) {
    if (!selected.has(st.config.id)) continue
    if (st.status !== 'connected' || !st.tools.length || !st.instructions) continue
    out.push({ name: st.config.name, instructions: st.instructions })
  }
  return out
}

export interface McpServiceRuntime {
  status: McpServiceStatus
  error?: string
  toolCount: number
}

export function getMcpServiceRuntime(id: number): McpServiceRuntime | null {
  const st = states.get(id)
  return st ? { status: st.status, error: st.error, toolCount: st.tools.length } : null
}

export interface McpCallResult {
  content?: unknown
  structuredContent?: unknown
  isError?: boolean
}

export async function callMcpTool(
  serviceId: number,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpCallResult> {
  const st = states.get(serviceId)
  if (!st) throw new Error('服务未启用')
  if (st.dirty || !st.client || st.status !== 'connected') await doConnect(st)
  if (!st.client || st.status !== 'connected') throw new Error(st.error ?? '服务连接失败')
  try {
    return (await st.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: MCP_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      signal
    })) as McpCallResult
  } catch (e) {
    if (isAuthError(e)) {
      st.status = 'auth'
      st.error = '认证失效'
      notify()
    } else {
      st.dirty = true
    }
    throw e
  }
}

// 测试连接：临时建 Client、握手、拉清单、关闭；不影响正式连接池
export async function testMcpConnection(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; toolNames?: string[]; error?: string; auth?: boolean }> {
  let client: Client | null = null
  try {
    const made = makeClient({ id: 0, name: 'test', url, headers, enabled: true })
    client = made.client
    await client.connect(made.transport)
    const { tools } = await client.listTools()
    return { ok: true, toolNames: tools.map((t) => t.name) }
  } catch (e) {
    return { ok: false, error: shortMessage(e), auth: isAuthError(e) }
  } finally {
    await client?.close().catch(() => {})
  }
}

// before-quit 与 headless 用例结束时调用，否则 SSE 长连接拖住进程不退出
export async function closeAllMcp(): Promise<void> {
  await Promise.allSettled([...states.values()].map((s) => s.client?.close()))
  states.clear()
}
