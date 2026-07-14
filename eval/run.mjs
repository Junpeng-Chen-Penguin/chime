// Chime 行为评估：预置环境 → 逐用例经无界面入口执行 → 结构断言（程序判）→ 内容质量（模型判）→ 报告
// 用法：node eval/run.mjs [--dir <隔离数据目录>]
// 模型服务配置：优先环境变量 CHIME_EVAL_KEY / CHIME_EVAL_BASE_URL / CHIME_EVAL_MODEL，
// 缺省时从本机真实 Chime 配置读取（只读）。开发工具，不入安装包。

import { execFileSync, spawn, spawnSync } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REAL_USERDATA = join(homedir(), 'Library/Application Support/chime')
const argDir = process.argv.indexOf('--dir')
const DATA_DIR = argDir >= 0 ? resolve(process.argv[argDir + 1]) : join(tmpdir(), 'chime-eval')

// ── 模型服务配置（密钥只进环境变量，不落文件） ──────────────────────────
const sq = (sql) =>
  execFileSync('sqlite3', [join(REAL_USERDATA, 'chime.db'), sql], { encoding: 'utf8' }).trim()
const KEY = process.env.CHIME_EVAL_KEY || sq('SELECT api_key FROM provider WHERE id=1;')
const BASE = process.env.CHIME_EVAL_BASE_URL || sq('SELECT base_url FROM provider WHERE id=1;')
const MODEL = process.env.CHIME_EVAL_MODEL || sq('SELECT default_model FROM provider WHERE id=1;')
if (!KEY) {
  console.error('缺少模型服务密钥：设 CHIME_EVAL_KEY 或先在 Chime 设置里配置')
  process.exit(1)
}

// ── 环境预置：先构建产物（electron 跑的是 out/ 里的构建结果，不建就是在测旧代码）──
console.log('构建产物…')
execFileSync(join(ROOT, 'node_modules/.bin/electron-vite'), ['build'], { cwd: ROOT, stdio: 'ignore' })

// ── 隔离目录 + 模型缓存复制 + 测试知识库（git 仓库） ────────────
mkdirSync(DATA_DIR, { recursive: true })
if (!existsSync(join(DATA_DIR, 'models')) && existsSync(join(REAL_USERDATA, 'models'))) {
  console.log('预置：复制本地模型缓存…')
  cpSync(join(REAL_USERDATA, 'models'), join(DATA_DIR, 'models'), { recursive: true })
}
const KB_REPO = join(DATA_DIR, 'kb-repo')
rmSync(KB_REPO, { recursive: true, force: true })
cpSync(join(ROOT, 'eval/fixtures/kb-docs'), KB_REPO, { recursive: true })
const git = (...a) => execFileSync('git', ['-C', KB_REPO, ...a], { stdio: 'ignore' })
git('init', '-q')
git('add', '-A')
git('-c', 'user.email=eval@chime', '-c', 'user.name=eval', 'commit', '-qm', 'fixture')

// ── 假 MCP 服务陪跑（Case 7）：评估自起自停，端口与联调环境分开 ─────────────
const MCP_PORT = 39210
const MCP_SPEC = [
  { name: '计费系统', url: `http://127.0.0.1:${MCP_PORT}/mcp`, headers: { Authorization: 'Bearer fake-bill-token' } }
]
const fakeMcp = spawn('node', [join(ROOT, 'eval/fake-mcp/server.mjs'), '--port', String(MCP_PORT)], {
  stdio: 'ignore'
})
process.on('exit', () => fakeMcp.kill())
for (let i = 0; i < 30; i++) {
  try {
    await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: 'POST' })
    break
  } catch {
    await new Promise((r) => setTimeout(r, 200))
  }
}

// ── 逐用例执行 ────────────────────────────────────────────────────────
const CASES_DIR = join(ROOT, 'eval/cases')
const RESOLVED_DIR = join(DATA_DIR, 'cases-resolved')
mkdirSync(RESOLVED_DIR, { recursive: true })
const KB_SPEC = { repo: KB_REPO, name: '计费系统', intro: '本库收录计费、退款等业务规则与流程说明' }

