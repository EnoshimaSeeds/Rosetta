'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { RosettaDispatcher } = require('./ipc-dispatcher.cjs');
const { resolveSafeChildPath } = require('../contracts/schema.cjs');

const ROSETTA_ROOT = process.env.ROSETTA_ROOT || path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(ROSETTA_ROOT, 'src', 'ui');
const PROFILE_DIR = path.join(ROSETTA_ROOT, 'runtime', 'electron-profile');
fs.mkdirSync(PROFILE_DIR, { recursive: true });
app.setPath('userData', PROFILE_DIR);
app.setPath('sessionData', path.join(PROFILE_DIR, 'session'));

const isSmokeTest = process.argv.includes('--smoke-test');
if (isSmokeTest) {
  app.disableHardwareAcceleration();
} else {
  const gotSingleLock = app.requestSingleInstanceLock();
  if (!gotSingleLock) {
    app.quit();
    process.exit(0);
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rosetta',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false
    }
  }
]);

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

const dispatcher = new RosettaDispatcher(ROSETTA_ROOT);
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    show: !isSmokeTest,
    frame: false,
    backgroundColor: '#0f0b09',
    autoHideMenuBar: true,
    title: 'Rosetta — Skill & MCP Studio for DeepSeek Harness',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false
    }
  });

  const emitWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('rosetta:window-state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    });
  };
  mainWindow.on('maximize', emitWindowState);
  mainWindow.on('unmaximize', emitWindowState);
  mainWindow.on('enter-full-screen', emitWindowState);
  mainWindow.on('leave-full-screen', emitWindowState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith('rosetta://app/')) {
      event.preventDefault();
    }
  });

  mainWindow.loadURL('rosetta://app/index.html');

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        setTimeout(async () => {
          const afterLoad = await mainWindow.webContents.executeJavaScript(
            'JSON.stringify({ tier: document.body.dataset.tier, wheelCards: document.querySelectorAll(".reel-frame").length, hudTitle: document.querySelector(".hud-brand")?.textContent })'
          );
          process.stdout.write('ROSETTA_SMOKE_OK:' + afterLoad + '\n');
          app.quit();
        }, 450);
      } catch (err) {
        process.stderr.write('ROSETTA_SMOKE_ERR:' + err.message + '\n');
        app.exit(1);
      }
    });
  }
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (app.isReady()) {
    createMainWindow();
  }
});

async function boot() {
  await app.whenReady();

  protocol.handle('rosetta', (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname !== 'app') {
        return new Response('Forbidden host', { status: 403 });
      }
      const relPath = decodeURIComponent(parsed.pathname === '/' ? '/index.html' : parsed.pathname).replace(/^\/+/, '');
      const safeFile = resolveSafeChildPath(UI_ROOT, ...relPath.split('/'));
      if (!fs.existsSync(safeFile) || !fs.statSync(safeFile).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(safeFile).toLowerCase();
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      const bytes = fs.readFileSync(safeFile);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self' rosetta:; script-src 'self' rosetta:; style-src 'self' 'unsafe-inline' rosetta:; img-src 'self' data: rosetta:; font-src 'self' data: rosetta:; connect-src 'none'; object-src 'none'; frame-ancestors 'none';"
        }
      });
    } catch (_ignored) {
      return new Response('Bad request', { status: 400 });
    }
  });

  ipcMain.handle('rosetta:invoke', (event, action, payload) => {
    const senderUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !senderUrl.startsWith('rosetta://app/')) {
      return { ok: false, code: 'ERR_UNTRUSTED_FRAME', error: 'IPC rejected: untrusted sender frame.' };
    }
    return dispatcher.dispatch(action, payload);
  });

  ipcMain.handle('rosetta:window', (event, cmd) => {
    const senderUrl = event.senderFrame ? event.senderFrame.url : '';
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !senderUrl.startsWith('rosetta://app/')) {
      return { ok: false, code: 'ERR_UNTRUSTED_FRAME' };
    }
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (cmd === 'minimize') mainWindow.minimize();
    else if (cmd === 'toggleMaximize') {
      if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
      else if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (cmd === 'toggleFullscreen') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    } else if (cmd === 'close') {
      mainWindow.close();
      return { ok: true };
    } else if (cmd !== 'getState') {
      return { ok: false, code: 'ERR_INVALID_WINDOW_CMD' };
    }
    return {
      ok: true,
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen()
    };
  });

  createMainWindow();

  app.on('window-all-closed', () => {
    app.quit();
  });
}

boot();
