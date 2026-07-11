// 一票否决冒烟 1：官方 MCP SDK 在本仓库环境下 connect + listTools + callTool 跑通
// 附带验证两个方案关键点：requestInit.headers 鉴权头真实到达服务端；无鉴权头得 401
// 运行：node eval/smoke/mcp-sdk-smoke.mjs
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 39199
const TOKEN = 'Bearer smoke-token'

// 服务端：无状态模式，每请求一对 server/transport（官方 stateless 范式）
const httpServer = http.createServer(async (req, res) => {
  if (req.headers['authorization'] !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
    return
  }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
  const server = new McpServer({ name: 'smoke', version: '0.0.1' })
  server.registerTool('ping', { description: '冒烟工具：回固定文本' }, async () => ({
    content: [{ type: 'text', text: 'pong' }]
  }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
})
await new Promise((r) => httpServer.listen(PORT, r))

const url = new URL(`http://127.0.0.1:${PORT}/mcp`)

// 反例先行：不带鉴权头应被拒
let unauthorized = false
try {
  const bad = new Client({ name: 'bad', version: '0.0.1' })
  await bad.connect(new StreamableHTTPClientTransport(url))
} catch {
  unauthorized = true
}
console.log('无鉴权头被拒（401）:', unauthorized ? 'OK' : 'FAIL')

// 正例：requestInit.headers 带 Bearer
const client = new Client({ name: 'chime-smoke', version: '0.0.1' })
await client.connect(
  new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: TOKEN } }
  })
)
const tools = await client.listTools()
console.log('listTools:', tools.tools.map((t) => t.name).join(','))
const result = await client.callTool({ name: 'ping', arguments: {} })
console.log('callTool:', JSON.stringify(result.content))
await client.close()
httpServer.close()

const pass =
  unauthorized && tools.tools.some((t) => t.name === 'ping') && result.content?.[0]?.text === 'pong'
console.log(pass ? 'SMOKE OK' : 'SMOKE FAIL')
process.exit(pass ? 0 : 1)