function runCase(file) {
  const spec = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'))
  const resolved = { ...spec, kb: spec.kb === true ? KB_SPEC : spec.kb, mcp: spec.mcp === true ? MCP_SPEC : spec.mcp }
  const resolvedPath = join(RESOLVED_DIR, file)
  writeFileSync(resolvedPath, JSON.stringify(resolved))
  const t0 = Date.now()
  const r = spawnSync(
    join(ROOT, 'node_modules/.bin/electron'),
    ['.', '--data-dir', DATA_DIR, '--eval', resolvedPath],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, CHIME_ENGINE_KEY: KEY, CHIME_ENGINE_BASE_URL: BASE, CHIME_ENGINE_MODEL: MODEL }
    }
  )
  if (r.status !== 0) throw new Error(`执行失败：${(r.stderr || '').slice(0, 300)}`)
  const events = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l))
  return { spec, events, ms: Date.now() - t0 }
}

// 按轮拆事件 → 提取断言素材
function turnFacts(events, streamId) {
  const evs = events.filter((e) => e.streamId === streamId)
  const items = []
  for (const e of evs) if (e.type === 'item-done') items[e.index] = e.item
  const done = evs.find((e) => e.type === 'turn-done')
  const tools = items.filter((i) => i?.t === 'tool')
  const searches = tools.filter((t) => t.name === 'search_knowledge_base')
  const texts = items.filter((i) => i?.t === 'text' && i.text.trim())
  const sources = items.find((i) => i?.t === 'sources')
  const answer = texts.map((t) => t.text).join('\n') // 全部模型文字（中途叙述也不许漏内部机制）
  const finalAnswer = texts.at(-1)?.text ?? ''
  const mcpNames = tools.filter((t) => t.name?.startsWith('mcp__')).map((t) => t.name)
  const artifact = items.find((i) => i?.t === 'artifact')
  const cardActions = evs.filter((e) => e.type === 'card-answered').map((e) => e.action)
  const fetched = tools.some((t) => t.name === 'grep_result' || t.name === 'read_result')
  const overflowStored = tools.some((t) => t.resultRef)
  // 提问卡问答记录：判分材料用（问答发生在卡片里，不在回答文本里）
  const askRecords = tools
    .filter((t) => t.ask)
    .map((t) => {
      const qs = (t.args?.questions ?? []).map((q) => q.question).join('；')
      const as = (t.ask.answers ?? []).map((a) => `${a.question}=${a.answer ?? '未回答'}`).join('；')
      return `提问（${qs}）→ ${t.ask.state === 'answered' ? `用户回答：${as}` : t.ask.state === 'skipped' ? '用户放弃回答' : '未回应'}`
    })
  return { status: done?.status, tools, searches, answer, finalAnswer, sources, mcpNames, artifact, cardActions, fetched, overflowStored, askRecords }
}

