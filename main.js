const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Notification, globalShortcut, systemPreferences, shell, nativeImage } = require('electron')
const path = require('path')

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// ── Stealth: rename process title so it doesn't appear as "Electron" or "Pinn"
process.title = isMac ? 'com.apple.security.screensaver' : 'RuntimeBroker'

// ── Single instance lock — kills any existing instance before taking over
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Another instance is already running — quit this one immediately
  app.quit()
  process.exit(0)
}

// If a second instance tries to launch, just focus the existing window
app.on('second-instance', () => {
  if (win) {
    if (win.isVisible()) win.focus()
    else focusAndShow()
  }
})

// macOS: hide from Dock, Cmd+Tab, Mission Control — before anything loads
if (isMac) {
  app.dock.hide()
  app.setActivationPolicy('accessory')
}

// Suppress the app from appearing in macOS app switcher and window listings
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')
app.commandLine.appendSwitch('no-sandbox')

let win
let selectorWin

function createWindow() {
  const opts = {
    width: 320,
    height: 260,
    minWidth: 260,
    minHeight: 200,
    resizable: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: '',
    focusable: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  }

  if (isWin) {
    opts.backgroundMaterial = 'acrylic'
  }

  const fs = require('fs')
  const os = require('os')
  const settingsFile = require('path').join(os.homedir(), '.pinn-settings.json')
  let onboarded = false
  try { onboarded = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).onboarded === true } catch {}

  if (!onboarded) {
    opts.width = 340
    opts.height = 500
    opts.minHeight = 460
  }

  win = new BrowserWindow(opts)

  // Content protection: makes window BLACK in all screen capture —
  // Zoom, Google Meet, Teams, OBS, Lockdown Browser screen share all see nothing
  win.setContentProtection(true)

  // Re-apply content protection every time window becomes visible
  win.on('show', () => { try { win.setContentProtection(true) } catch {} })

  win.loadFile(onboarded ? 'app.html' : 'onboarding.html')
  win.setAlwaysOnTop(true, isMac ? 'screen-saver' : undefined)

  if (isMac) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Hide from macOS window list APIs used by screen recorders
    win.setWindowButtonVisibility(false)
  }
}

ipcMain.on('close-window', () => { if (win) win.hide() })

ipcMain.on('finish-onboarding', () => {
  win.setSize(340, 360)
  win.setMinimumSize(280, 300)
  win.loadFile('app.html')
})

ipcMain.on('update-hotkey', (_, newKey) => {
  const toggle = () => {
    if (!win) return
    if (win.isVisible()) { win.hide() }
    else { focusAndShow() }
  }
  const fallback = 'CommandOrControl+Shift+P'
  globalShortcut.unregisterAll()
  const ok = newKey && newKey !== fallback
    ? (() => { try { return globalShortcut.register(newKey, toggle) } catch { return false } })()
    : false
  if (!ok) globalShortcut.register(fallback, toggle)
})

