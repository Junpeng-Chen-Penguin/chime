// 模型登记表自检：拉一次 models.dev，核对解析与厂商 id 映射还成立。
// 对方改了 JSON 结构、或把某家的 id 改名，这里会先失败——不然只会表现为窗口悄悄退回预置值。
// 跑法：node eval/smoke/registry-smoke.mjs
const VENDORS = [
  { vendor: 'deepseek', registryId: 'deepseek', mustHave: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  { vendor: 'zhipu', registryId: 'zhipuai', mustHave: ['glm-5.2'] }
]

const res = await fetch('https://models.dev/api.json')
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const json = await res.json()

const contexts = {}
for (const v of VENDORS) {
  const models = json[v.registryId]?.models ?? {}
  for (const [id, m] of Object.entries(models)) {
    const ctx = m.limit?.context
    if (typeof ctx === 'number' && ctx > 0) contexts[`${v.vendor}:${id.toLowerCase()}`] = ctx
  }
}

let failed = 0
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failed++
    console.log(`  ✗ ${name}${detail ? `——${detail}` : ''}`)
  }
}

for (const v of VENDORS) {
  for (const id of v.mustHave) {
    const key = `${v.vendor}:${id}`
    check(`${key} 有窗口值`, contexts[key] > 0, `实际 ${contexts[key]}`)
  }
}
// 128K 是兜底值。所有条目都恰好等于它，多半是没解析到、退回了兜底
check(
  '解析结果不是清一色兜底值',
  Object.values(contexts).some((c) => c !== 131072),
  '全部等于 131072'
)
check('条目数不为零', Object.keys(contexts).length > 0)

console.log(`\n共 ${Object.keys(contexts).length} 个模型，${failed} 项未通过`)
process.exit(failed ? 1 : 0)
