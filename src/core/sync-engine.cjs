'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSlug, resolveSafeChildPath } = require('../contracts/schema.cjs');
const { withCatalogLock, resolveAuditOrigin } = require('./lock-and-audit.cjs');
const { syncExternalLinksForAgent } = require('./external-skills-service.cjs');
const { resolveDshSkillsDir } = require('./dsh-config-generator.cjs');

const MANAGED_FILE = '.rosetta-managed.json';

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_ignored) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

function isLockError(err) {
  return Boolean(err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES'));
}

function withWindowsRetry(fn, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (isLockError(err) && i < attempts - 1) {
        sleepSync(35 * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function writeFileIfChanged(dstFile, srcBuf) {
  if (fs.existsSync(dstFile)) {
    try {
      const existing = fs.readFileSync(dstFile);
      if (existing.equals(srcBuf)) {
        return false;
      }
    } catch (_readErr) { /* proceed to write */ }
  }
  withWindowsRetry(() => {
    const parent = path.dirname(dstFile);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    fs.writeFileSync(dstFile, srcBuf);
  });
  return true;
}

function clearSkillDirectory(dirPath, { removeRootDir = true } = {}) {
  if (!fs.existsSync(dirPath)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (isLockError(err)) return;
    throw err;
  }

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      clearSkillDirectory(full, { removeRootDir: true });
    } else {
      withWindowsRetry(() => fs.unlinkSync(full));
    }
  }

  if (removeRootDir) {
    try {
      fs.rmdirSync(dirPath);
    } catch (_busyDir) { /* watcher holds directory handle */ }
  }
}

function syncSkillInPlace(srcSkillDir, dstSkillDir, depth = 0) {
  if (depth >= 2) return;
  withWindowsRetry(() => {
    if (!fs.existsSync(dstSkillDir)) {
      fs.mkdirSync(dstSkillDir, { recursive: true });
    } else {
      fs.readdirSync(dstSkillDir);
    }
  }, 2);

  const expectedEntries = new Set();
  const entries = fs.readdirSync(srcSkillDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (depth === 0 && entry.name === 'rosetta.meta.json') continue;
    const s = path.join(srcSkillDir, entry.name);
    const lstat = fs.lstatSync(s);
    if (lstat.isSymbolicLink()) continue;
    const d = path.join(dstSkillDir, entry.name);
    if (lstat.isDirectory()) {
      if (depth + 1 >= 2) continue;
      expectedEntries.add(entry.name);
      syncSkillInPlace(s, d, depth + 1);
    } else if (lstat.isFile()) {
      if (lstat.size > 512 * 1024) continue;
      const buf = fs.readFileSync(s);
      if (buf.includes(0)) continue;
      expectedEntries.add(entry.name);
      writeFileIfChanged(d, buf);
    }
  }

  for (const existing of fs.readdirSync(dstSkillDir, { withFileTypes: true })) {
    if (!expectedEntries.has(existing.name)) {
      const stalePath = path.join(dstSkillDir, existing.name);
      if (existing.isDirectory()) {
        clearSkillDirectory(stalePath, { removeRootDir: true });
      } else {
        try {
          withWindowsRetry(() => fs.unlinkSync(stalePath));
        } catch (_busyFile) { /* best-effort cleanup */ }
      }
    }
  }
}

function isNonEmptyUnmanagedDirectory(dirPath, isManagedByRosetta) {
  if (isManagedByRosetta || !fs.existsSync(dirPath)) return false;
  try {
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) return true;
    const entries = fs.readdirSync(dirPath);
    return entries.length > 0;
  } catch (_lockErr) {
    return false;
  }
}

function syncManagedSkillsFolder(catalogSkillsDir, targetSkillsRoot, desiredSkillIds, opts = {}) {
  const preserveShellOnUnmount = Boolean(opts.preserveShellOnUnmount);
  const frozenSet = opts.frozenSkillIds instanceof Set ? opts.frozenSkillIds : new Set(opts.frozenSkillIds || []);
  withWindowsRetry(() => {
    if (!fs.existsSync(targetSkillsRoot)) {
      fs.mkdirSync(targetSkillsRoot, { recursive: true });
    }
  });

  const markerPath = path.join(targetSkillsRoot, MANAGED_FILE);
  let previouslyManaged = [];
  let prevDirMapping = {};
  if (fs.existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (Array.isArray(parsed.managedSkills)) previouslyManaged = parsed.managedSkills;
      if (parsed.dirMapping && typeof parsed.dirMapping === 'object') prevDirMapping = parsed.dirMapping;
    } catch (_badMarker) { /* fresh marker state */ }
  }

  const prevManagedSet = new Set(previouslyManaged);
  const desiredSet = new Set(desiredSkillIds);
  const warnings = [];
  const rerouted = [];
  const skippedCollisions = [];

  if (desiredSkillIds.length + frozenSet.size === 0 && previouslyManaged.length >= 3 && !opts.allowEmptyWipe) {
    warnings.push(`熔断保护：检测到待同步技能数为 0（原已托管 ${previouslyManaged.length} 项），已阻止自动清空目标目录`);
    return {
      targetSkillsRoot,
      synced: 0,
      removed: 0,
      skills: previouslyManaged,
      rerouted,
      skippedCollisions,
      warnings
    };
  }

  let removed = 0;
  const preservedFrozen = [];
  const nextDirMapping = {};
  for (const oldId of previouslyManaged) {
    if (frozenSet.has(oldId)) {
      preservedFrozen.push(oldId);
      nextDirMapping[oldId] = prevDirMapping[oldId] || oldId;
      continue;
    }
    if (!desiredSet.has(oldId)) {
      try {
        validateSlug(oldId);
        // Only remove the exact directory Rosetta previously recorded as owning for this skill.
        const ownedFolder = prevDirMapping[oldId] || oldId;
        validateSlug(ownedFolder);
        const oldDir = resolveSafeChildPath(targetSkillsRoot, ownedFolder);
        if (fs.existsSync(oldDir)) {
          clearSkillDirectory(oldDir, { removeRootDir: !preserveShellOnUnmount });
        }
        removed++;
      } catch (err) {
        warnings.push(`卸下 ${oldId} 跳过句柄占用 (${err.code || err.message})`);
      }
    }
  }

  let synced = 0;
  const activeManaged = [...preservedFrozen];

  for (const skillId of desiredSkillIds) {
    validateSlug(skillId);
    const srcDir = resolveSafeChildPath(catalogSkillsDir, skillId);
    if (!fs.existsSync(srcDir)) continue;

    const primaryDir = resolveSafeChildPath(targetSkillsRoot, skillId);
    const fallbackFolderName = `${skillId}_mounted`;
    const fallbackDir = resolveSafeChildPath(targetSkillsRoot, fallbackFolderName);
    const ownsPrimaryDir = prevManagedSet.has(skillId) && (!prevDirMapping[skillId] || prevDirMapping[skillId] === skillId);
    const ownsFallbackDir = prevManagedSet.has(skillId) && prevDirMapping[skillId] === fallbackFolderName;

    if (isNonEmptyUnmanagedDirectory(primaryDir, ownsPrimaryDir)) {
      skippedCollisions.push(skillId);
      warnings.push(`保护跳过 ${skillId}：目标目录已存在非 Rosetta 托管的同名文件夹，未覆盖原文件`);
      continue;
    }

    try {
      syncSkillInPlace(srcDir, primaryDir);
      nextDirMapping[skillId] = skillId;
      // Only clean up `_mounted` fallback dir if Rosetta previously owned it in dirMapping.
      if (ownsFallbackDir && fs.existsSync(fallbackDir)) {
        clearSkillDirectory(fallbackDir, { removeRootDir: !preserveShellOnUnmount });
      }
      activeManaged.push(skillId);
      synced++;
    } catch (primaryErr) {
      if (isLockError(primaryErr)) {
        if (isNonEmptyUnmanagedDirectory(fallbackDir, ownsFallbackDir)) {
          skippedCollisions.push(skillId);
          warnings.push(`保护跳过 ${skillId} 备用目录 (${fallbackFolderName})：目标已存在非 Rosetta 托管的同名文件夹，未覆盖原文件`);
          continue;
        }
        try {
          syncSkillInPlace(srcDir, fallbackDir);
          nextDirMapping[skillId] = fallbackFolderName;
          rerouted.push(skillId);
          activeManaged.push(skillId);
          synced++;
        } catch (fallbackErr) {
          warnings.push(`同步 ${skillId} 暂缓 (${fallbackErr.code || fallbackErr.message})`);
        }
      } else {
        warnings.push(`同步 ${skillId} 异常 (${primaryErr.code || primaryErr.message})`);
      }
    }
  }

  const markerBuf = Buffer.from(JSON.stringify({
    managedBy: 'Rosetta-DSH',
    updatedAt: new Date().toISOString(),
    managedSkills: activeManaged,
    dirMapping: nextDirMapping
  }, null, 2) + '\n', 'utf8');

  try {
    writeFileIfChanged(markerPath, markerBuf);
  } catch (err) {
    warnings.push(`写入托管索引暂缓 (${err.code || err.message})`);
  }

  return { targetSkillsRoot, synced, removed, skills: activeManaged, rerouted, skippedCollisions, warnings };
}