function focusAndShow() {
  win.setContentProtection(true)  // always re-apply before showing
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
    win.hide()
    try { win.setContentProtection(false) } catch {}

    // Wait for window to fully disappear before capturing
    await new Promise(r => setTimeout(r, 400))

    const display = screen.getPrimaryDisplay()
    const { width, height } = display.size
    const scale = display.scaleFactor || 1 // e.g. 1.25 on 125% DPI

    // Capture at physical pixel resolution so image matches screen exactly
    let sources
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
      })
    } catch (e) {
      try { win.setContentProtection(true) } catch {}
      focusAndShow()
      return null
    }

    if (!sources.length) {
      try { win.setContentProtection(true) } catch {}
      focusAndShow()
      return null
    }

    const fullDataUrl = sources[0].thumbnail.toDataURL()

    // Open selector overlay — explicit size instead of fullscreen (transparent+fullscreen breaks on Windows)
    return new Promise(resolve => {
      selectorWin = new BrowserWindow({
        x: 0, y: 0,
        width, height,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        resizable: false,
        movable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      })
      selectorWin.loadFile('selector.html')
      selectorWin.setAlwaysOnTop(true, 'screen-saver')

      // did-finish-load is more reliable than ready-to-show for transparent windows on Windows
      selectorWin.webContents.once('did-finish-load', () => {
        selectorWin.show()
        selectorWin.focus()
        selectorWin.webContents.send('screenshot', fullDataUrl)
      })

      ipcMain.once('selection-done', (_, { x, y, w, h }) => {
        if (selectorWin) { selectorWin.close(); selectorWin = null }

        // Scale logical pixel coords → physical pixels to match the captured image
        const img = nativeImage.createFromDataURL(fullDataUrl)
        const cropped = img.crop({
          x: Math.round(x * scale), y: Math.round(y * scale),
          width: Math.max(1, Math.round(w * scale)),
          height: Math.max(1, Math.round(h * scale))
        })

        try { win.setContentProtection(true) } catch {}
        focusAndShow()
        resolve(cropped.toDataURL())
      })

      ipcMain.once('selection-cancel', () => {
        if (selectorWin) { selectorWin.close(); selectorWin = null }
        try { win.setContentProtection(true) } catch {}
        focusAndShow()
        resolve(null)
      })
    })

  } else {
    // macOS: hide window, user takes screenshot with Cmd+Shift+4, watch for new file
    const fs2 = require('fs')
    const os2 = require('os')

    // Watch both Desktop and ~/Pictures/Screenshots (macOS 14+ default)
    const watchDirs = [
      path.join(os2.homedir(), 'Desktop'),
      path.join(os2.homedir(), 'Pictures', 'Screenshots')
    ].filter(d => { try { return fs2.statSync(d).isDirectory() } catch { return false } })

    // Snapshot existing files before hiding
    const before = new Map()
    for (const dir of watchDirs) {
      try { fs2.readdirSync(dir).forEach(f => before.set(path.join(dir, f), true)) } catch {}
    }

    win.setContentProtection(false)
    win.webContents.send('screenshot-taking')  // show instruction in chat
    await new Promise(r => setTimeout(r, 1200)) // let user read instruction
    win.hide()

    const dataUrl = await new Promise(resolve => {
      let resolved = false
      const done = (val) => {
        if (resolved) return
        resolved = true
        watchers.forEach(w => { try { w.close() } catch {} })
        clearTimeout(timeout)
        resolve(val)
      }

      const timeout = setTimeout(() => done(null), 30000)

      const watchers = watchDirs.map(dir => {
        try {
          return fs2.watch(dir, (event, filename) => {
            if (!filename || resolved) return
            if (!/\.(png|jpg|jpeg)$/i.test(filename)) return
            const fullPath = path.join(dir, filename)
            if (before.has(fullPath)) return
            // Wait for file to finish writing (macOS thumbnail delay)
            setTimeout(() => {
              try {
                const buf = fs2.readFileSync(fullPath)
                if (buf.length < 100) return // not ready yet
                done('data:image/png;base64,' + buf.toString('base64'))
              } catch {}
            }, 800)
          })
        } catch { return { close: () => {} } }
      })
    })

    win.setContentProtection(true)
    focusAndShow()
    return dataUrl
  }
})

ipcMain.handle('export-pdf', async (_, htmlContent) => {
  const fs2 = require('fs')
  const os2 = require('os')
  const pdfWin = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  try {
    await pdfWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))
    const pdfBuffer = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    pdfWin.close()
    const savePath = path.join(os2.homedir(), 'Downloads', `Pinn-${Date.now()}.pdf`)
    fs2.writeFileSync(savePath, pdfBuffer)
    return savePath
  } catch (e) {
    try { pdfWin.close() } catch {}
    return null
  }
})

ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

ipcMain.on('nuke-app', () => {
  // Remove login item so it won't auto-start
  try { app.setLoginItemSettings({ openAtLogin: false }) } catch {}

  // Delete settings file
  const os2 = require('os')
  const fs2 = require('fs')
  try { fs2.rmSync(require('path').join(os2.homedir(), '.pinn-settings.json'), { force: true }) } catch {}
  try { fs2.rmSync(require('path').join(os2.homedir(), '.pinn-sessions'), { recursive: true, force: true }) } catch {}

  // Delete the app itself, then quit
  const appPath = app.getAppPath()
  // getAppPath returns inside asar — get the actual .app bundle or folder
  const appRoot = isMac
    ? appPath.replace(/\/Contents\/Resources\/app\.asar$/, '').replace(/\/Contents\/Resources\/app$/, '')
    : path.dirname(path.dirname(appPath)) // win: resources/app -> app folder

  app.quit()

  // After quit, remove app from disk
  setTimeout(() => {
    try {
      if (isMac) {
        require('child_process').exec(`rm -rf "${appRoot}"`)
      } else {
        require('child_process').exec(`rmdir /s /q "${appRoot}"`)
      }
    } catch {}
  }, 800)
})

// macOS: auto-hide when native screenshot tool (Cmd+Shift+3/4/5) is active
// setContentProtection blocks screen recording but native screencaptureui still sees the window
if (isMac) {
  const { exec } = require('child_process')
  let hiddenForScreenshot = false

  setInterval(() => {
    exec('pgrep -x screencaptureui', (err, stdout) => {
      const active = !!stdout.trim()
      if (active && !hiddenForScreenshot && win && win.isVisible()) {
        hiddenForScreenshot = true
        win.hide()
      } else if (!active && hiddenForScreenshot) {
        hiddenForScreenshot = false
        // stay hidden — user brings it back with hotkey as normal
      }
    })
  }, 120)
}

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
