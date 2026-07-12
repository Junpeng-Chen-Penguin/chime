// 假计费系统 MCP 服务：与真服务同能力六工具、回预设假数据（开发联调 + 评估陪跑，不入安装包）。
// 工具名为自拟（真清单到手后只改本文件常量）。
// 运行：node eval/fake-mcp/server.mjs [--port 39200] [--delay 3000]
//   鉴权：请求头须带 Authorization: Bearer fake-bill-token，配错即 401（认证失效联调用）
//   --delay：每个请求延迟 N 毫秒（慢服务联调用）
import http from 'node:http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const args = process.argv.slice(2)
const argOf = (name, dft) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dft
}
const PORT = Number(argOf('--port', 39200))
const DELAY = Number(argOf('--delay', 0))
const TOKEN = 'Bearer fake-bill-token'

// ── 预设假数据 ──────────────────────────────────────
const TENANTS = {
  A公司: { 授权状态: '生效中', 到期日: '2026-12-31', 版本: '专业版', 席位: 120 },
  B公司: { 授权状态: '已禁用', 到期日: '2026-08-15', 版本: '标准版', 席位: 45 },
  C公司: { 授权状态: '生效中', 到期日: '2027-03-01', 版本: '旗舰版', 席位: 300 }
}
const APPS = {
  A公司: [
    { 应用: '工单中心', 状态: '运行中', 上线日: '2025-06-01' },
    { 应用: '客户门户', 状态: '运行中', 上线日: '2025-09-12' }
  ],
  B公司: [{ 应用: '工单中心', 状态: '已停用', 上线日: '2025-03-20' }],
  C公司: [
    { 应用: '工单中心', 状态: '运行中', 上线日: '2024-11-05' },
    { 应用: '客户门户', 状态: '运行中', 上线日: '2025-01-18' },
    { 应用: '数据大屏', 状态: '运行中', 上线日: '2025-07-30' }
  ]
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const notFound = (name) => text(`未找到租户「${name}」，可用租户：${Object.keys(TENANTS).join('、')}`)
const tenantArg = z.string().describe('租户名称，如「A公司」')

// 数据导出：约 50 万字的假账单明细（Case 5 超限联调）
function bigExport(scope) {
  const rows = []
  for (let i = 0; i < 8000; i++) {
    const t = Object.keys(TENANTS)[i % 3]
    rows.push(
      `账单 ${String(i + 1).padStart(6, '0')} | 租户 ${t} | 周期 2026-${String((i % 12) + 1).padStart(2, '0')} | ` +
        `项目 ${['席位订阅', '流量包', '增值服务', '技术支持'][i % 4]} | 金额 ${(((i * 137) % 9000) + 1000).toFixed(2)} 元 | ` +
        `状态 ${['已结清', '待支付', '已核销'][i % 3]}`
    )
  }
  return `数据导出（范围：${scope}）\n${rows.join('\n')}`
}

// ── 六工具注册 ──────────────────────────────────────
function buildServer() {
  const server = new McpServer({ name: 'fake-bill-system', version: '0.5.0' })

  server.registerTool(
    'query_tenant_auth',
    {
      description: '查询指定租户的授权信息：授权状态、到期日、版本、席位数。只读。',
      inputSchema: { tenant_name: tenantArg },
      outputSchema: {
        授权状态: z.string(),
        到期日: z.string(),
        版本: z.string(),
        席位: z.number()
      }
    },
    async ({ tenant_name }) => {
      const t = TENANTS[tenant_name]
      if (!t) return notFound(tenant_name)
      return { content: [{ type: 'text', text: JSON.stringify(t) }], structuredContent: t }
    }
  )

  server.registerTool(
    'manage_tenant_auth',
    {
      description: '禁用或解禁指定租户的授权。写操作，会改变租户的服务可用性。',
      inputSchema: {
        tenant_name: tenantArg,
        action: z.enum(['disable', 'enable']).describe('disable=禁用，enable=解禁')
      }
    },
    async ({ tenant_name, action }) => {
      const t = TENANTS[tenant_name]
      if (!t) return notFound(tenant_name)
      t.授权状态 = action === 'disable' ? '已禁用' : '生效中'
      return text(`已${action === 'disable' ? '禁用' : '解禁'}租户「${tenant_name}」的授权，当前状态：${t.授权状态}`)
    }
  )

  server.registerTool(
    'report_renewal',
    {
      description: '为指定租户提交一条续签汇报记录。写操作。',
      inputSchema: {
        tenant_name: tenantArg,
        note: z.string().describe('汇报内容，如续签意向、金额、周期')
      }
    },
    async ({ tenant_name, note }) => {
      if (!TENANTS[tenant_name]) return notFound(tenant_name)
      return text(`已提交租户「${tenant_name}」的续签汇报：${note ?? '（无内容）'}`)
    }
  )

  server.registerTool(
    'update_delivery_config',
    {
      description: '更新指定租户的交付设置（如交付日期）。写操作。',
      inputSchema: {
        tenant_name: tenantArg,
        delivery_date: z.string().describe('交付日期，格式 YYYY-MM-DD')
      }
    },
    async ({ tenant_name, delivery_date }) => {
      if (!TENANTS[tenant_name]) return notFound(tenant_name)
      return text(`已更新租户「${tenant_name}」的交付日期为 ${delivery_date}`)
    }
  )

  server.registerTool(
    'query_applications',
    {
      description: '查询指定租户开通的应用列表：应用名、状态、上线日期。只读。',
      inputSchema: { tenant_name: tenantArg }
    },
    async ({ tenant_name }) => {
      const apps = APPS[tenant_name]
      if (!apps) return notFound(tenant_name)
      return text(JSON.stringify(apps, null, 2))
    }
  )

  server.registerTool(
    'export_billing_data',
    {
      description: '导出账单明细数据。返回量很大，仅在用户明确要求导出全量数据时使用。只读。',
      inputSchema: { scope: z.string().describe('导出范围描述，如「2026 年全部账单」') }
    },
    async ({ scope }) => text(bigExport(scope ?? '全部'))
  )

  return server
}

// ── HTTP 入口（无状态模式：每请求一对 server/transport）──
const httpServer = http.createServer(async (req, res) => {
  if (req.headers['authorization'] !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
  // 延迟只作用于工具调用（模拟慢执行），握手与清单不拖——否则连接层直接超时
  if (DELAY && body?.method === 'tools/call') await new Promise((r) => setTimeout(r, DELAY))
  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
})
httpServer.listen(PORT, () => {
  console.log(`假计费系统 MCP 已启动：http://127.0.0.1:${PORT}/mcp（延迟 ${DELAY}ms）`)
  console.log(`录入时认证请求头：Authorization = ${TOKEN}`)
})
