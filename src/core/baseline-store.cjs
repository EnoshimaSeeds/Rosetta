'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError, validateSlug, computeBundleHash, resolveSafeChildPath } = require('../contracts/schema.cjs');
const { scanSkillBundle } = require('./security-scanner.cjs');
const { atomicWriteFile } = require('./snapshot-store.cjs');
const { DESKTOP_SESSION_SYMBOL, withCatalogLock } = require('./lock-and-audit.cjs');
const { readAllExtraFilesFromDir, computeBundleDiff } = require('./skill-bundle-io.cjs');

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function computeFileHashMap(markdown, extraFiles) {
  const map = { 'SKILL.md': sha256Text(markdown) };
  for (const k of Object.keys(extraFiles || {}).sort()) {
    map[k] = sha256Text(extraFiles[k]);
  }
  return map;
}

function copyCleanSkillFiles(srcDir, dstDir, opts = {}) {
  const preserveMeta = Boolean(opts && opts.preserveMeta);
  if (fs.existsSync(dstDir)) {
    if (preserveMeta) {
      for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
        if (entry.name === 'rosetta.meta.json') continue;
        fs.rmSync(path.join(dstDir, entry.name), { recursive: true, force: true });
      }
    } else {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(dstDir, { recursive: true });

  function walk(curSrc, curDst, depth) {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(curSrc, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (depth === 0 && entry.name === 'rosetta.meta.json') continue;
      const s = path.join(curSrc, entry.name);
      const lstat = fs.lstatSync(s);
      if (lstat.isSymbolicLink()) continue;
      const d = path.join(curDst, entry.name);
      if (lstat.isDirectory()) {
        if (depth + 1 > 4) continue;
        fs.mkdirSync(d, { recursive: true });
        walk(s, d, depth + 1);
      } else if (lstat.isFile()) {
        fs.writeFileSync(d, fs.readFileSync(s));
      }
    }
  }

  walk(srcDir, dstDir, 0);
}

class BaselineStore {
  constructor(catalog) {
    this.catalog = catalog;
    this.rosettaRoot = catalog.rosettaRoot;
    this.baselinesDir = path.join(this.rosettaRoot, 'runtime', 'baselines');
    this._lastInspectedHash = new Map();
  }

  recordCleanBaseline(skillId) {
    validateSlug(skillId, 'skillId');
    const skillDir = resolveSafeChildPath(this.catalog.skillsDir, skillId);
    if (!fs.existsSync(skillDir)) return;
    const dstDir = resolveSafeChildPath(this.baselinesDir, skillId);
    copyCleanSkillFiles(skillDir, dstDir);
  }

  removeBaseline(skillId) {
    validateSlug(skillId, 'skillId');
    const dstDir = resolveSafeChildPath(this.baselinesDir, skillId);
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
  }

  seedCleanBaselines(opts = {}) {
    const forceRefresh = Boolean(opts && opts.forceRefresh);
    fs.mkdirSync(this.baselinesDir, { recursive: true });
    if (!fs.existsSync(this.catalog.skillsDir)) return;
    for (const entry of fs.readdirSync(this.catalog.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillId = entry.name;
      try {
        const dstDir = resolveSafeChildPath(this.baselinesDir, skillId);
        if (!forceRefresh && fs.existsSync(path.join(dstDir, 'SKILL.md'))) continue;
        const metaPath = path.join(this.catalog.skillsDir, skillId, 'rosetta.meta.json');
        if (!fs.existsSync(metaPath)) continue;
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const liveHash = this.catalog.computeLiveSkillHash(skillId);
        if (meta.contentHash && liveHash === meta.contentHash) {
          this.recordCleanBaseline(skillId);
        }
      } catch (_ignore) { /* skip broken entry */ }
    }
  }

  _findBaselineDir(skillId, expectedHash) {
    const directDir = resolveSafeChildPath(this.baselinesDir, skillId);
    if (fs.existsSync(path.join(directDir, 'SKILL.md'))) {
      if (!expectedHash) return directDir;
      try {
        const md = fs.readFileSync(path.join(directDir, 'SKILL.md'), 'utf8');
        const extra = readAllExtraFilesFromDir(directDir, { strict: false });
        if (computeBundleHash({ markdown: md, extraFiles: extra }) === expectedHash) {
          return directDir;
        }
      } catch (_e) { /* fall through to snapshots */ }
    }
    const snapsDir = this.catalog.snapshots.snapshotsDir;
    if (fs.existsSync(snapsDir) && expectedHash) {
      for (const s of this.catalog.snapshots.listSnapshots()) {
        const cand = path.join(snapsDir, s.id, 'catalog', 'skills', skillId);
        const mdPath = path.join(cand, 'SKILL.md');
        if (fs.existsSync(mdPath)) {
          try {
            const md = fs.readFileSync(mdPath, 'utf8');
            const extra = readAllExtraFilesFromDir(cand, { strict: false });
            if (computeBundleHash({ markdown: md, extraFiles: extra }) === expectedHash) {
              return cand;
            }
          } catch (_e) { /* keep searching */ }
        }
      }
    }
    return null;
  }

  resolveApprovedDir(skillId, expectedHash) {
    if (!expectedHash) {
      throw new ValidationError('ERR_UNREVIEWED_DISK_DRIFT', `技能 ${skillId} 尚未完成正式入库哈希签章，MCP 已拒绝读取。`);
    }
    const baseDir = this._findBaselineDir(skillId, expectedHash);
    if (!baseDir) {
      throw new ValidationError('ERR_UNREVIEWED_DISK_DRIFT', `技能 ${skillId} 存在未审阅的磁盘改动且无可用已批准基线，MCP 已拒绝提供未审正文。`);
    }
    return baseDir;
  }

  inspectDrift(skillId) {
    validateSlug(skillId, 'skillId');
    const skillDir = resolveSafeChildPath(this.catalog.skillsDir, skillId);
    const metaPath = path.join(skillDir, 'rosetta.meta.json');
    const mdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(mdPath) || !fs.existsSync(metaPath)) {
      throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill not found: ${skillId}`);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const liveHash = this.catalog.computeLiveSkillHash(skillId);
    const drifted = Boolean(meta.contentHash && liveHash !== meta.contentHash);

    let scannable = true;
    let unscannableError = null;
    let liveMd = '';
    let liveExtra = {};
    try {
      const mdBuf = fs.readFileSync(mdPath);
      if (mdBuf.includes(0) || mdBuf.length > 512 * 1024) {
        throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', 'SKILL.md contains null bytes or exceeds 512 KB.');
      }
      liveMd = mdBuf.toString('utf8');
      liveExtra = readAllExtraFilesFromDir(skillDir, { strict: true });
    } catch (err) {
      scannable = false;
      unscannableError = err.message;
      liveMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      liveExtra = readAllExtraFilesFromDir(skillDir, { strict: false });
    }

    const security = scannable
      ? scanSkillBundle({ markdown: liveMd, extraFiles: liveExtra })
      : { passed: false, verdict: 'BLOCKED', score: 0, counts: { critical: 1, high: 0, warn: 0 }, findings: [{ severity: 'CRITICAL', ruleId: 'UNSCANNABLE_FILE', file: skillId, line: 1, snippet: '', message: unscannableError }] };

    const baseDir = this._findBaselineDir(skillId, meta.contentHash);
    let baseMd = '';
    let baseExtra = {};
    if (baseDir) {
      baseMd = fs.readFileSync(path.join(baseDir, 'SKILL.md'), 'utf8');
      baseExtra = readAllExtraFilesFromDir(baseDir, { strict: false });
    }

    this._lastInspectedHash.set(skillId, liveHash);
    const diffText = baseDir
      ? computeBundleDiff(baseMd, liveMd, baseExtra, liveExtra)
      : `（未找到本地历史基线副本，已禁用直接采纳；记录哈希 ${meta.contentHash} -> 当前磁盘哈希 ${liveHash}。以下为当前磁盘全部文件内容供核查）\n\n` + computeBundleDiff('', liveMd, {}, liveExtra);

    return {
      skillId,
      drifted,
      hasBaselineCopy: Boolean(baseDir),
      scannable,
      unscannableError,
      stampedHash: meta.contentHash || null,
      liveHash,
      security,
      diffText
    };
  }

  resolveDrift(skillId, decision, opts = {}) {
    if (!opts || opts.desktopToken !== DESKTOP_SESSION_SYMBOL) {
      throw new ValidationError(
        'ERR_DESKTOP_APPROVAL_REQUIRED',
        '磁盘漂移的采纳或单卡还原仅限用户在 Rosetta 桌面端审阅 Diff 后执行。'
      );
    }

    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(skillId, 'skillId');
      const skillDir = resolveSafeChildPath(this.catalog.skillsDir, skillId);
      const metaPath = path.join(skillDir, 'rosetta.meta.json');
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(metaPath) || !fs.existsSync(mdPath)) {
        throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill not found: ${skillId}`);
      }

      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const currentLiveHash = this.catalog.computeLiveSkillHash(skillId);
      const expectedHash = (opts && opts.expectedLiveHash) || this._lastInspectedHash.get(skillId) || null;
      if (expectedHash && currentLiveHash !== expectedHash) {
        throw new ValidationError(
          'ERR_DRIFT_CHANGED_AFTER_REVIEW',
          `审阅 Diff 后磁盘内容再次发生变动（审阅时 ${String(expectedHash).slice(0, 10)} -> 当前 ${String(currentLiveHash || '').slice(0, 10)}），请重新打开 Diff 核对后再执行。`
        );
      }

      if (decision === 'adopt') {
        if (meta.contentHash && !this._findBaselineDir(skillId, meta.contentHash)) {
          throw new ValidationError(
            'ERR_BASELINE_NOT_FOUND',
            `未找到技能 ${skillId} 的干净历史基线副本，缺少可对比的入库基线时禁止直接采纳磁盘改动。`
          );
        }
        const mdBuf = fs.readFileSync(mdPath);
        if (mdBuf.includes(0) || mdBuf.length > 512 * 1024) {
          throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', 'SKILL.md contains null bytes or exceeds 512 KB.');
        }
        const liveMd = mdBuf.toString('utf8');
        const liveExtra = readAllExtraFilesFromDir(skillDir, { strict: true });
        const scanResult = scanSkillBundle({ markdown: liveMd, extraFiles: liveExtra });
        if (!scanResult.passed) {
          const err = new ValidationError(
            'ERR_SECURITY_BLOCKED',
            `安全检查拦截 (${scanResult.verdict})：无法采纳包含高危风险的磁盘改动。`
          );
          err.scanResult = scanResult;
          throw err;
        }

        this.catalog.snapshots.createSnapshot(`采纳磁盘改动: ${meta.title || skillId}`, 'User');
        meta.contentHash = computeBundleHash({ markdown: liveMd, extraFiles: liveExtra });
        meta.fileHashes = computeFileHashMap(liveMd, liveExtra);
        meta.security = scanResult;
        meta.updatedAt = new Date().toISOString();
        meta.updatedBy = 'User';
        atomicWriteFile(metaPath, JSON.stringify(meta, null, 2) + '\n');
        this.recordCleanBaseline(skillId);
        this._lastInspectedHash.delete(skillId);

        this.catalog.audit.log({
          actor: 'User',
          channel: 'desktop',
          action: 'skill.drift_adopt',
          targetId: skillId,
          status: 'OK',
          approval: 'direct-ui',
          summary: `审阅 Diff 后采纳磁盘改动并重新盖章「${meta.title || skillId}」(files:${scanResult.scannedFiles}, hash:${meta.contentHash.slice(0, 10)})`
        });
        return { action: 'adopted', skill: this.catalog.getSkill(skillId, { includeBody: true }) };
      }

      if (decision === 'restore') {
        const baseDir = this._findBaselineDir(skillId, meta.contentHash);
        if (!baseDir) {
          throw new ValidationError('ERR_BASELINE_NOT_FOUND', `未找到技能 ${skillId} 的干净入库基线副本，请使用快照版本库回滚。`);
        }

        this.catalog.snapshots.createSnapshot(`单卡还原磁盘漂移: ${meta.title || skillId}`, 'User');
        copyCleanSkillFiles(baseDir, skillDir, { preserveMeta: true });
        this.recordCleanBaseline(skillId);
        this._lastInspectedHash.delete(skillId);

        this.catalog.audit.log({
          actor: 'User',
          channel: 'desktop',
          action: 'skill.drift_restore',
          targetId: skillId,
          status: 'OK',
          approval: 'direct-ui',
          summary: `放弃未审磁盘改动，将「${meta.title || skillId}」单卡还原至入库基线`
        });
        return { action: 'restored', skill: this.catalog.getSkill(skillId, { includeBody: true }) };
      }

      throw new ValidationError('ERR_INVALID_DECISION', `Unsupported drift decision: ${decision}`);
    });
  }
}

module.exports = {
  computeFileHashMap,
  BaselineStore
};
