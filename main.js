const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Notification, globalShortcut, systemPreferences, shell, nativeImage } = require('electron')
const path = require('path')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// macOS: hide from Dock and Cmd+Tab switcher before anything loads
if (isMac) {
  app.dock.hide()
  app.setActivationPolicy('accessory')
}

let win
let selectorWin

function createWindow() {
  const opts = {
    width: 340,
    height: 360,
    minWidth: 280,
    minHeight: 300,
    resizable: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  }

  if (isMac) {
    opts.vibrancy = 'under-window'
    opts.visualEffectState = 'active'
    opts.type = 'panel'
  }

  if (isWin) {
    opts.transparent = true
    opts.backgroundMaterial = 'acrylic' // Windows 11 blur-behind effect
  }

  win = new BrowserWindow(opts)
  win.loadFile('index.html')
  win.setAlwaysOnTop(true, isMac ? 'floating' : undefined)

  if (isMac) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  win.setContentProtection(true)
}

ipcMain.on('close-window', () => win.hide())

ipcMain.on('update-hotkey', (_, newKey) => {
  globalShortcut.unregisterAll()
  const toggle = () => {
    if (!win) return
    if (win.isVisible()) { win.hide() }
    else { focusAndShow() }
  }
  try { globalShortcut.register(newKey, toggle) }
  catch { globalShortcut.register('CommandOrControl+Shift+P', toggle) }
})

function focusAndShow() {
  app.focus({ steal: true })
  win.show()
  win.focus()
  win.webContents.focus()
  win.webContents.send('focus-input')
}

// macOS only — trigger permission dialog by attempting a capture
ipcMain.handle('check-screen-permission', async () => {
  if (!isMac) return 'granted'
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }) } catch {}
    return systemPreferences.getMediaAccessStatus('screen')
  }
  return status
})

ipcMain.on('open-screen-permissions', () => {
  if (isMac) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
})

ipcMain.handle('take-screenshot', async () => {
  if (isWin) {
    // Windows: desktopCapturer works without any permission
    win.hide()
    win.setContentProtection(false)

    // Give the window time to fully hide before capturing
    await new Promise(r => setTimeout(r, 300))

    const { width, height } = screen.getPrimaryDisplay().size
    let sources
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    } catch {
      win.setContentProtection(true)
      focusAndShow()
      return null
    }

    if (!sources.length) {
      win.setContentProtection(true)
      focusAndShow()
      return null
    }

    const fullDataUrl = sources[0].thumbnail.toDataURL()

    // Open the selector overlay so user can drag to pick an area
    return new Promise(resolve => {
      selectorWin = new BrowserWindow({
        fullscreen: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      })
      selectorWin.loadFile('selector.html')

      selectorWin.once('ready-to-show', () => {
        selectorWin.show()
        selectorWin.webContents.send('screenshot', fullDataUrl)
      })

      ipcMain.once('selection-done', (_, { x, y, w, h }) => {
        selectorWin.close()
        selectorWin = null

        // Crop the full screenshot to the selected area
        const img = nativeImage.createFromDataURL(fullDataUrl)
        const cropped = img.crop({
          x: Math.round(x), y: Math.round(y),
          width: Math.round(w), height: Math.round(h)
        })

        win.setContentProtection(true)
        focusAndShow()
        resolve(cropped.toDataURL())
      })

      ipcMain.once('selection-cancel', () => {
        if (selectorWin) { selectorWin.close(); selectorWin = null }
        win.setContentProtection(true)
        focusAndShow()
        resolve(null)
      })
    })

  } else {
    // macOS: watch Desktop for a new file — user uses Cmd+Shift+4
    const fs2 = require('fs')
    const os2 = require('os')
    const desktopDir = path.join(os2.homedir(), 'Desktop')
    const before = new Set(fs2.readdirSync(desktopDir))

    win.hide()
    win.setContentProtection(false)
    win.webContents.send('screenshot-instructions')

    const dataUrl = await new Promise(resolve => {
      const timeout = setTimeout(() => { watcher.close(); resolve(null) }, 30000)

      const watcher = fs2.watch(desktopDir, (event, filename) => {
        if (!filename) return
        if (!/\.(png|jpg|jpeg)$/i.test(filename)) return
        if (before.has(filename)) return
        const fullPath = path.join(desktopDir, filename)
        setTimeout(() => {
          try {
            const buf = fs2.readFileSync(fullPath)
            clearTimeout(timeout)
            watcher.close()
            resolve('data:image/png;base64,' + buf.toString('base64'))
          } catch {}
        }, 400)
      })
    })

    win.setContentProtection(true)
    focusAndShow()
    return dataUrl
  }
})

ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

app.whenReady().then(() => {
  createWindow()

  // Auto-start on login (works on both macOS and Windows)
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })

  // Global shortcut — show/hide Pinn from anywhere
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (!win) return
    if (win.isVisible()) { win.hide() }
    else { focusAndShow() }
  })
})

app.on('window-all-closed', () => {
  // Keep process running silently even if window is hidden
})