// ── 两层判分 ──────────────────────────────────────────────────────────
function structural(expect, f) {
  const fails = []
  if (f.status !== 'done') fails.push(`轮次状态 ${f.status}`)
  if (expect.searched === true && f.searches.length === 0) fails.push('应检索而未检索')
  if (expect.searched === false && f.searches.length > 0) fails.push('不应检索却检索了')
  if (f.searches.length > 3) fails.push(`检索 ${f.searches.length} 次超上限`)
  if (expect.sources === true && !f.sources) fails.push('应有来源清单而没有')
  if (expect.sources === false && f.sources) fails.push('不应有来源清单却有')
  if (expect.citedValid) {
    const ns = [...f.finalAnswer.matchAll(/\[(\d+)\]/g)].map((m) => +m[1])
    const pool = new Set((f.sources?.list ?? []).map((s) => s.n))
    if (ns.length === 0) fails.push('回答没有 [n] 引用')
    else if (!ns.every((n) => pool.has(n))) fails.push('存在指向不存在资料的引用编号')
  }
  // ── v0.5.0：MCP / 卡片 / 超限 / 制品 ──
  if (expect.mcpCalled && !f.mcpNames.some((n) => n.includes(expect.mcpCalled)))
    fails.push(`应调用 ${expect.mcpCalled} 而未调用（实际：${f.mcpNames.join(',') || '无'}）`)
  if (expect.mcpNotCalled && f.mcpNames.some((n) => n.includes(expect.mcpNotCalled)))
    fails.push(`不应调用 ${expect.mcpNotCalled} 却调用了`)
  if (expect.cardsInclude) {
    // 代答动作按序包含（宽松：允许中间有其他卡）
    let at = 0
    for (const want of expect.cardsInclude) {
      const idx = f.cardActions.indexOf(want, at)
      if (idx < 0) {
        fails.push(`代答记录缺少 ${want}（实际：${f.cardActions.join(',') || '无'}）`)
        break
      }
      at = idx + 1
    }
  }
  if (expect.artifact === true && !f.artifact) fails.push('应生成制品而未生成')
  if (expect.artifact === false && f.artifact) fails.push('不应生成制品却生成了')
  if (expect.overflowStored === true && !f.overflowStored) fails.push('应触发超限落库而未触发')
  if (expect.fetched === true && !f.fetched) fails.push('应自主取数而未取数')
  if (expect.noInternalRefs && /结果 ?#|结果编号|查结果集/.test(f.answer))
    fails.push('模型文字里出现了内部机制词汇')
  return fails
}

async function judge(criteria, f) {
  const material = (f.sources?.list ?? [])
    .map((s) => `[${s.n}] ${s.filePath}\n${s.content}`)
    .join('\n\n')
  // 交互记录：卡片里的问答与授权动作不在回答文本里，单独交给评估员
  const interactions = [
    ...f.askRecords,
    ...(f.cardActions.length ? [`授权/提问代答动作序列：${f.cardActions.join(' → ')}`] : []),
    ...(f.mcpNames.length ? [`本轮发起的外部调用：${f.mcpNames.join('、')}`] : [])
  ].join('\n')
  const prompt = [
    '你是评估员。根据检索资料与交互记录判断 AI 回答是否满足判定标准，只输出 JSON：{"pass": true/false, "reason": "一句话"}',
    `判定标准：${criteria}`,
    `检索资料：\n${material || '（本轮无资料）'}`,
    `交互记录：\n${interactions || '（本轮无卡片交互）'}`,
    `AI 回答：\n${f.answer}`
  ].join('\n\n')
  const res = await fetch(`${BASE.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], stream: false })
  })
  const txt = (await res.json()).choices?.[0]?.message?.content ?? ''
  const m = txt.match(/\{[\s\S]*\}/)
  if (!m) return { pass: false, reason: `判分输出无法解析：${txt.slice(0, 80)}` }
  return JSON.parse(m[0])
}

// ── 主流程与报告 ──────────────────────────────────────────────────────
const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort()
let passCount = 0
const lines = []
for (const file of files) {
  let ok = true
  const reasons = []
  try {
    const { spec, events, ms } = runCase(file)
    for (let i = 0; i < spec.messages.length; i++) {
      const expect = spec.expect?.[i] ?? {}
      const f = turnFacts(events, `t${i + 1}`)
      const fails = structural(expect, f)
      if (fails.length) {
        ok = false
        reasons.push(`第 ${i + 1} 轮结构断言：${fails.join('；')}`)
      }
      if (expect.judge) {
        const v = await judge(expect.judge, f)
        if (!v.pass) {
          ok = false
          reasons.push(`第 ${i + 1} 轮质量判分：${v.reason}`)
        }
      }
    }
    lines.push(`${ok ? '✅' : '❌'} ${file}（${(ms / 1000).toFixed(1)}s）${reasons.length ? '\n   ' + reasons.join('\n   ') : ''}`)
  } catch (e) {
    ok = false
    lines.push(`❌ ${file}\n   ${e.message}`)
  }
  if (ok) passCount++
}

console.log('\n── 评估报告 ──────────────────────')
for (const l of lines) console.log(l)
console.log(`\n通过 ${passCount} / ${files.length}`)
process.exit(passCount === files.length ? 0 : 1)
