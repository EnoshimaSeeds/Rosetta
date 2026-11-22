#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { RosettaDispatcher } = require('./ipc-dispatcher.cjs');
const { resolveSafeChildPath } = require('../contracts/schema.cjs');

const ROSETTA_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(ROSETTA_ROOT, 'src', 'ui');
const RUNTIME_DIR = path.join(ROSETTA_ROOT, 'runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'server-state.json');

const isDryRun = process.argv.includes('--dry-run');
const isSmokeTest = process.argv.includes('--smoke');
const isServerOnly = process.argv.includes('--server-only');
const isDaemonChild = process.argv.includes('--daemon-server');
const forceAppWindow = process.argv.includes('--app-window');

function findWorkingElectronBinary() {
  if (forceAppWindow) return null;
  const candidates = [];
  if (process.env.ROSETTA_ELECTRON_PATH) candidates.push(process.env.ROSETTA_ELECTRON_PATH);
  const localCfgPath = path.join(ROSETTA_ROOT, 'rosetta.local.json');
  if (fs.existsSync(localCfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'));
      if (cfg.electronPath) candidates.push(cfg.electronPath);
    } catch (_ignored) { /* intentional safe fallback */ }
  }
  candidates.push(
    path.join(ROSETTA_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  );

  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.statSync(c).isFile()) {
      const cleanEnv = Object.assign({}, process.env);
      delete cleanEnv.ELECTRON_RUN_AS_NODE;
      const probe = spawnSync(c, ['--version'], { env: cleanEnv, timeout: 2500, windowsHide: true });
      if (probe.status === 0) {
        return c;
      }
    }
  }
  return null;
}

function findAppShellBrowser() {
  if (process.platform === 'win32') {
    const dynPaths = [
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
    return dynPaths.find((p) => fs.existsSync(p)) || null;
  }
  if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
    return macPaths.find((p) => fs.existsSync(p)) || null;
  }
  const linuxPaths = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return linuxPaths.find((p) => fs.existsSync(p)) || null;
}

function openStandaloneWindow(url) {
  const appBrowser = findAppShellBrowser();
  if (appBrowser) {
    const child = spawn(appBrowser, [
      `--app=${url}`,
      '--window-size=1420,880'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return true;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

function probeExistingServer(stateFilePath = STATE_FILE) {
  return new Promise((resolve) => {
    if (!fs.existsSync(stateFilePath)) return resolve(null);
    try {
      const info = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (!info || !info.port || !info.url) return resolve(null);
      const req = http.get(`http://127.0.0.1:${info.port}/__rosetta_ping`, { timeout: 450 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 200 && body === 'ROSETTA_ALIVE') resolve(info);
          else resolve(null);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (_ignored) {
      resolve(null);
    }
  });
}

function startLoopbackServer(opts = {}) {
  const stateFilePath = opts.stateFilePath || STATE_FILE;
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const dispatcher = new RosettaDispatcher(opts.rosettaRoot || ROSETTA_ROOT, opts.syncOptions || {});
  let lastActivity = Date.now();

  const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  };

  let boundPort = 0;

  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (boundPort && hostHeader && hostHeader !== `127.0.0.1:${boundPort}` && hostHeader !== `localhost:${boundPort}`) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden Host');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/__rosetta_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ROSETTA_ALIVE');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/__rosetta_heartbeat') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/__rosetta_rpc') {
      if (req.headers['x-rosetta-token'] !== sessionToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden: invalid session token' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const { action, payload } = JSON.parse(body || '{}');
          const out = dispatcher.dispatch(action, payload);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (url.pathname === '/__rosetta_bridge.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`window.rosetta = Object.freeze({
        hostMode: 'standalone-desktop-window',
        async invoke(action, payload = {}) {
          const r = await fetch('/__rosetta_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-rosetta-token': '${sessionToken}' },
            body: JSON.stringify({ action, payload })
          });
          return r.json();
        }
      });
      setInterval(() => {
        fetch('/__rosetta_heartbeat', { method: 'POST', headers: { 'x-rosetta-token': '${sessionToken}' } }).catch(() => {});
      }, 15000);`);
      return;
    }

    try {
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
      const safeFile = resolveSafeChildPath(UI_ROOT, ...rel.split('/'));
      if (!fs.existsSync(safeFile) || !fs.statSync(safeFile).isFile()) {
        res.writeHead(404); res.end('Not found'); return;
      }
      let content = fs.readFileSync(safeFile);
      const ext = path.extname(safeFile).toLowerCase();
      if (ext === '.html') {
        content = Buffer.from(
          content.toString('utf8').replace('<!-- ROSETTA-BRIDGE -->', '<script src="/__rosetta_bridge.js"></script>'),
          'utf8'
        );
      }
      res.writeHead(200, {
        'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none';"
      });
      res.end(content);
    } catch (_ignored) {
      res.writeHead(400); res.end('Bad request');
    }
  });

  if (!opts.keepAlive) {
    const reaper = setInterval(() => {
      if (Date.now() - lastActivity > 25 * 60 * 1000) {
        clearInterval(reaper);
        try { if (fs.existsSync(stateFilePath)) fs.rmSync(stateFilePath, { force: true }); } catch (_ignored) { /* safe */ }
        server.close(() => process.exit(0));
      }
    }, 60 * 1000);
    reaper.unref();
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      boundPort = port;
      const url = `http://127.0.0.1:${port}/`;
      if (opts.persistState) {
        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        fs.writeFileSync(stateFilePath, JSON.stringify({ pid: process.pid, port, url, startedAt: new Date().toISOString() }, null, 2), 'utf8');
      }
      resolve({ server, port, url, sessionToken });
    });
  });
}

