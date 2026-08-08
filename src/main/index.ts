import { app, shell, BrowserWindow, Menu, protocol, net } from 'electron'
import { join, dirname, resolve } from 'path'
import { appendFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { tmpdir } from 'os'
import {
  initDb,
  migrateSecrets,
  getDefaultModelRef,
  saveProvider,
  createConversation,
  getMessages,
  setConversationKbSelection,
  listKbs as listKbsDb,
  listMcpServices,
  saveMcpService
} from './db'
import { unseal } from './secret'
import { registerIpc } from './ipc'
import { syncMcpServices, onMcpStatusChange, closeAllMcp } from './mcp/client'

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 720,
    minWidth: 1160, // 三栏全开下限（256+480+380）+ 卡片边距与间距 32，留余量
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Chime',
    backgroundColor: '#e8e8e5',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 24 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true // preload 只用 ipcRenderer，无需 Node 权限
    }
  })

  // 全屏时红绿灯隐藏，通知界面调整左上角内边距（收起态不再为红绿灯留空）。
  // 启动时就在全屏（系统记住上次状态）不会触发 enter-full-screen，show 时补发一次
  const sendFs = (v: boolean): void => mainWindow.webContents.send('window:fullscreen', v)
  mainWindow.on('enter-full-screen', () => sendFs(true))
  mainWindow.on('leave-full-screen', () => sendFs(false))

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    sendFs(mainWindow.isFullScreen())
  })

  // 页面缩放锁死 100%：Electron 会按站点持久化用户缩放（Cmd+= 一次就长期偏大），
  // 与 Tuner 的界面一致性依赖两边都不缩放
  mainWindow.webContents.on('did-finish-load', () => mainWindow.webContents.setZoomLevel(0))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // 只放行 http(s)，防 file: / 自定义协议被系统打开
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 兜底：窗口永不导航离开应用页面（渲染层 preventDefault 之外的第二道防线）
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

// 独立数据目录（环境隔离）：--data-dir 与测试钩子都须先于单实例锁——锁按数据目录区分，
// 否则开着 Chime 就跑不了评估 / 测试
const dataDirFlag = ((): string | null => {
  const eq = process.argv.find((a) => a.startsWith('--data-dir='))
  if (eq) return eq.slice('--data-dir='.length)
  const i = process.argv.indexOf('--data-dir')
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
})()
if (dataDirFlag) {
  app.setPath('userData', resolve(dataDirFlag))
}

