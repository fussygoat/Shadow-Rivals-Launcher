const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { execFile } = require('child_process')

let mainWindow
const VERSION_URL = 'https://raw.githubusercontent.com/fussygoat/Shadow-Rivals-Version/main/version.json'
const VERSION_FILE = path.join(app.getPath('userData'), 'version.json')
const GAME_DIR = path.join(app.getPath('userData'), 'game')
const INSTALL_MARKER = path.join(GAME_DIR, '.installed')

function getLocalVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
    }
  } catch (e) {}
  return { version: '0.0.0', downloadUrl: '', changelog: '' }
}

function saveLocalVersion(data) {
  try {
    fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2))
  } catch (e) {}
}

function fetchRemote(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ShadowRivalsLauncher/1.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return fetchRemote(res.headers.location).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, { headers: { 'User-Agent': 'ShadowRivalsLauncher/1.0' } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return follow(res.headers.location)
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        const total = parseInt(res.headers['content-length'], 10) || 0
        let downloaded = 0
        const file = fs.createWriteStream(dest)
        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (onProgress) onProgress(downloaded, total)
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', reject)
      }).on('error', reject)
    }
    follow(url)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a12',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// IPC handlers
ipcMain.handle('get-version', () => getLocalVersion())

ipcMain.handle('check-update', async () => {
  try {
    const raw = await fetchRemote(VERSION_URL)
    const remote = JSON.parse(raw)
    const local = getLocalVersion()
    const needsUpdate = remote.version !== local.version
    return { needsUpdate, remote, local }
  } catch (e) {
    return { needsUpdate: false, error: e.message }
  }
})

ipcMain.handle('install-update', async (e, remote) => {
  if (!remote.downloadUrl) return { error: 'No download URL' }

  try {
    if (!fs.existsSync(GAME_DIR)) fs.mkdirSync(GAME_DIR, { recursive: true })

    const zipPath = path.join(GAME_DIR, 'update.zip')

    // Download
    mainWindow.webContents.send('install-progress', { stage: 'downloading', percent: 0 })
    await downloadFile(remote.downloadUrl, zipPath, (downloaded, total) => {
      const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0
      mainWindow.webContents.send('install-progress', { stage: 'downloading', percent })
    })

    // Extract
    mainWindow.webContents.send('install-progress', { stage: 'extracting', percent: 0 })
    const extractZip = require('extract-zip')
    await extractZip(zipPath, { dir: GAME_DIR })

    // Cleanup zip
    try { fs.unlinkSync(zipPath) } catch (e) {}

    // Save version
    saveLocalVersion(remote)
    fs.writeFileSync(INSTALL_MARKER, remote.version)

    mainWindow.webContents.send('install-progress', { stage: 'done', percent: 100 })
    return { success: true }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('launch-game', () => {
  // Look for the game exe in the install directory
  if (!fs.existsSync(GAME_DIR)) return { error: 'Game not installed' }

  const findExe = (dir) => {
    const files = fs.readdirSync(dir)
    for (const f of files) {
      const fp = path.join(dir, f)
      const stat = fs.statSync(fp)
      if (stat.isDirectory()) {
        const found = findExe(fp)
        if (found) return found
      } else if (f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('uninstall')) {
        return fp
      }
    }
    return null
  }

  const exe = findExe(GAME_DIR)
  if (!exe) return { error: 'Game exe not found' }

  execFile(exe, (err) => {
    if (err) console.error('Launch error:', err)
  })
  return { success: true }
})

ipcMain.handle('open-game-folder', () => {
  if (fs.existsSync(GAME_DIR)) {
    shell.openPath(GAME_DIR)
  }
})

ipcMain.handle('set-game-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Game Folder'
  })
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0]
  }
  return null
})

ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-close', () => mainWindow?.close())
