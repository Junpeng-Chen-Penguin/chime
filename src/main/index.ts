import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join, dirname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { tmpdir } from 'os'
import {
  initDb,
  getKb,
  getProvider,
  saveProvider,
  createConversation,
  getMessages,
  setKbMeta,
  setConversationKb,
  listMcpServices,
  saveMcpService
} from './db'
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
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 全屏时红绿灯隐藏，通知界面调整左上角内边距（收起态不再为红绿灯留空）
  const sendFs = (v: boolean): void => mainWindow.webContents.send('window:fullscreen', v)
  mainWindow.on('enter-full-screen', () => sendFs(true))
  mainWindow.on('leave-full-screen', () => sendFs(false))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

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
if (process.env.CHIME_ENGINE_TEST) {
  app.setPath('userData', join(tmpdir(), 'chime-engine-test'))
}
if (process.env.CHIME_TOOL_TEST) {
  app.setPath('userData', join(tmpdir(), 'chime-tool-test'))
}

// 单实例：重复启动时退出新实例、聚焦已有窗口（避免 dock 里出现多个）。
// 无界面评估入口不占锁：隔离数据目录、随起随退；且强杀测试会留下残锁，占锁会被静默挡掉
if (!process.argv.includes('--eval') && !app.requestSingleInstanceLock()) {
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

app.whenReady().then(() => {
  if (evalCasePath) {
    void (async () => {
      try {
        initDb()
        if (process.env.CHIME_ENGINE_KEY) {
          saveProvider({
            apiKey: process.env.CHIME_ENGINE_KEY,
            baseUrl: process.env.CHIME_ENGINE_BASE_URL || 'https://api.deepseek.com',
            defaultModel: process.env.CHIME_ENGINE_MODEL || 'deepseek-chat'
          })
        }
        const { readFileSync } = await import('fs')
        const spec = JSON.parse(readFileSync(resolve(evalCasePath), 'utf8')) as {
          kb?: { repo: string; name: string; intro: string }
          mcp?: { name: string; url: string; headers?: Record<string, string> }[]
          model?: string
          messages: string[]
          conv?: string // 往既有会话续发（跨重启多轮自测）；缺省新建会话
          stopAfterMs?: number // 停止路径自测：每轮开跑后定时触发停止（同用户点停止）
        }
        const { runTurn, stopTurn, REPAIR_TEXTS } = await import('./engine/orchestrator')
        // MCP 用例：预置服务并连接（同名服务已存在则不重复建）
        if (spec.mcp) {
          const existing = listMcpServices()
          for (const s of spec.mcp) {
            if (!existing.some((e) => e.name === s.name)) {
              saveMcpService({ name: s.name, url: s.url, headers: s.headers ?? {}, enabled: true })
            }
          }
        }
        await syncMcpServices()
        // 带库用例：库未就绪或路径不同才构建（预置过则秒过）
        if (spec.kb) {
          const cur = getKb()
          if (cur.rootPath !== resolve(spec.kb.repo) || !cur.indexedAt) {
            const kb = await import('./kb')
            await kb.runIndexJob(null, resolve(spec.kb.repo), true, spec.kb.name)
          }
          setKbMeta({ intro: spec.kb.intro })
        }
        const model = spec.model || process.env.CHIME_ENGINE_MODEL || getProvider().defaultModel
        const emit = (e: object): void => {
          process.stdout.write(JSON.stringify(e) + '\n')
        }
        const convId = spec.conv ?? `eval-${process.pid}`
        if (!spec.conv) {
          createConversation(convId, model, Date.now())
          setConversationKb(convId, !!spec.kb)
        } else {
          const store = await import('./engine/store')
          store.repairConversation(convId, REPAIR_TEXTS) // 与界面打开会话同语义
        }
        for (let i = 0; i < spec.messages.length; i++) {
          const streamId = `t${i + 1}`
          if (spec.stopAfterMs) setTimeout(() => stopTurn(streamId), spec.stopAfterMs)
          await runTurn({ streamId, convId, text: spec.messages[i], model, emit })
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
        // 取数两式
        const bigId = ctx.refs.get('c1')!
        const range = ov.fetchFromResult(conv, { resultId: bigId, mode: 'range', start: 10, length: 20 })
        assert(typeof range === 'string' && range.includes('x'.repeat(20)), '查结果集：按位置读一段')
        const idB = ctx2.refs.get('b')!
        const hit = ov.fetchFromResult(conv, { resultId: idB, mode: 'search', keyword: 'bbb' })
        assert(typeof hit === 'string' && hit.includes('命中'), '查结果集：按关键词搜')
        assert(typeof ov.fetchFromResult(conv, { resultId: 9999 }) === 'object', '查结果集：无效编号报错')
        assert(typeof ov.fetchFromResult('other-conv', { resultId: bigId }) === 'object', '查结果集：跨会话不可用')
        // 删会话清结果
        db.deleteConversation(conv)
        assert(db.getToolResult(bigId, conv) === null, '删除会话：结果一并清除')
        app.exit(Number(process.exitCode ?? 0))
      } catch (e) {
        process.stderr.write(`[overflow-test] ERROR ${String(e)}\n`)
        app.exit(1)
      }
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
        await kb.runIndexJob(null, process.env.CHIME_TOOL_TEST!, true, '计费系统')
        setKbMeta({ intro: '本库收录计费、退款、发票等业务规则与流程说明' })

        const convId = `tool-test-${Date.now()}`
        createConversation(convId, model, Date.now())
        setConversationKb(convId, true)
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
        const ctx = { pool: [], searches: 0 }
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
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDb()
  registerIpc()

  // chime-doc://img/?doc=<相对文档路径>&src=<图片相对路径>：按文档所在目录解析，限制在知识库根内
  protocol.handle('chime-doc', (req) => {
    try {
      const u = new URL(req.url)
      const doc = decodeURIComponent(u.searchParams.get('doc') ?? '')
      const src = decodeURIComponent(u.searchParams.get('src') ?? '')
      const root = getKb().rootPath
      if (!root || !doc || !src) return new Response('bad request', { status: 400 })
      const abs = resolve(join(root, dirname(doc)), src)
      if (!abs.startsWith(resolve(root) + '/')) return new Response('forbidden', { status: 403 })
      return net.fetch(pathToFileURL(abs).toString())
    } catch {
      return new Response('error', { status: 500 })
    }
  })

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
        console.log('[kb-test] build')
        await kb.runIndexJob(win.webContents, repo, true)
        fs.appendFileSync(join(repo, '退款流程.md'), '\n## 特殊情形\n预付订单退款需人工审核，三个工作日内处理。\n')
        fs.writeFileSync(join(repo, '新增文档.md'), '# 发票\n\n## 开具\n发票在订单完成后可在设置页自助开具，支持增值税普通发票。\n')
        console.log('[kb-test] refresh (1 modified + 1 untracked)')
        await kb.runIndexJob(win.webContents, repo, false)
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
