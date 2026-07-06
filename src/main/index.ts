import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join, dirname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { tmpdir } from 'os'
import { initDb, getKb, saveProvider, createConversation, getMessages } from './db'
import { registerIpc } from './ipc'

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

// 测试走独立数据目录：不碰真实数据，且单实例锁随数据目录区分——须先于加锁
if (process.env.CHIME_ENGINE_TEST) {
  app.setPath('userData', join(tmpdir(), 'chime-engine-test'))
}

// 单实例：重复启动时退出新实例、聚焦已有窗口（避免 dock 里出现多个）
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// 文档内相对路径图片的自定义协议（须在 app ready 前注册 privileged）
protocol.registerSchemesAsPrivileged([
  { scheme: 'chime-doc', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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
        const rows = getMessages(convId)
        const assistants = rows.filter((r) => r.role === 'assistant')
        const ok =
          rows.length === 4 &&
          assistants.length === 2 &&
          assistants.every(
            (r) => r.status === 'done' && r.content.trim() && Array.isArray(JSON.parse(r.items ?? ''))
          ) &&
          events.filter((t) => t === 'turn-done').length === 2
        console.log(ok ? '[engine-test] OK' : `[engine-test] FAIL rows=${rows.length}`)
        app.exit(ok ? 0 : 1)
      } catch (e) {
        console.error('[engine-test] ERROR', e)
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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