/**
 * Pure DeepSeek Harness (`dsh`) Sync Engine.
 * Syncs verified, hash-checked skills to `$DSH_HOME/skills` (default `~/.dsh/skills`),
 * or to an explicit project-level target directory (`opts.targetDir`, e.g. `<project>/.dsh/skills`).
 */
class SyncEngine {
  constructor(catalogService, options = {}) {
    this.catalog = catalogService;
    this.linkAdapter = options.linkAdapter || null;
    this.targets = {
      dsh: resolveDshSkillsDir(this.catalog.rosettaRoot, options)
    };
  }

  sync(opts = {}) {
    return withCatalogLock(this.catalog.rosettaRoot, () => {
      const origin = resolveAuditOrigin(opts, 'system');
      const targetRoot = opts.targetDir ? path.resolve(opts.targetDir) : this.targets.dsh;

      const skills = this.catalog.listSkills();
      const externalSkills = this.catalog.externalSkills.listExternalSkills();
      const desiredDsh = [];
      const frozenDsh = new Set();
      const tamperWarnings = [];

      for (const s of skills) {
        const liveHash = this.catalog.computeLiveSkillHash(s.id);
        const passed = Boolean(s.security && s.security.passed);

        if (!s.contentHash || s.contentHash !== liveHash) {
          tamperWarnings.push(
            `[tamper-guard] 拦截 ${s.id}：磁盘文件（含 SKILL.md / references / scripts）哈希与入库记录不一致，已保留 DeepSeek Harness 现有干净版本，请通过 Rosetta 桌面端保存或审批刷新哈希后再同步`
          );
          if (s.assigned && s.assigned.dsh) {
            frozenDsh.add(s.id);
          }
          continue;
        }

        if (!passed) continue;
        if (s.assigned && s.assigned.dsh) {
          desiredDsh.push(s.id);
        }
      }

      const report = {
        syncedAt: new Date().toISOString(),
        targetSkillsRoot: targetRoot,
        warnings: [...tamperWarnings],
        notices: [],
        results: {},
        externalResults: {}
      };

      try {
        const out = syncManagedSkillsFolder(this.catalog.skillsDir, targetRoot, desiredDsh, {
          frozenSkillIds: frozenDsh,
          allowEmptyWipe: Boolean(opts.allowEmptyWipe)
        });
        report.results.dsh = out;
        if (Array.isArray(out.warnings) && out.warnings.length > 0) {
          report.warnings.push(...out.warnings.map((w) => `[dsh] ${w}`));
        }
      } catch (err) {
        report.results.dsh = { targetSkillsRoot: targetRoot, synced: 0, removed: 0, skills: [], error: err.message };
        report.warnings.push(`[dsh] ${err.code || err.message}`);
      }

      try {
        const extOut = syncExternalLinksForAgent('dsh', targetRoot, externalSkills, this.linkAdapter);
        report.externalResults.dsh = extOut;
        if (Array.isArray(extOut.warnings) && extOut.warnings.length > 0) {
          report.warnings.push(...extOut.warnings.map((w) => `[dsh:ext] ${w}`));
        }
      } catch (err) {
        report.externalResults.dsh = { linked: [], removed: 0, error: err.message };
        report.warnings.push(`[dsh:ext] ${err.code || err.message}`);
      }

      report.notices.push('DeepSeek Harness 按会话缓存技能索引：首次同步或增删技能后，请新开会话或重载 DSH 生效。');

      this.catalog.audit.log(Object.assign({}, origin, {
        action: 'sync.run',
        targetId: 'dsh',
        status: report.warnings.length > 0 ? 'WARN' : 'OK',
        summary: `同步 DeepSeek Harness 完成 (${report.results.dsh ? report.results.dsh.synced : 0} 项 -> ${targetRoot})` + (report.warnings.length ? ` · 警告 ${report.warnings.length} 条` : '')
      }));

      return report;
    });
  }

  syncAll(opts = {}) {
    return this.sync(opts);
  }
}

module.exports = { SyncEngine, syncSkillInPlace, clearSkillDirectory };
