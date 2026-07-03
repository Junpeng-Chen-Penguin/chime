import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { initDb } from './db'
import { registerIpc } from './ipc'

function createWindow(): BrowserWindow {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
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

// 单实例：重复启动时退出新实例、聚焦已有窗口（避免 dock 里出现多个）
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
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
