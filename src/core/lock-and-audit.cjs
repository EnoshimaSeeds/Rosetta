'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REENTRANT_LOCKS = new Set();
// Module-private anti-mislabeling symbol (prevents honest CLI/helper scripts from accidentally
// logging Desktop UI actions; not a cross-privilege boundary within the same OS process).
const DESKTOP_SESSION_SYMBOL = Symbol('rosetta.desktop.session');
const ALLOWED_CHANNELS = new Set([
  'desktop', 'desktop-approve', 'desktop-rollback', 'desktop-drift',
  'cli', 'mcp', 'mcp-grant', 'script', 'system'
]);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.floor(ms)));
  } catch (_ignored) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback if SAB disabled */ }
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Cross-process exclusive lock using atomic O_CREAT | O_EXCL ('wx').
 */
function withCatalogLock(rosettaRoot, fn, timeoutMs = 15000) {
  const runtimeDir = path.join(path.resolve(rosettaRoot), 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const lockPath = path.join(runtimeDir, '.catalog.lock');

  if (REENTRANT_LOCKS.has(lockPath)) {
    return fn();
  }

  const deadline = Date.now() + timeoutMs;
  const ownerToken = `${process.pid}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  let acquiredFd = null;

  while (Date.now() < deadline) {
    try {
      acquiredFd = fs.openSync(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        acquiredAt: Date.now()
      });
      fs.writeSync(acquiredFd, payload);
      fs.fsyncSync(acquiredFd);
      fs.closeSync(acquiredFd);
      acquiredFd = -1;
      break;
    } catch (err) {
      if (acquiredFd !== null && acquiredFd !== -1) {
        try { fs.closeSync(acquiredFd); } catch (_e) { /* closing failed fd */ }
        acquiredFd = null;
      }
      if (err.code !== 'EEXIST') throw err;

      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const info = JSON.parse(raw);
        if (!isPidAlive(info.pid)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (_staleOrPartial) {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 30000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch (_gone) { /* lock already released by peer */ }
      }
      sleepSync(12 + Math.floor(Math.random() * 24));
    }
  }

  if (acquiredFd === null) {
    throw new Error('ERR_LOCK_TIMEOUT: Timed out acquiring Rosetta catalog cross-process lock.');
  }

  REENTRANT_LOCKS.add(lockPath);
  try {
    return fn();
  } finally {
    REENTRANT_LOCKS.delete(lockPath);
    try {
      const currentRaw = fs.readFileSync(lockPath, 'utf8');
      const currentInfo = JSON.parse(currentRaw);
      if (currentInfo && currentInfo.token === ownerToken) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch (_e) { /* already gone or replaced */ }
  }
}

/**
 * Anti-mislabeling origin resolver: ensures CLI/library helper scripts
 * are not accidentally recorded as interactive Desktop UI clicks by the user.
 */
function resolveAuditOrigin(opts = {}, defaultChannel = 'script') {
  const isVerifiedDesktop = opts && opts.desktopToken === DESKTOP_SESSION_SYMBOL;
  const rawChannel = String(opts.channel || defaultChannel);
  const claimedDesktop = rawChannel.startsWith('desktop');
  let channel = ALLOWED_CHANNELS.has(rawChannel) ? rawChannel : 'script';

  if (claimedDesktop && !isVerifiedDesktop) {
    channel = 'script';
  }

  const rawActor = String(opts.actor || process.env.ROSETTA_ACTOR || 'local-script').trim().slice(0, 32) || 'local-script';
  let actor = isVerifiedDesktop ? 'User' : rawActor;
  let onBehalfOf = opts.onBehalfOf ? String(opts.onBehalfOf).trim().slice(0, 32) : undefined;

  if (!isVerifiedDesktop && claimedDesktop && rawActor.toLowerCase() === 'user') {
    actor = 'local-script';
    if (!onBehalfOf) onBehalfOf = 'User';
  }

  let approval = String(opts.approval || (isVerifiedDesktop ? 'direct-ui' : 'script-call'));
  if (approval === 'direct-ui' && !isVerifiedDesktop) {
    approval = 'script-call';
  }

  return { actor, channel, approval, ...(onBehalfOf ? { onBehalfOf } : {}) };
}

/**
 * Append-only SHA-256 hash-chained Audit Logger (`catalog/audit-log.jsonl`).
 */
class AuditLogger {
  constructor(rosettaRoot) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.logPath = path.join(this.rosettaRoot, 'catalog', 'audit-log.jsonl');
  }

  log(entry) {
    return withCatalogLock(this.rosettaRoot, () => {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      let prevHash = 'GENESIS';
      if (fs.existsSync(this.logPath)) {
        const content = fs.readFileSync(this.logPath, 'utf8').trim();
        if (content) {
          const lastLine = content.split('\n').pop();
          try {
            prevHash = JSON.parse(lastLine).entryHash || 'GENESIS';
          } catch (_corrupt) {
            prevHash = 'CORRUPT_TAIL';
          }
        }
      }

      const record = {
        id: `aud_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        timestamp: new Date().toISOString(),
        actor: String(entry.actor || 'Unknown'),
        ...(entry.onBehalfOf ? { onBehalfOf: String(entry.onBehalfOf).slice(0, 32) } : {}),
        channel: String(entry.channel || 'script'),
        action: String(entry.action || 'unknown'),
        targetId: String(entry.targetId || ''),
        status: String(entry.status || 'OK'),
        approval: String(entry.approval || 'script-call'),
        summary: String(entry.summary || '').slice(0, 300),
        prevHash
      };
      record.entryHash = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24);

      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n', 'utf8');
      return record;
    });
  }

  listRecent(limit = 60) {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch (_skip) { /* skip malformed line */ }
    }
    return parsed.reverse().slice(0, limit);
  }

  verifyChain() {
    if (!fs.existsSync(this.logPath)) {
      return { ok: true, count: 0, brokenAtIndex: null, tailHash: 'GENESIS' };
    }
    const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n').filter(Boolean);
    let prev = 'GENESIS';
    for (let i = 0; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.prevHash !== prev) {
          return { ok: false, count: lines.length, brokenAtIndex: i, tailHash: prev };
        }
        const copy = Object.assign({}, obj);
        delete copy.entryHash;
        const expected = crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex').slice(0, 24);
        if (expected !== obj.entryHash) {
          return { ok: false, count: lines.length, brokenAtIndex: i, tailHash: prev };
        }
        prev = obj.entryHash;
      } catch (_badJson) {
        return { ok: false, count: lines.length, brokenAtIndex: i, tailHash: prev };
      }
    }
    return { ok: true, count: lines.length, brokenAtIndex: null, tailHash: prev };
  }
}

