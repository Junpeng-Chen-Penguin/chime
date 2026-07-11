// 一票否决冒烟 2：streamText 的工具 execute 长时间挂起（等卡场景）后 resolve，
// 验证 SDK 能正常续步、事件流完整、DeepSeek 接受含 tool 消息的续跑请求。
// 挂起期间模型请求已结束，等待纯在本地——这里用定时器模拟「用户过了很久才点卡片」。
// 运行：node eval/smoke/execute-suspend-smoke.mjs [挂起秒数，默认 600]
// 配置经环境变量传入（仓库 better-sqlite3 为 Electron 编译，纯 node 脚本读不了库）：
// eval $(sqlite3 ~/Library/Application\ Support/chime/chime.db \
//   "SELECT 'export CHIME_API_KEY='||api_key||' CHIME_BASE_URL='||base_url||' CHIME_MODEL='||default_model FROM provider") \
//   && node eval/smoke/execute-suspend-smoke.mjs
import { streamText, tool, jsonSchema, stepCountIs } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

const SUSPEND_S = Number(process.argv[2] ?? 600)

const p = {
  api_key: process.env.CHIME_API_KEY,
  base_url: process.env.CHIME_BASE_URL || 'https://api.deepseek.com',
  default_model: process.env.CHIME_MODEL
}
if (!p.api_key || !p.default_model) {
  console.error('缺 CHIME_API_KEY / CHIME_MODEL 环境变量')
  process.exit(1)
}

const provider = createOpenAICompatible({
  name: 'chime-smoke',
  baseURL: p.base_url.trim().replace(/\/+$/, ''),
  apiKey: p.api_key,
  includeUsage: true
})

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`
let resolvedAt = null

const result = streamText({
  model: provider(p.default_model),
  instructions: '你有一个 ask_user 工具。先调用它一次，拿到回复后用一句话复述回复内容并结束。',
  messages: [{ role: 'user', content: '请问我一个问题' }],
  tools: {
    ask_user: tool({
      description: '向用户提一个问题并等待回复。返回用户的回复文本。',
      inputSchema: jsonSchema({
        type: 'object',
        properties: { question: { type: 'string', description: '要问的问题' } },
        required: ['question']
      }),
      execute: async ({ question }) => {
        console.log(ts(), 'execute 开始挂起，问题：', question)
        await new Promise((r) => setTimeout(r, SUSPEND_S * 1000))
        resolvedAt = ts()
        console.log(resolvedAt, '挂起结束，返回回复')
        return '用户回复：一切正常，请继续。'
      }
    })
  },
  stopWhen: stepCountIs(4)
})

const events = []
let finalText = ''
for await (const part of result.fullStream) {
  events.push(part.type)
  if (part.type === 'text-delta') finalText += part.text
  if (part.type === 'error') console.error(ts(), 'ERROR:', part.error)
}

const steps = await result.steps
console.log(ts(), '步数:', steps.length, '| 事件种类:', [...new Set(events)].join(','))
console.log('最终回答:', finalText.trim().slice(0, 200))

const pass =
  resolvedAt !== null &&
  steps.length >= 2 &&
  events.includes('tool-result') &&
  finalText.trim().length > 0 &&
  !events.includes('error')
console.log(pass ? `SMOKE OK（挂起 ${SUSPEND_S}s 后续跑成功）` : 'SMOKE FAIL')
process.exit(pass ? 0 : 1)