// 未预期异常兜底：落日志（userData/error.log）便于排查，不静默也不弹系统崩溃框
const logFatal = (kind: string, e: unknown): void => {
  const line = `[${new Date().toISOString()}] ${kind}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
  try {
    appendFileSync(join(app.getPath('userData'), 'error.log'), line)
  } catch {
    // 日志写不进也不能再抛
  }
  console.error(line)
}
process.on('uncaughtException', (e) => logFatal('uncaughtException', e))
process.on('unhandledRejection', (e) => logFatal('unhandledRejection', e))
if (process.env.CHIME_ENGINE_TEST) {
  app.setPath('userData', join(tmpdir(), 'chime-engine-test'))
}
if (process.env.CHIME_TOOL_TEST) {
  app.setPath('userData', join(tmpdir(), 'chime-tool-test'))
}

// 单实例：重复启动时退出新实例、聚焦已有窗口（避免 dock 里出现多个）。
// 无界面评估/查询入口不占锁：隔离数据目录、随起随退；且强杀测试会留下残锁，占锁会被静默挡掉
if (
  !process.argv.includes('--eval') &&
  !process.argv.includes('--report') &&
  !app.requestSingleInstanceLock()
) {
  app.exit(0)
}

// 文档内相对路径图片的自定义协议（须在 app ready 前注册 privileged）
protocol.registerSchemesAsPrivileged([
  { scheme: 'chime-doc', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// 无界面评估入口：--eval <case.json>，不建窗口，按用例驱动 engine，事件以 JSONL 写 stdout
const evalCasePath = ((): string | null => {
  const i = process.argv.indexOf('--eval')
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
})()

// 无界面模式不占 Dock：tuner 并发驱动时会同时跑多个评估进程，逐个冒图标很扰人
if (evalCasePath || process.argv.includes('--report')) app.dock?.hide()

app.whenReady().then(() => {
  // 可测性查询入口：--report，自报版本、代码版本与模型服务配置（供 tuner 等外部工具使用）。
  // 只读打开数据库（不走建表迁移，避免对运行中的主实例写打开），输出一段 JSON 后退出
  if (process.argv.includes('--report')) {
    void (async () => {
      try {
        const { default: Database } = await import('better-sqlite3')
        // 多服务商报告（Case 13）：vendors 含各家启用态与勾选模型；kbs / mcpServices 供 Tuner 预检（Case 10）
        interface VendorReport {
          vendor: string
          apiKey: string | null
          baseUrl: string
          enabled: boolean
          models: string[]
        }
        let vendors: VendorReport[] = []
        let defaultModel: string | null = null
        let kbs: { name: string; ready: boolean }[] = []
        // url/headers（明文）供 Tuner 直调工具通道使用（011 Case 8：reset/setup/重放不经模型）——
        // Tuner 与 Chime 同机同用户，凭据本就经 --report 的 vendors 明文交给 Tuner（Case 13 同一信任边界）
        let mcpServices: { name: string; enabled: boolean; url?: string; headers?: Record<string, string> }[] = []
        try {
          const rdb = new Database(join(app.getPath('userData'), 'chime.db'), {
            readonly: true,
            fileMustExist: true
          })
          try {
            const rows = rdb.prepare('SELECT vendor, api_key, base_url, enabled, models FROM provider').all() as {
              vendor: string
              api_key: string
              base_url: string
              enabled: number
              models: string
            }[]
            vendors = rows.map((r) => {
              let picked: string[] = []
              try {
                picked = (JSON.parse(r.models) as { id: string; picked: boolean }[]).filter((m) => m.picked).map((m) => m.id)
              } catch {
                // 坏数据按空
              }
              // 这里绕开 db.ts 直读只读连接，解密要自己来
              return { vendor: r.vendor, apiKey: unseal(r.api_key) || null, baseUrl: r.base_url, enabled: !!r.enabled, models: picked }
            })
            const dm = rdb.prepare("SELECT value FROM settings WHERE key = 'default_model'").get() as { value: string } | undefined
            defaultModel = dm?.value ?? null
          } catch {
            // 旧库结构：按未配置处理
          }
          try {
            kbs = (rdb.prepare('SELECT name, indexed_at FROM kb').all() as { name: string; indexed_at: number | null }[]).map(
              (k) => ({ name: k.name, ready: !!k.indexed_at })
            )
          } catch {
            // 旧库无多库表
          }
          try {
            const { unseal } = await import('./secret')
            mcpServices = (
              rdb.prepare('SELECT name, enabled, url, headers FROM mcp_service').all() as {
                name: string
                enabled: number
                url: string
                headers: string
              }[]
            ).map((m) => {
              let headers: Record<string, string> = {}
              try {
                headers = JSON.parse(unseal(m.headers) || '{}') as Record<string, string>
              } catch {
                // 解密失败按无认证处理（直调时服务端会拒，错误可见）
              }
              return { name: m.name, enabled: !!m.enabled, url: m.url, headers }
            })
          } catch {
            // 旧库无 mcp_service 表
          }
          rdb.close()
        } catch {
          // 库不存在：按未配置处理
        }
        const { execFileSync } = await import('child_process')
        const git = (args: string[]): string | null => {
          try {
            return execFileSync('git', args, { cwd: app.getAppPath(), encoding: 'utf8' }).trim()
          } catch {
            return null // 非 git 环境（如打包分发形态）拿不到就置空
          }
        }
        // 旧字段兼容（Tuner 换版期）：以默认模型所属服务商拼单套形状
        const defVendor = defaultModel?.includes(':') ? defaultModel.slice(0, defaultModel.indexOf(':')) : 'deepseek'
        const defRow = vendors.find((v) => v.vendor === defVendor) ?? vendors[0]
        process.stdout.write(
          JSON.stringify({
            appVersion: app.getVersion(),
            gitCommit: git(['rev-parse', 'HEAD']),
            dirty: (git(['status', '--porcelain']) ?? '') !== '',
            vendors,
            defaultModel,
            kbs,
            mcpServices,
            baseUrl: defRow?.baseUrl ?? 'https://api.deepseek.com',
            apiKey: defRow?.apiKey ?? null,
            models: defRow?.models ?? [],
            modelsError: null,
            kbReady: kbs.some((k) => k.ready),
            mcpEnabledCount: mcpServices.filter((m) => m.enabled).length
          }) + '\n'
        )
        app.exit(0)
      } catch (e) {
        process.stderr.write(`[report] ERROR ${String(e)}\n`)
        app.exit(1)
      }
    })()
    return
  }

  if (evalCasePath) {
    void (async () => {
      try {
        initDb()
        const { readFileSync } = await import('fs')
        const spec = JSON.parse(readFileSync(resolve(evalCasePath), 'utf8')) as {
          // true = 库内全部现成配置（环境快照）；string[] = 按名选用快照中的库/服务（Tuner 用例 env，Case 10）
          kb?: { repo: string; name: string; intro: string } | string[] | true
          // 元素 string = 按名选用；对象 = 按名选用并覆盖 headers（url 缺省取快照原值，Case 6）
          mcp?: (string | { name: string; url?: string; headers?: Record<string, string> })[] | true
          setup?: { tool: string; args?: Record<string, unknown> }[] // 前置动作（Case 12）：首轮前直接调工具，不经模型不弹卡
          model?: string
          messages: string[]
          conv?: string // 往既有会话续发（跨重启多轮自测）；缺省新建会话
          mcpSelected?: boolean // Case 8：false = 服务启用但本会话未选用；缺省 = 声明的服务全部选入
          stopAfterMs?: number // 停止路径自测：每轮开跑后定时触发停止（同用户点停止）
          // 前置条件与策略（v1.1.1）：授权按策略消费（缺省全通过），提问按应答档案作答（缺省整卡跳过）
          policy?: {
            auth?: 'approve_all' | 'deny_all' | { approve: string[] } | { deny: { tool?: string; nth?: number }[] }
          }
          // agent 应答（011 Case 7）：messages 只含 opening 一条，消费完转 stdin 逐轮取下一句；
          // 提问卡经 ask-request 事件转模拟用户作答；EOF＝结束信号
          driver?: 'agent'
        }
        const { runTurn, stopTurn, REPAIR_TEXTS } = await import('./engine/orchestrator')
        // 统一归一（Case 6）：字符串元素 = {name}，与对象元素 {name, url?, headers?} 走同一条合并逻辑。
        // 语义 = "选入会话"：按名取快照库同名服务（地址原值），声明了 headers 就覆盖落库，
        // 未声明的服务不选入也不停用（会话范围由下方 mcpSelected 选择控制）；
        // 带 url 且库内无同名服务时新建（旧对象写法兼容）
        type McpDecl = { name: string; url?: string; headers?: Record<string, string> }
        const mcpDecls: McpDecl[] | null = Array.isArray(spec.mcp)
          ? (spec.mcp as unknown[]).map((x) => (typeof x === 'string' ? { name: x } : (x as McpDecl)))
          : null
        {
          const existing = listMcpServices()
          if (spec.mcp === true) {
            // 环境快照：库内服务原样
          } else if (mcpDecls) {
            for (const s of mcpDecls) {
              const found = existing.find((e) => e.name === s.name)
              if (!found) {
                if (!s.url) {
                  process.stderr.write(`[eval] ERROR MCP 服务「${s.name}」不存在或未启用\n`)
                  app.exit(1)
                  return
                }
                saveMcpService({ name: s.name, url: s.url, headers: s.headers ?? {}, enabled: true })
                continue
              }
              if (!found.enabled && !s.url && !s.headers) {
                process.stderr.write(`[eval] ERROR MCP 服务「${s.name}」不存在或未启用\n`)
                app.exit(1)
                return
              }
              // headers 声明即覆盖（同一快照先后跑不同身份不能串）；url 缺省取原值；headers 传 null 保持现值
              const needsUpdate =
                (s.url !== undefined && found.url !== s.url) || !found.enabled || s.headers !== undefined
              if (needsUpdate) {
                saveMcpService({
                  id: found.id,
                  name: s.name,
                  url: s.url ?? found.url,
                  headers: s.headers ?? null,
                  enabled: true
                })
              }
            }
          } else if (!spec.mcp) {
            // 没声明就停用全部服务：前一用例注册的服务不能泄漏进「无手段」类用例
            for (const e of existing) {
              if (e.enabled) saveMcpService({ id: e.id, name: e.name, url: e.url, headers: null, enabled: false })
            }
          }
        }
        await syncMcpServices()
        // 带库用例。kb === true（环境快照）：库内配置须已完成索引且 embed 模型匹配，
        // 否则报错退出——绝不触发重建（重建路径会对用户真实文档仓库执行 git pull）
        const kbByName = Array.isArray(spec.kb)
        if (spec.kb === true || kbByName) {
          const pool = kbByName
            ? listKbsDb().filter((k) => (spec.kb as string[]).includes(k.name))
            : listKbsDb().filter((k) => k.indexedAt)
          if (kbByName) {
            for (const name of spec.kb as string[]) {
              const row = listKbsDb().find((k) => k.name === name)
              if (!row) {
                process.stderr.write(`[eval] ERROR 知识库「${name}」不存在\n`)
                app.exit(1)
                return
              }
              if (!row.indexedAt) {
                process.stderr.write(`[eval] ERROR 知识库「${name}」尚未完成构建\n`)
                app.exit(1)
                return
              }
            }
          }
          if (pool.length === 0) {
            process.stderr.write('[eval] ERROR 没有已完成构建的知识库\n')
            app.exit(1)
            return
          }
          const { EMBED_MODEL_ID } = await import('./model')
          if (pool.some((k) => k.embedModel && k.embedModel !== EMBED_MODEL_ID)) {
            process.stderr.write('[eval] ERROR 知识库索引与当前 embed 模型不匹配，请在正式 Chime 重建索引\n')
            app.exit(1)
            return
          }
        } else if (spec.kb) {
          // 对象形式（Chime 自测夹具）：按名定位库行（无则建），未就绪或路径不同才构建（预置过则秒过）
          const { listKbs, createKb, updateKb } = await import('./db')
          const kbSpec = spec.kb as { repo: string; name: string; intro: string }
          const repo = resolve(kbSpec.repo)
          let row = listKbs().find((k) => k.name === kbSpec.name)
          if (!row) {
            const r = createKb(kbSpec.name, kbSpec.intro, repo)
            if (!r.ok) {
              process.stderr.write(`[eval] ERROR ${r.error}\n`)
              app.exit(1)
              return
            }
            row = listKbs().find((k) => k.id === r.id)!
          }
          if (row.rootPath !== repo || !row.indexedAt) {
            updateKb(row.id, { rootPath: repo, intro: kbSpec.intro })
            const kb = await import('./kb')
            await kb.runIndexJob(null, row.id, true)
          } else {
            updateKb(row.id, { intro: kbSpec.intro })
          }
        }
        // 模型可为 vendor:model 或裸名（历史用例，按 deepseek 解析）；缺省用默认模型
        const model = spec.model || process.env.CHIME_ENGINE_MODEL || getDefaultModelRef()
        const emit = (e: object): void => {
          process.stdout.write(JSON.stringify(e) + '\n')
        }
        // 卡片代答（v1.1.1 前置条件与策略；011 Case 11 应答档案下线）：弹卡即按策略回应，
        // 动作以 card-answered 事件记入评估输出。授权卡按 policy.auth 消费——approve_all（缺省）
        // 全批 / deny_all 全拒 / 名单制 / deny 匹配拒；脚本模式提问卡一律整卡跳过（需要应答的
        // 用例改用 agent 模拟用户），agent 模式经 ask-request 转模拟用户。代答器无条件挂载，评估必须零挂起
        let currentStreamId = ''
        // agent 模式（011 Case 7）：stdin 常驻行分发器——user-message 在轮间到达、ask-answer 在
        // 轮中到达，共用一条 stdin；轮间才读会把轮中的提问卡回填堵死，必须常驻按 type 路由。
        // 结束信号＝Tuner 关闭 stdin（EOF）；Tuner 崩溃同样是 EOF，一条路管到底
        const agentMode = spec.driver === 'agent'
        type AskAnswerMsg = { answers?: { question: string; answer: string | null }[]; skip?: boolean }
        const askWaiters = new Map<string, (m: AskAnswerMsg) => void>()
        const msgQueue: (string | null)[] = []
        let msgWaiter: ((m: string | null) => void) | null = null
        const pushMsg = (m: string | null): void => {
          if (msgWaiter) {
            const w = msgWaiter
            msgWaiter = null
            w(m)
          } else msgQueue.push(m)
        }
        const nextMsg = (): Promise<string | null> =>
          msgQueue.length ? Promise.resolve(msgQueue.shift()!) : new Promise((r) => (msgWaiter = r))
        if (agentMode) {
          const readline = await import('readline')
          const rl = readline.createInterface({ input: process.stdin })
          rl.on('line', (line) => {
            if (!line.trim().startsWith('{')) return
            try {
              const m = JSON.parse(line) as { type?: string; text?: string; toolCallId?: string } & AskAnswerMsg
              if (m.type === 'user-message' && typeof m.text === 'string') pushMsg(m.text)
              else if (m.type === 'ask-answer' && m.toolCallId) {
                const w = askWaiters.get(m.toolCallId)
                if (w) {
                  askWaiters.delete(m.toolCallId)
                  w(m)
                }
              }
            } catch {
              // 非法行忽略（协议约定 JSON 行）
            }
          })
          rl.on('close', () => pushMsg(null))
        }
        {
          const cardsMod = await import('./engine/cards')
          const authPolicy = spec.policy?.auth ?? 'approve_all'
          let authSeq = 0 // 授权请求计数（deny 形态的 nth 匹配用，从 1 起）
          cardsMod.setCardResponder((kind, toolCallId, questions, toolName) => {
            if (kind === 'auth') {
              authSeq++
              const denyList = (authPolicy as { deny?: { tool?: string; nth?: number }[] }).deny
              const approved =
                authPolicy === 'approve_all'
                  ? true
                  : authPolicy === 'deny_all'
                    ? false
                    : Array.isArray(denyList)
                      ? !denyList.some(
                          (d) =>
                            (d.tool !== undefined || d.nth !== undefined) &&
                            (d.tool === undefined || d.tool === (toolName ?? '')) &&
                            (d.nth === undefined || d.nth === authSeq)
                        )
                      : (authPolicy as { approve: string[] }).approve.includes(toolName ?? '')
              emit({
                type: 'card-answered',
                streamId: currentStreamId,
                kind,
                toolCallId,
                tool: toolName,
                action: approved ? 'approve' : 'deny',
                source: 'policy'
              })
              return approved ? 'approved' : 'denied'
            }
            if (agentMode) {
              const sid = currentStreamId
              emit({ type: 'ask-request', streamId: sid, toolCallId, questions })
              return new Promise((resolveAsk) => {
                askWaiters.set(toolCallId, (m) => {
                  if (!m.answers?.length || m.skip) {
                    emit({ type: 'card-answered', streamId: sid, kind, toolCallId, action: 'skip', source: 'sim-user' })
                    resolveAsk({ kind: 'declined' })
                  } else {
                    emit({ type: 'card-answered', streamId: sid, kind, toolCallId, action: 'answer', source: 'sim-user', detail: m.answers })
                    resolveAsk({ kind: 'answers', answers: m.answers })
                  }
                })
              })
            }
            // 脚本模式（011 Case 11 应答档案下线）：提问卡一律整卡跳过，助手按"未回答"继续
            emit({ type: 'card-answered', streamId: currentStreamId, kind, toolCallId, action: 'skip', source: 'policy' })
            return { kind: 'declined' }
          })
        }
        // 进程号会循环复用，数据目录跨多次评估累积后会撞 id——带上时间戳保唯一
        const convId = spec.conv ?? `eval-${process.pid}-${Date.now()}`
        if (!spec.conv) {
          createConversation(convId, model, Date.now())
          // 环境快照（kb === true）：选中全部已构建的库；string[] 按名选中；对象形式按名选中该库
          if (spec.kb === true) {
            setConversationKbSelection(convId, listKbsDb().filter((k) => k.indexedAt).map((k) => ({ id: k.id, name: k.name })))
          } else if (Array.isArray(spec.kb)) {
            const names = spec.kb as string[]
            setConversationKbSelection(
              convId,
              listKbsDb().filter((k) => names.includes(k.name)).map((k) => ({ id: k.id, name: k.name }))
            )
          } else if (spec.kb) {
            const named = listKbsDb().find((k) => k.name === (spec.kb as unknown as { name: string }).name)
            setConversationKbSelection(convId, named ? [{ id: named.id, name: named.name }] : [])
          } else {
            setConversationKbSelection(convId, [])
          }
        } else {
          const store = await import('./engine/store')
          store.repairConversation(convId, REPAIR_TEXTS) // 与界面打开会话同语义
        }
        // Case 8 会话选用：声明了 mcp 的用例默认全部选入用例会话（既有用例语义不变）；
        // string[] 按名只选声明的服务（Case 10）；mcpSelected:false = 服务启用但本会话未选用
        {
          const db = await import('./db')
          let ids: number[] = []
          if (spec.mcp && spec.mcpSelected !== false) {
            const enabled = listMcpServices().filter((s) => s.enabled)
            ids = mcpDecls
              ? enabled.filter((s) => mcpDecls.some((d) => d.name === s.name)).map((s) => s.id)
              : enabled.map((s) => s.id)
          }
          db.setConversationMcpSelection(convId, ids)
        }
        // 前置动作（Case 12）：首轮对话前按声明顺序直接调工具——不经模型、不弹授权卡、
        // 不进对话历史、不进评分材料；任一步失败即整条用例执行失败（环境没布置好，跑了也不算数）
        if (spec.setup?.length) {
          const { getMcpToolList, callMcpTool } = await import('./mcp/client')
          // 工具查找限定在用例声明的服务内（Case 6 修正）：库内可能连着多个同名工具的服务
          //（如真实测试环境与本地复刻并存），裸名全局匹配会把前置动作打到用例没声明的服务上
          const allTools = getMcpToolList()
          const tools = mcpDecls
            ? allTools.filter((t) => mcpDecls.some((d) => d.name === t.serviceName))
            : allTools
          for (let i = 0; i < spec.setup.length; i++) {
            const step = spec.setup[i]
            // 工具名写法与用例断言一致（Case 4）：MCP 工具「服务名:工具名」
            const [svcName, toolName] = step.tool.includes(':')
              ? [step.tool.slice(0, step.tool.indexOf(':')), step.tool.slice(step.tool.indexOf(':') + 1)]
              : ['', step.tool]
            const found = tools.find((t) => t.name === toolName && (svcName === '' || t.serviceName === svcName))
            if (!found) {
              emit({ type: 'setup-failed', step: i + 1, tool: step.tool, error: '工具不存在或所属服务未连接' })
              process.stderr.write(`[eval] SETUP-FAILED 第${i + 1}步 ${step.tool}: 工具不存在或所属服务未连接\n`)
              app.exit(1)
              return
            }
            try {
              const r = await callMcpTool(found.serviceId, found.name, step.args ?? {})
              if (r.isError) {
                const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content).slice(0, 300)
                emit({ type: 'setup-failed', step: i + 1, tool: step.tool, error: text })
                process.stderr.write(`[eval] SETUP-FAILED 第${i + 1}步 ${step.tool}: ${text}\n`)
                app.exit(1)
                return
              }
              emit({ type: 'setup-call', step: i + 1, tool: step.tool, ok: true })
            } catch (e) {
              emit({ type: 'setup-failed', step: i + 1, tool: step.tool, error: String(e).slice(0, 300) })
              process.stderr.write(`[eval] SETUP-FAILED 第${i + 1}步 ${step.tool}: ${String(e)}\n`)
              app.exit(1)
              return
            }
          }
        }
        let turnNo = 0
        for (let i = 0; i < spec.messages.length; i++) {
          turnNo++
          const streamId = `t${turnNo}`
          currentStreamId = streamId
          if (spec.stopAfterMs) setTimeout(() => stopTurn(streamId), spec.stopAfterMs)
          await runTurn({ streamId, convId, text: spec.messages[i], model, emit })
        }
        // agent 模式：列表耗尽后逐轮从 stdin 取下一句，EOF 即收尾（分叉点只有这一处）
        if (agentMode) {
          for (;;) {
            const text = await nextMsg()
            if (text === null) break
            turnNo++
            const streamId = `t${turnNo}`
            currentStreamId = streamId
            await runTurn({ streamId, convId, text, model, emit })
          }
        }
        await closeAllMcp() // 关闭 SSE 长连接，评估进程干净退出
        app.exit(0)
      } catch (e) {
        process.stderr.write(`[eval] ERROR ${String(e)}\n`)
        app.exit(1)
      }
    })()
    return
  }

  // v0.5.0 验证钩子：CHIME_OVERFLOW_TEST=1 跑超限机制工程自检（总量闸从大到小 / 取数两式 / 删会话清结果）后退出
  if (process.env.CHIME_OVERFLOW_TEST) {
    void (async () => {
      try {
        initDb()
        const ov = await import('./engine/overflow')
        const db = await import('./db')
        const conv = 'overflow-test'
        createConversation(conv, 'test', Date.now())
        const assert = (cond: boolean, name: string): void => {
          process.stdout.write(`${cond ? '✅' : '❌'} ${name}\n`)
          if (!cond) process.exitCode = 1
        }
        // 单结果闸：超限落库换摘要
        const ctx: import('./engine/overflow').OverflowCtx = { convId: conv, refs: new Map(), turnFullChars: 0 }
        const big = 'x'.repeat(ov.RESULT_LIMIT + 5)
        const s1 = ov.guardSingle(ctx, 'c1', 'tool_a', big)
        assert(s1.includes('结果编号 #') && s1.length < 3000, '单结果闸：超限换摘要')
        assert(ov.guardSingle(ctx, 'c2', 'tool_a', 'short') === 'short', '单结果闸：未超限原样放行')
        // 总量闸：批内从大到小落库至回线内，PRD 例：基线 4 万 + 批 [B=5万, C=3万]，上限 10 万 → 落 B、C 放行
        const ctx2: import('./engine/overflow').OverflowCtx = { convId: conv, refs: new Map(), turnFullChars: 0 }
        const batch = [
          { toolCallId: 'b', toolName: 'tool_b', text: 'b'.repeat(50_000) },
          { toolCallId: 'c', toolName: 'tool_c', text: 'c'.repeat(30_000) }
        ]
        const replaced = ov.applyTotalGate(ctx2, ov.TOTAL_LIMIT - 60_000, batch) // 基线=上限-6万，批计 8 万超 2 万
        assert(replaced.has('b') && !replaced.has('c'), '总量闸：从大到小落库（大者落、小者放行）')
        assert(ctx2.turnFullChars === 30_000, '总量闸：放行量计入本轮累计')
        // 取数两工具（07-13 二次修订：grep_result / read_result，形态仿 grep -n / 按行读）
        const bigId = ctx.refs.get('c1')!
        const read = ov.readResult(conv, { resultId: bigId, offset: 1, limit: 1 })
        assert(typeof read === 'string' && read.includes('x'.repeat(20)) && read.includes('1:'), '读结果集：按行读取带行号')
        const idB = ctx2.refs.get('b')!
        const hit = ov.grepResult(conv, { resultId: idB, pattern: 'b{10}' })
        assert(typeof hit === 'string' && hit.includes('命中'), '搜结果集：正则匹配')
        // 压缩单行 JSON：落库时格式化多行；交替正则一次搜多词，命中行冒号、上下文行连字符、块间 --
        const mini = JSON.stringify(
          Array.from({ length: 1500 }, (_, i) => ({ 租户: `t${i}`, 负责人: i === 700 ? '陈某' : i === 900 ? '李某' : '别人' }))
        )
        const s3 = ov.guardSingle(ctx, 'c3', 'tool_a', mini)
        assert(s3.includes('行。') || / \d+ 行/.test(s3), '单结果闸：摘要带行数')
        const jid = ctx.refs.get('c3')!
        const found = ov.grepResult(conv, { resultId: jid, pattern: '陈某|李某', context: 1 })
        assert(
          typeof found === 'string' && found.includes('命中 2 处') && /\d+:.*陈某/.test(found) && /\d+-/.test(found) && found.includes('--'),
          '搜结果集：交替正则多词一次搜，命中带行号、上下文连字符、块间分隔'
        )
        const paged = ov.grepResult(conv, { resultId: jid, pattern: '别人', head_limit: 5, offset: 5 })
        assert(typeof paged === 'string' && paged.includes('offset='), '搜结果集：head_limit/offset 翻页提示')
        // 跨结果搜索：不传 resultId 搜全部已存结果，命中带 #编号 前缀（等价 grep 整个目录）
        const mini2 = JSON.stringify(
          Array.from({ length: 1500 }, (_, i) => ({ 租户: `u${i}`, 负责人: i === 300 ? '陈某' : '旁人' }))
        )
        ov.guardSingle(ctx, 'c4', 'tool_a', mini2)
        const jid2 = ctx.refs.get('c4')!
        const across = ov.grepResult(conv, { pattern: '陈某' })
        assert(
          typeof across === 'string' && across.includes(`#${jid}:`) && across.includes(`#${jid2}:`) && across.includes('全部已存结果'),
          '搜结果集：跨结果搜索带编号前缀'
        )
        assert(typeof ov.readResult(conv, { resultId: 9999 }) === 'object', '读结果集：无效编号报错')
        assert(typeof ov.readResult('other-conv', { resultId: bigId }) === 'object', '读结果集：跨会话不可用')
        // 制品解析三层
        const art = await import('./engine/artifact')
        const a1 = art.createArtifact(conv, { title: 'T1', data: [{ 租户: 'A', 金额: 1 }, { 租户: 'B', 金额: 2 }] })
        assert('id' in a1 && a1.rowCount === 2, '制品：结构化数组直接成表')
        const a2 = art.createArtifact(conv, { title: 'T2', data: '租户,金额\nA,1\nB,2\nC,3' })
        assert('id' in a2 && a2.rowCount === 3, '制品：首行表头分隔文本尽力解析')
        const a3 = art.createArtifact(conv, { title: 'T3', data: '账单 001 | 租户 A公司 | 金额 100 元\n账单 002 | 租户 B公司 | 金额 200 元' })
        assert('id' in a3 && a3.rowCount === 2 && 'id' in a3, '制品：逐格标注分隔文本尽力解析')
        assert('error' in art.createArtifact(conv, { title: 'T4', data: '这是一段散文，没有行列结构可言。' }), '制品：解析不动不生成')
        const refArt = art.createArtifact(conv, { title: 'T5', ref: { resultId: ctx2.refs.get('b')! } })
        assert('error' in refArt || 'id' in refArt, '制品：引用取数不抛异常')
        // 删会话清结果与制品
        db.deleteConversation(conv)
        assert(db.getToolResult(bigId, conv) === null, '删除会话：结果一并清除')
        assert('id' in a1 && db.getArtifact(a1.id) === null, '删除会话：制品一并清除')
        app.exit(Number(process.exitCode ?? 0))
      } catch (e) {
        process.stderr.write(`[overflow-test] ERROR ${String(e)}\n`)
        app.exit(1)
      }
    })()
    return
  }

  // v1.1.9 验证钩子：CHIME_SECRET_TEST=1 跑凭据加解密自检后退出。
  // 必须在 app ready 之后跑——safeStorage 此前一律不可用
  if (process.env.CHIME_SECRET_TEST) {
    void (async () => {
      const { seal, unseal, isSealed, canSeal } = await import('./secret')
      const assert = (cond: boolean, name: string): void => {
        process.stdout.write(`${cond ? '✅' : '❌'} ${name}\n`)
        if (!cond) process.exitCode = 1
      }
      assert(canSeal(), '当前环境支持加密（密钥文件可读写）')
      const key = 'sk-1234567890abcdef'
      const sealed = seal(key)
      assert(isSealed(sealed), '加密后带 enc.v2: 前缀')
      assert(!sealed.includes(key), '密文里不含明文')
      assert(unseal(sealed) === key, '解密还原一致')
      assert(seal(sealed) === sealed, '已加密的不再重复加密')
      assert(seal('') === '' && unseal('') === '', '空值原样通过')
      assert(unseal('sk-plain-legacy') === 'sk-plain-legacy', '无前缀的旧明文原样返回')
      assert(unseal('enc.v2:!!!not-base64!!!') === '', '坏密文解不开时返回空，不抛异常')
      const headers = JSON.stringify({ Authorization: 'Bearer abc123' })
      assert(unseal(seal(headers)) === headers, 'MCP 认证头整体加解密往返一致')
      // 迁移路径：v1 密文（钥匙串）能解开、且不算已加密，migrateSecrets 才会重存成 v2
      const { safeStorage } = await import('electron')
      const v1 = 'enc.v1:' + safeStorage.encryptString(key).toString('base64')
      assert(unseal(v1) === key, '旧版钥匙串密文仍能解开')
      assert(!isSealed(v1), '旧版密文不算当前格式，会被迁移重存')
      app.exit(process.exitCode === 1 ? 1 : 0)
    })()
    return
  }

  // v4 验证钩子：CHIME_ENGINE_TEST=1 时跑引擎主链自检（两轮无库对话，验流式事件、落库、历史组装）后退出
  if (process.env.CHIME_ENGINE_TEST) {
    void (async () => {
      try {
        initDb()
        const { runTurn } = await import('./engine/orchestrator')
        const model = process.env.CHIME_ENGINE_MODEL || 'deepseek-chat'
        // 隔离目录的库是空的，模型服务配置经环境变量注入
        saveProvider({
          apiKey: process.env.CHIME_ENGINE_KEY ?? '',
          baseUrl: process.env.CHIME_ENGINE_BASE_URL || 'https://api.deepseek.com',
          defaultModel: model
        })
        const convId = `engine-test-${Date.now()}`
        createConversation(convId, model, Date.now())
        const events: string[] = []
        const emit = (e: { type: string }): void => {
          events.push(e.type)
          console.log('[engine-test]', JSON.stringify(e).slice(0, 160))
        }
        await runTurn({ streamId: 't1', convId, text: '用一句话介绍你自己', model, emit })
        await runTurn({ streamId: 't2', convId, text: '把刚才的介绍精简到十个字以内', model, emit })
        // 停止键（流式中）：首个增量一到就停，验「已流出内容保留、标 stopped」
        const { stopTurn } = await import('./engine/orchestrator')
        let stopSent = false
        await runTurn({
          streamId: 't3',
          convId,
          text: '写一段 200 字的短文介绍茶的历史',
          model,
          emit: (e) => {
            emit(e)
            if (!stopSent && e.type === 'item-delta') {
              stopSent = true
              stopTurn('t3')
            }
          }
        })
        const rows = getMessages(convId)
        const assistants = rows.filter((r) => r.role === 'assistant')
        const stoppedRow = assistants[2]
        const ok =
          rows.length === 6 &&
          assistants.length === 3 &&
          assistants
            .slice(0, 2)
            .every(
              (r) => r.status === 'done' && r.content.trim() && Array.isArray(JSON.parse(r.items ?? ''))
            ) &&
          stoppedRow?.status === 'stopped' &&
          events.filter((t) => t === 'turn-done').length === 3
        console.log(`[engine-test] 停止轮 status=${stoppedRow?.status} 留痕=${!!stoppedRow?.items}`)
        console.log(ok ? '[engine-test] OK' : `[engine-test] FAIL rows=${rows.length}`)
        app.exit(ok ? 0 : 1)
      } catch (e) {
        console.error('[engine-test] ERROR', e)
        app.exit(1)
      }
    })()
    return
  }

  // v4 验证钩子：CHIME_TOOL_TEST=<测试库 repo 路径> 时跑检索工具化自检后退出
  // （隔离目录须预置 models 缓存；验：业务问题走检索出来源、闲聊不检索、闸门第 4 次拒绝）
  if (process.env.CHIME_TOOL_TEST) {
    void (async () => {
      try {
        initDb()
        const { runTurn } = await import('./engine/orchestrator')
        const { makeSearchTool } = await import('./engine/tools')
        const kb = await import('./kb')
        const model = process.env.CHIME_ENGINE_MODEL || 'deepseek-chat'
        saveProvider({
          apiKey: process.env.CHIME_ENGINE_KEY ?? '',
          baseUrl: process.env.CHIME_ENGINE_BASE_URL || 'https://api.deepseek.com',
          defaultModel: model
        })
        console.log('[tool-test] build kb')
        const { listKbs: lk, createKb: ck } = await import('./db')
        let ttRow = lk().find((k) => k.name === '计费系统')
        if (!ttRow) {
          const r = ck('计费系统', '本库收录计费、退款、发票等业务规则与流程说明', process.env.CHIME_TOOL_TEST!)
          if (r.ok) ttRow = lk().find((k) => k.id === r.id)
        }
        await kb.runIndexJob(null, ttRow!.id, true)

        const convId = `tool-test-${Date.now()}`
        createConversation(convId, model, Date.now())
        setConversationKbSelection(convId, listKbsDb().filter((k) => k.indexedAt).map((k) => ({ id: k.id, name: k.name })))
        const emit = (e: { type: string }): void => {
          console.log('[tool-test]', JSON.stringify(e).slice(0, 200))
        }
        await runTurn({ streamId: 't1', convId, text: '按天计费是怎么算的？', model, emit })
        await runTurn({ streamId: 't2', convId, text: '帮我把这句话改通顺：今天天气很好我们去公园玩。', model, emit })
        // 追问旧话题：不能吃历史老本，须本轮重新检索、带来源（行为规则回归点）
        await runTurn({ streamId: 't3', convId, text: '那暂停服务的天数收费吗？', model, emit })
        // 停止键（工具执行中）：检索一开始就停，验「等本步算完即收场、标 stopped」
        const { stopTurn } = await import('./engine/orchestrator')
        let stopSent = false
        await runTurn({
          streamId: 't4',
          convId,
          text: '退款多久能到账？',
          model,
          emit: (e) => {
            emit(e)
            if (!stopSent && e.type === 'item-start' && e.t === 'tool') {
              stopSent = true
              stopTurn('t4')
            }
          }
        })

        const rows = getMessages(convId).filter((r) => r.role === 'assistant')
        const items1 = JSON.parse(rows[0]?.items ?? '[]') as { t: string }[]
        const items2 = JSON.parse(rows[1]?.items ?? '[]') as { t: string }[]
        const items3 = JSON.parse(rows[2]?.items ?? '[]') as { t: string }[]
        const bizSearched = items1.some((i) => i.t === 'tool')
        const bizSourced = items1.some((i) => i.t === 'sources')
        const chatClean = !items2.some((i) => i.t === 'tool')
        const followupSearched = items3.some((i) => i.t === 'tool') && items3.some((i) => i.t === 'sources')
        const stopRow = rows[3]
        const stopKept = stopRow?.status === 'stopped' && Array.isArray(JSON.parse(stopRow?.items ?? ''))

        // 闸门（工具级计数）：第 4 次检索请求应被拒绝、不执行
        const ctx = { pool: [], searches: 0, kbIds: [1], kbNames: new Map([[1, '测试库']]) }
        const st = makeSearchTool(ctx)
        const call = st.execute as unknown as (
          i: { query: string },
          o: unknown
        ) => Promise<Record<string, unknown>>
        // 空检索词自愈：不执行、不耗次数、回自纠说明
        const blank = await call({ query: '  ' }, { toolCallId: 'g', messages: [] })
        const blankHealed = 'invalid' in blank && ctx.searches === 0
        for (let i = 0; i < 3; i++) await call({ query: '按天计费' }, { toolCallId: 'g', messages: [] })
        const gate = 'denied' in (await call({ query: '按天计费' }, { toolCallId: 'g', messages: [] }))

        console.log(
          `[tool-test] 业务问题走检索=${bizSearched} 出来源=${bizSourced} 闲聊不检索=${chatClean} 追问重查带来源=${followupSearched} 工具中停止留痕=${stopKept} 空检索词自愈=${blankHealed} 闸门拒绝=${gate}`
        )
        const ok = bizSearched && bizSourced && chatClean && followupSearched && stopKept && blankHealed && gate
        console.log(ok ? '[tool-test] OK' : '[tool-test] FAIL')
        app.exit(ok ? 0 : 1)
      } catch (e) {
        console.error('[tool-test] ERROR', e)
        app.exit(1)
      }
    })()
    return
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.chime.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDb()
  // 存量明文凭据转密文。只在有界面的正常启动做——eval / report 是短命进程，
  // 跑评估时不该顺手改用户的库
  migrateSecrets()
  registerIpc()

  // chime-doc://img/?doc=<相对文档路径>&src=<图片相对路径>：按文档所在目录解析，限制在知识库根内
  protocol.handle('chime-doc', (req) => {
    try {
      const u = new URL(req.url)
      const doc = decodeURIComponent(u.searchParams.get('doc') ?? '')
      const src = decodeURIComponent(u.searchParams.get('src') ?? '')
      const kbId = Number(u.searchParams.get('kb') ?? 0)
      const root = listKbsDb().find((k) => k.id === kbId)?.rootPath ?? ''
      if (!root || !doc || !src) return new Response('bad request', { status: 400 })
      const abs = resolve(join(root, dirname(doc)), src)
      if (!abs.startsWith(resolve(root) + '/')) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('error', { status: 500 })
    }
  })

  // 正式版菜单去掉「显示」栏（内含缩放快捷键）；开发态保留完整菜单（刷新/DevTools）
  if (!is.dev) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    )
  }

  const win = createWindow()

  // MCP：状态变更推设置页（认证失效等标识）；启动即连已启用服务、拉清单缓存（异步，不阻塞窗口）
  onMcpStatusChange(() => {
    if (!win.isDestroyed()) win.webContents.send('mcp:status')
  })
  void syncMcpServices()

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  // M0 验证钩子：CHIME_MODEL_TEST=1 时跑模型自检后退出
  if (process.env.CHIME_MODEL_TEST) {
    import('./model')
      .then((m) => m.selftest())
      .then((ok) => app.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error('[model-selftest] ERROR', e)
        app.exit(1)
      })
  }

  // M4 验证钩子：CHIME_RETRIEVE_TEST=1 时对已建好的库跑检索自检后退出
  if (process.env.CHIME_RETRIEVE_TEST) {
    import('./retrieve')
      .then((m) => m.selftest())
      .then((ok) => app.exit(ok ? 0 : 1))
      .catch((e) => {
        console.error('[retrieve-test] ERROR', e)
        app.exit(1)
      })
  }

  // M3 验证钩子：CHIME_KB_TEST=<repo 路径> 时跑「构建 → 改文件 → 增量刷新」后退出
  if (process.env.CHIME_KB_TEST) {
    const repo = process.env.CHIME_KB_TEST
    void (async () => {
      try {
        const kb = await import('./kb')
        const fs = await import('fs')
        const { listKbs, createKb } = await import('./db')
        let row = listKbs().find((k) => k.rootPath === repo)
        if (!row) {
          const r = createKb('测试库', '测试用', repo)
          if (r.ok) row = listKbs().find((k) => k.id === r.id)
        }
        console.log('[kb-test] build')
        await kb.runIndexJob(win.webContents, row!.id, true)
        fs.appendFileSync(join(repo, '退款流程.md'), '\n## 特殊情形\n预付订单退款需人工审核，三个工作日内处理。\n')
        fs.writeFileSync(join(repo, '新增文档.md'), '# 发票\n\n## 开具\n发票在订单完成后可在设置页自助开具，支持增值税普通发票。\n')
        console.log('[kb-test] refresh (1 modified + 1 untracked)')
        await kb.runIndexJob(win.webContents, row!.id, false)
        app.exit(0)
      } catch (e) {
        console.error('[kb-test] ERROR', e)
        app.exit(1)
      }
    })()
  }

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 关闭全部 MCP 连接，否则 SSE 长连接可能拖住进程
app.on('before-quit', () => {
  void closeAllMcp()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