/**
 * Single-use, short-lived Desktop Authorization Grants for MCP writes.
 */
class ApprovalGrantStore {
  constructor(rosettaRoot) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.grantsPath = path.join(this.rosettaRoot, 'runtime', 'approval-grants.json');
  }

  _hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '').trim()).digest('hex');
  }

  _readAll() {
    if (!fs.existsSync(this.grantsPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.grantsPath, 'utf8'));
      return Array.isArray(data.grants) ? data.grants : [];
    } catch (_err) {
      return [];
    }
  }

  _writeAll(grants) {
    fs.mkdirSync(path.dirname(this.grantsPath), { recursive: true });
    const now = Date.now();
    const active = grants.filter((g) => !g.consumed && g.expiresAtMs > now - 60000).slice(-25);
    fs.writeFileSync(this.grantsPath, JSON.stringify({ grants: active }, null, 2) + '\n', 'utf8');
  }

  issueOneTimeGrant({ allowedHost = '*', skillId = '*', ttlSeconds = 300 } = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      const partA = crypto.randomBytes(2).toString('hex').toUpperCase();
      const partB = crypto.randomBytes(2).toString('hex').toUpperCase();
      const token = `RSTA-${partA}-${partB}`;
      const expiresAtMs = Date.now() + Math.min(1800, Math.max(60, ttlSeconds)) * 1000;
      const grants = this._readAll();
      const grantId = `gr_${Date.now()}_${partA.toLowerCase()}`;
      grants.push({
        grantId,
        tokenHash: this._hashToken(token),
        allowedHost,
        skillId,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        consumed: false
      });
      this._writeAll(grants);
      return { grantId, token, allowedHost, skillId, expiresAt: new Date(expiresAtMs).toISOString() };
    });
  }

  consumeGrant(rawToken, hostAgent, skillId) {
    if (!rawToken || typeof rawToken !== 'string') return { ok: false, reason: '未提供单次授权码' };
    return withCatalogLock(this.rosettaRoot, () => {
      const h = this._hashToken(rawToken);
      const now = Date.now();
      const grants = this._readAll();
      const match = grants.find((g) =>
        !g.consumed &&
        g.tokenHash === h &&
        g.expiresAtMs > now &&
        (g.allowedHost === '*' || g.allowedHost === hostAgent) &&
        (g.skillId === '*' || g.skillId === skillId)
      );
      if (!match) {
        return { ok: false, reason: '授权码无效、已过期或已被使用' };
      }
      match.consumed = true;
      match.consumedAt = new Date().toISOString();
      match.consumedBy = hostAgent;
      this._writeAll(grants);
      return { ok: true, grantId: match.grantId };
    });
  }
}

/**
 * Compact unified line diff generator for Desktop Proposal review.
 */
function computeLineDiff(oldText = '', newText = '') {
  const oldLines = String(oldText || '').replace(/\r\n/g, '\n').split('\n');
  const newLines = String(newText || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      out.push(`  ${oldLines[oi]}`);
      oi++;
      ni++;
    } else if (ni + 1 < newLines.length && oi < oldLines.length && oldLines[oi] === newLines[ni + 1]) {
      out.push(`+ ${newLines[ni]}`);
      ni++;
    } else if (oi + 1 < oldLines.length && ni < newLines.length && oldLines[oi + 1] === newLines[ni]) {
      out.push(`- ${oldLines[oi]}`);
      oi++;
    } else {
      if (oi < oldLines.length) { out.push(`- ${oldLines[oi]}`); oi++; }
      if (ni < newLines.length) { out.push(`+ ${newLines[ni]}`); ni++; }
    }
    if (out.length > maxLen * 2 + 50) break;
  }
  return out.join('\n');
}

module.exports = {
  DESKTOP_SESSION_SYMBOL,
  withCatalogLock,
  resolveAuditOrigin,
  AuditLogger,
  ApprovalGrantStore,
  computeLineDiff
};