async function main() {
  if (isDryRun) {
    const electronBin = findWorkingElectronBinary();
    const appBrowser = findAppShellBrowser();
    console.log(JSON.stringify({
      ok: true,
      edition: 'DeepSeek Harness',
      rosettaRoot: ROSETTA_ROOT,
      uiIndexExists: fs.existsSync(path.join(UI_ROOT, 'index.html')),
      vbsExists: fs.existsSync(path.join(__dirname, 'start-hidden.vbs')),
      hostEngine: electronBin ? 'electron-native' : (appBrowser ? 'standalone-app-window' : 'local-loopback'),
      desktopReady: Boolean(electronBin || appBrowser)
    }, null, 2));
    process.exit(0);
  }

  if (isSmokeTest) {
    const uiExists = fs.existsSync(path.join(UI_ROOT, 'index.html'));
    const vbsExists = fs.existsSync(path.join(__dirname, 'start-hidden.vbs'));
    const dash = new RosettaDispatcher(ROSETTA_ROOT).dispatch('getDashboard');
    const srv = await startLoopbackServer({ rosettaRoot: ROSETTA_ROOT, persistState: false, keepAlive: true });
    let pingBody = '';
    try {
      pingBody = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${srv.port}/__rosetta_ping`, { timeout: 2000 }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ping timeout')); });
      });
    } finally {
      await new Promise((r) => srv.server.close(r));
    }
    const ok = Boolean(uiExists && vbsExists && dash && dash.ok && pingBody === 'ROSETTA_ALIVE');
    console.log(JSON.stringify({
      ok,
      mode: 'smoke',
      uiExists,
      vbsExists,
      skillCount: dash && dash.data ? dash.data.skills.length : 0,
      loopbackPing: pingBody
    }, null, 2));
    process.exit(ok ? 0 : 1);
  }

  if (isDaemonChild) {
    await startLoopbackServer({ persistState: true, keepAlive: false });
    return;
  }

  if (isServerOnly) {
    const { url } = await startLoopbackServer({ persistState: true, keepAlive: true });
    console.log('ROSETTA_SERVER_READY:' + url);
    return;
  }

  const electronBin = findWorkingElectronBinary();
  if (electronBin) {
    const cleanEnv = Object.assign({}, process.env, { ROSETTA_ROOT });
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBin, [path.join(__dirname, 'main.cjs')], {
      cwd: ROSETTA_ROOT,
      env: cleanEnv,
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return;
  }

  const existing = await probeExistingServer();
  if (existing) {
    openStandaloneWindow(existing.url);
    return;
  }

  const daemon = spawn(process.execPath, [__filename, '--daemon-server'], {
    cwd: ROSETTA_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  daemon.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const ready = await probeExistingServer();
    if (ready) {
      openStandaloneWindow(ready.url);
      return;
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { startLoopbackServer, probeExistingServer, findWorkingElectronBinary, findAppShellBrowser };
