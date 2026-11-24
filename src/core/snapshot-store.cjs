'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateSlug, validateActor, resolveSafeChildPath } = require('../contracts/schema.cjs');
const { withCatalogLock } = require('./lock-and-audit.cjs');

const TOP_CONFIG_FILES = ['categories.json', 'assignments.json', 'mcp-registry.json', 'external-skills.json'];

function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpName = `.rosetta-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = path.join(dir, tmpName);
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data, 0, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_ignore) { /* best effort */ }
    throw err;
  }
}

function atomicWriteWithRetry(filePath, content, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      atomicWriteFile(filePath, content);
      return;
    } catch (err) {
      lastErr = err;
      const lockErr = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (lockErr && i < attempts - 1) {
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1)); } catch (_e) { /* ignore */ }
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function copyTreeWithHashes(srcDir, dstDir) {
  const hashes = {};
  if (!fs.existsSync(srcDir)) return hashes;

  function walk(curSrc, curDst, relPrefix) {
    fs.mkdirSync(curDst, { recursive: true });
    const entries = fs.readdirSync(curSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.rosetta-tmp-')) continue;
      const s = path.join(curSrc, entry.name);
      const d = path.join(curDst, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(s, d, rel);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(s);
        hashes[rel] = sha256Buffer(buf);
        fs.writeFileSync(d, buf);
      }
    }
  }

  walk(srcDir, dstDir, '');
  return hashes;
}

function verifyAndReadSnapshotFiles(payloadDir, expectedEntries, walkRootDir, walkPrefix = '') {
  const expectedMap = new Map(expectedEntries);
  const verifiedBuffers = new Map();

  for (const [relPath, expectedHash] of expectedMap.entries()) {
    const target = resolveSafeChildPath(payloadDir, ...relPath.split('/'));
    if (!fs.existsSync(target)) {
      throw new Error(`Snapshot integrity failure: missing ${relPath}`);
    }
    const lst = fs.lstatSync(target);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new Error(`Snapshot integrity failure: non-regular file ${relPath}`);
    }
    const buf = fs.readFileSync(target);
    const actualHash = sha256Buffer(buf);
    if (actualHash !== expectedHash) {
      throw new Error(`Snapshot integrity failure: hash mismatch on ${relPath}`);
    }
    verifiedBuffers.set(relPath, buf);
  }

  if (fs.existsSync(walkRootDir)) {
    function scanDisk(curDir, relBase) {
      for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.rosetta-tmp-')) continue;
        const full = path.join(curDir, entry.name);
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink()) {
          throw new Error(`Snapshot integrity failure: unexpected symlink ${rel}`);
        }
        if (lst.isDirectory()) {
          scanDisk(full, rel);
        } else if (lst.isFile()) {
          if (!expectedMap.has(rel)) {
            throw new Error(`Snapshot integrity failure: unexpected unlisted file ${rel}`);
          }
        }
      }
    }
    scanDisk(walkRootDir, walkPrefix);
  }

  return verifiedBuffers;
}

function materializeVerifiedFiles(targetDir, verifiedBuffers, stripPrefix = '') {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [relPath, buf] of verifiedBuffers.entries()) {
    if (stripPrefix && !relPath.startsWith(stripPrefix)) continue;
    const subRel = stripPrefix ? relPath.slice(stripPrefix.length) : relPath;
    if (!subRel) continue;
    const dst = resolveSafeChildPath(targetDir, ...subRel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
  }
}

class SnapshotStore {
  constructor(rosettaRoot, maxUnpinnedSnapshots = 35) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.catalogDir = path.join(this.rosettaRoot, 'catalog');
    this.snapshotsDir = path.join(this.rosettaRoot, 'snapshots');
    this.maxUnpinnedSnapshots = maxUnpinnedSnapshots;
  }

  createSnapshot(reason = '手动保存', actor = 'System', opts = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      const safeActor = validateActor(actor);
      fs.mkdirSync(this.snapshotsDir, { recursive: true });

      const coalesceKey = opts.coalesceKey ? String(opts.coalesceKey) : null;
      const pinned = Boolean(opts.pinned);
      const windowMs = opts.coalesceWindowMs ?? 60000;

      if (coalesceKey && !pinned) {
        const existing = this.listSnapshots();
        const newest = existing[0];
        if (
          newest &&
          !newest.pinned &&
          newest.coalesceKey === coalesceKey &&
          Date.now() - Date.parse(newest.createdAt) < windowMs
        ) {
          return newest;
        }
      }

      const now = new Date();
      const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15).toLowerCase();
      const shortRand = crypto.randomBytes(3).toString('hex');
      const id = `snap_${stamp}_${shortRand}`;
      const snapDir = resolveSafeChildPath(this.snapshotsDir, id);
      const payloadDir = path.join(snapDir, 'catalog');

      fs.mkdirSync(payloadDir, { recursive: true });

      const hashes = {};
      for (const topFile of TOP_CONFIG_FILES) {
        const src = path.join(this.catalogDir, topFile);
        if (fs.existsSync(src)) {
          const buf = fs.readFileSync(src);
          hashes[topFile] = sha256Buffer(buf);
          fs.writeFileSync(path.join(payloadDir, topFile), buf);
        }
      }

      const skillsSrc = path.join(this.catalogDir, 'skills');
      if (fs.existsSync(skillsSrc)) {
        const skillHashes = copyTreeWithHashes(skillsSrc, path.join(payloadDir, 'skills'));
        for (const [k, v] of Object.entries(skillHashes)) {
          hashes[`skills/${k}`] = v;
        }
      }

      const rawReason = String(reason || '变更').slice(0, 140);
      const displayReason = pinned || rawReason.startsWith('改动前备份：') || rawReason.includes('基线')
        ? rawReason
        : `改动前备份：${rawReason}`;

      const meta = {
        id,
        createdAt: now.toISOString(),
        actor: safeActor,
        reason: displayReason,
        pinned,
        ...(coalesceKey ? { coalesceKey } : {}),
        fileCount: Object.keys(hashes).length,
        hashes
      };

      atomicWriteFile(path.join(snapDir, 'manifest.json'), JSON.stringify(meta, null, 2) + '\n');
      if (!opts.skipPrune) {
        this._pruneOldSnapshots();
      }
      return meta;
    });
  }

  setPinned(snapshotId, pinned = true) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(snapshotId, 'snapshotId');
      const snapDir = resolveSafeChildPath(this.snapshotsDir, snapshotId);
      const mfPath = path.join(snapDir, 'manifest.json');
      if (!fs.existsSync(mfPath)) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }
      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      manifest.pinned = Boolean(pinned);
      atomicWriteFile(mfPath, JSON.stringify(manifest, null, 2) + '\n');
      return { id: manifest.id, pinned: manifest.pinned, reason: manifest.reason };
    });
  }

  listSnapshots() {
    if (!fs.existsSync(this.snapshotsDir)) return [];
    const entries = fs.readdirSync(this.snapshotsDir, { withFileTypes: true });
    const list = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mf = path.join(this.snapshotsDir, entry.name, 'manifest.json');
      if (fs.existsSync(mf)) {
        try {
          const data = JSON.parse(fs.readFileSync(mf, 'utf8'));
          const skillIdSet = new Set();
          for (const rel of Object.keys(data.hashes || {})) {
            const m = rel.match(/^skills\/([^/]+)\//);
            if (m) skillIdSet.add(m[1]);
          }
          list.push({
            id: data.id,
            createdAt: data.createdAt,
            actor: data.actor,
            reason: data.reason,
            pinned: Boolean(data.pinned),
            coalesceKey: data.coalesceKey || null,
            fileCount: data.fileCount,
            skillIds: [...skillIdSet].sort()
          });
        } catch (_corruptMf) { /* skip unreadable snapshot manifest */ }
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  rollback(snapshotId, actor = 'User') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(snapshotId, 'snapshotId');
      const safeActor = validateActor(actor);
      const snapDir = resolveSafeChildPath(this.snapshotsDir, snapshotId);
      const mfPath = path.join(snapDir, 'manifest.json');
      const payloadDir = path.join(snapDir, 'catalog');

      if (!fs.existsSync(mfPath) || !fs.existsSync(payloadDir)) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));

      const verifiedBuffers = verifyAndReadSnapshotFiles(payloadDir, Object.entries(manifest.hashes || {}), payloadDir, '');

      const topBuffers = {};
      for (const topFile of TOP_CONFIG_FILES) {
        if (verifiedBuffers.has(topFile)) {
          topBuffers[topFile] = verifiedBuffers.get(topFile);
        }
      }

      const preSnap = this.createSnapshot(`回滚至 ${snapshotId}`, safeActor, { skipPrune: true });

      const stageSkills = path.join(this.catalogDir, `.rosetta-tmp-skills-stage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      materializeVerifiedFiles(stageSkills, verifiedBuffers, 'skills/');

      const prevTopState = {};
      for (const topFile of TOP_CONFIG_FILES) {
        const curPath = path.join(this.catalogDir, topFile);
        prevTopState[topFile] = fs.existsSync(curPath) ? fs.readFileSync(curPath) : null;
      }

      const liveSkills = path.join(this.catalogDir, 'skills');
      const oldBackup = path.join(this.catalogDir, `.rosetta-tmp-skills-old-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
      let swappedSkills = false;
      const writtenTopFiles = [];

      try {
        if (fs.existsSync(liveSkills)) {
          fs.renameSync(liveSkills, oldBackup);
        }
        fs.renameSync(stageSkills, liveSkills);
        swappedSkills = true;

        for (const topFile of TOP_CONFIG_FILES) {
          const dst = path.join(this.catalogDir, topFile);
          if (Object.prototype.hasOwnProperty.call(topBuffers, topFile)) {
            atomicWriteWithRetry(dst, topBuffers[topFile]);
            writtenTopFiles.push(topFile);
          }
        }
      } catch (err) {
        for (const topFile of writtenTopFiles) {
          const dst = path.join(this.catalogDir, topFile);
          try {
            if (prevTopState[topFile] !== null) atomicWriteFile(dst, prevTopState[topFile]);
            else if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
          } catch (_revertTopErr) { /* best effort */ }
        }
        if (swappedSkills && fs.existsSync(oldBackup)) {
          try {
            if (fs.existsSync(liveSkills)) fs.renameSync(liveSkills, stageSkills);
            fs.renameSync(oldBackup, liveSkills);
          } catch (_restoreSkillsErr) { /* best effort */ }
        } else if (!fs.existsSync(liveSkills) && fs.existsSync(oldBackup)) {
          try { fs.renameSync(oldBackup, liveSkills); } catch (_restoreErr) { /* best effort */ }
        }
        if (fs.existsSync(stageSkills)) {
          try { fs.rmSync(stageSkills, { recursive: true, force: true }); } catch (_cleanErr) { /* best effort */ }
        }
        throw err;
      }

      if (fs.existsSync(oldBackup)) {
        try { fs.rmSync(oldBackup, { recursive: true, force: true }); } catch (_rmOldErr) { /* best effort */ }
      }

      this._pruneOldSnapshots(new Set([snapshotId, preSnap.id]));

      return {
        restoredSnapshotId: snapshotId,
        safetySnapshotId: preSnap.id,
        restoredAt: new Date().toISOString()
      };
    });
  }

  rollbackSkill(snapshotId, skillId, actor = 'User') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(snapshotId, 'snapshotId');
      validateSlug(skillId, 'skillId');
      const safeActor = validateActor(actor);
      const snapDir = resolveSafeChildPath(this.snapshotsDir, snapshotId);
      const mfPath = path.join(snapDir, 'manifest.json');
      const payloadDir = path.join(snapDir, 'catalog');

      if (!fs.existsSync(mfPath) || !fs.existsSync(payloadDir)) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      const prefix = `skills/${skillId}/`;
      const skillEntries = Object.entries(manifest.hashes || {}).filter(([relPath]) => relPath.startsWith(prefix));
      const snapSkillDir = resolveSafeChildPath(path.join(payloadDir, 'skills'), skillId);

      if (skillEntries.length === 0 || !fs.existsSync(snapSkillDir)) {
        throw new Error(`Snapshot ${snapshotId} does not contain skill "${skillId}".`);
      }

      const verifiedBuffers = verifyAndReadSnapshotFiles(payloadDir, skillEntries, snapSkillDir, `skills/${skillId}`);

      const preSnap = this.createSnapshot(`单卡回滚 ${skillId} 至 ${snapshotId}`, safeActor, { skipPrune: true });

      const liveSkillsRoot = path.join(this.catalogDir, 'skills');
      fs.mkdirSync(liveSkillsRoot, { recursive: true });
      const stageDir = path.join(liveSkillsRoot, `.rosetta-tmp-skill-stage-${skillId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      try {
        materializeVerifiedFiles(stageDir, verifiedBuffers, prefix);
      } catch (matErr) {
        if (fs.existsSync(stageDir)) {
          try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_c) { /* ignore */ }
        }
        throw matErr;
      }

      const liveSkillDir = resolveSafeChildPath(liveSkillsRoot, skillId);
      const oldBackup = path.join(liveSkillsRoot, `.rosetta-tmp-skill-old-${skillId}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);
      let movedOld = false;
      try {
        if (fs.existsSync(liveSkillDir)) {
          fs.renameSync(liveSkillDir, oldBackup);
          movedOld = true;
        }
        fs.renameSync(stageDir, liveSkillDir);
      } catch (err) {
        if (movedOld && fs.existsSync(oldBackup) && !fs.existsSync(liveSkillDir)) {
          try { fs.renameSync(oldBackup, liveSkillDir); } catch (_revertErr) { /* best effort */ }
        }
        if (fs.existsSync(stageDir)) {
          try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_cleanErr) { /* best effort */ }
        }
        throw err;
      }

      if (fs.existsSync(oldBackup)) {
        try { fs.rmSync(oldBackup, { recursive: true, force: true }); } catch (_rmOldErr) { /* best effort */ }
      }

      this._pruneOldSnapshots(new Set([snapshotId, preSnap.id]));

      return {
        rolledBackTo: snapshotId,
        restoredSnapshotId: snapshotId,
        skillId,
        safetySnapshotId: preSnap.id,
        fileCount: skillEntries.length,
        restoredAt: new Date().toISOString()
      };
    });
  }

  _pruneOldSnapshots(protectIds = new Set()) {
    const all = this.listSnapshots();
    const unpinned = all.filter((s) => !s.pinned);
    if (unpinned.length <= this.maxUnpinnedSnapshots) return;
    const candidates = unpinned.filter((s) => !protectIds.has(s.id));
    const excess = unpinned.length - this.maxUnpinnedSnapshots;
    const toRemove = candidates.slice(-excess);
    for (const item of toRemove) {
      try {
        const dir = resolveSafeChildPath(this.snapshotsDir, item.id);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_pruneErr) { /* skip locked snapshot folder */ }
    }
  }
}

module.exports = {
  TOP_CONFIG_FILES,
  atomicWriteFile,
  sha256Buffer,
  SnapshotStore
};
