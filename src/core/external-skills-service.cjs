'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VALID_AGENTS, ValidationError, validateSlug } = require('../contracts/schema.cjs');
const { atomicWriteFile } = require('./snapshot-store.cjs');
const { withCatalogLock, resolveAuditOrigin } = require('./lock-and-audit.cjs');

const EXTERNAL_MARKER = '.rosetta-external.json';

// Clean open-source default: no pre-pinned machine-specific external toolchains.
const DEFAULT_EXTERNAL_SKILLS = [];

function normalizedTextSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  const clean = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(clean, 'utf8')).digest('hex');
}

const BULK_MEDIA_DIRS = new Set(['templates/icons', 'templates/sounds']);
const PURE_MEDIA_RE = /\.(svg|mp3|wav|ogg|png|jpg|jpeg|webp)$/i;

function computeDirectoryTreeSha256(rootDir, opts = {}) {
  if (!fs.existsSync(rootDir)) return null;
  const skipMediaDirs = opts.skipBulkMediaDirs !== false ? BULK_MEDIA_DIRS : new Set();
  const h = crypto.createHash('sha256');

  function walkMediaManifest(curDir, relPrefix) {
    const entries = fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(curDir, entry.name);
      const rel = `${relPrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        h.update(`SYMLINK:${rel}\0${fs.readlinkSync(full)}\0`);
      } else if (entry.isDirectory()) {
        walkMediaManifest(full, rel);
      } else if (!PURE_MEDIA_RE.test(entry.name)) {
        const buf = fs.readFileSync(full);
        h.update(`FILE:${rel}\0`);
        h.update(buf);
        h.update('\0');
      } else {
        h.update(`MEDIA:${rel}\0`);
      }
    }
  }

  function walk(curDir, relPrefix) {
    const entries = fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
      const full = path.join(curDir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        h.update(`SYMLINK:${rel}\0${fs.readlinkSync(full)}\0`);
      } else if (entry.isDirectory()) {
        if (skipMediaDirs.has(rel)) walkMediaManifest(full, rel);
        else walk(full, rel);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        h.update(`FILE:${rel}\0`);
        if (buf.includes(0)) {
          h.update(buf);
        } else {
          const clean = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          h.update(Buffer.from(clean, 'utf8'));
        }
        h.update('\0');
      }
    }
  }

  walk(rootDir, '');
  return h.digest('hex');
}

function computeScriptsTreeSha256(targetSkillDir) {
  return computeDirectoryTreeSha256(path.join(targetSkillDir, 'scripts'), { skipBulkMediaDirs: false });
}

function computeTargetTreeSha256(targetSkillDir) {
  return computeDirectoryTreeSha256(targetSkillDir, { skipBulkMediaDirs: true });
}

function isInsideBase(candidatePath, baseDir) {
  const realBase = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);
  const probe = fs.existsSync(candidatePath) ? fs.realpathSync(candidatePath) : path.resolve(candidatePath);
  const rel = path.relative(realBase, probe);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isAllowedExternalTarget(rosettaRoot, resolvedTarget) {
  const rootParsed = path.parse(resolvedTarget).root;
  if (resolvedTarget === rootParsed) return false;
  const workspaceRoot = path.resolve(rosettaRoot, '..');
  const roots = [rosettaRoot, workspaceRoot];
  if (process.env.ROSETTA_ALLOW_TMP_EXTERNAL === '1') {
    roots.push(os.tmpdir());
  }
  if (process.env.ROSETTA_EXTERNAL_ALLOWLIST) {
    roots.push(...process.env.ROSETTA_EXTERNAL_ALLOWLIST.split(path.delimiter).map((p) => p.trim()).filter(Boolean));
  }
  return roots.some((base) => isInsideBase(resolvedTarget, base));
}

class ExternalSkillsService {
  constructor(catalog) {
    this.catalog = catalog;
    this.rosettaRoot = catalog.rosettaRoot;
    this.filePath = path.join(this.catalog.catalogDir, 'external-skills.json');
  }

  ensureSeedFile() {
    if (!fs.existsSync(this.filePath)) {
      atomicWriteFile(this.filePath, JSON.stringify({ version: 1, externalSkills: DEFAULT_EXTERNAL_SKILLS }, null, 2) + '\n');
    }
  }

  listExternalSkills() {
    this.ensureSeedFile();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw.externalSkills) ? raw.externalSkills : [];
      return list.map((item) => {
        const resolvedTarget = path.resolve(this.rosettaRoot, item.targetDir || '');
        const resolvedLauncher = item.launcher ? path.resolve(this.rosettaRoot, item.launcher) : null;
        const allowedPath = isAllowedExternalTarget(this.rosettaRoot, resolvedTarget);
        const targetExists = allowedPath && fs.existsSync(resolvedTarget);
        let integrityOk = targetExists;

        if (targetExists) {
          const pins = Object.assign({}, item.pinnedHashes || {});
          if (item.licenseFile && item.licenseSha256 && !pins[item.licenseFile]) {
            pins[item.licenseFile] = item.licenseSha256;
          }
          for (const [relFile, expectedHash] of Object.entries(pins)) {
            const parts = String(relFile).replace(/\\/g, '/').split('/');
            if (parts.some((p) => !p || p === '..' || p === '.')) {
              integrityOk = false;
              break;
            }
            const fPath = path.join(resolvedTarget, ...parts);
            if (!fs.existsSync(fPath) || normalizedTextSha256(fPath) !== String(expectedHash).toLowerCase()) {
              integrityOk = false;
              break;
            }
          }
          if (integrityOk && item.scriptsTreeSha256) {
            const actualTree = computeScriptsTreeSha256(resolvedTarget);
            if (!actualTree || actualTree !== String(item.scriptsTreeSha256).toLowerCase()) {
              integrityOk = false;
            }
          }
          if (integrityOk && item.targetTreeSha256) {
            const actualTargetTree = computeTargetTreeSha256(resolvedTarget);
            if (!actualTargetTree || actualTargetTree !== String(item.targetTreeSha256).toLowerCase()) {
              integrityOk = false;
            }
          }
          if (integrityOk && item.launcherSha256) {
            if (
              !resolvedLauncher ||
              !isAllowedExternalTarget(this.rosettaRoot, resolvedLauncher) ||
              !fs.existsSync(resolvedLauncher) ||
              normalizedTextSha256(resolvedLauncher) !== String(item.launcherSha256).toLowerCase()
            ) {
              integrityOk = false;
            }
          }
        }

        return Object.assign({}, item, {
          resolvedTargetDir: resolvedTarget,
          resolvedLauncher,
          allowedPath,
          targetExists,
          integrityOk
        });
      });
    } catch (_err) {
      return [];
    }
  }

  registerExternalSkill(entry, opts = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(entry.id, 'external skill id');
      const targetStr = String(entry.targetDir || '').trim();
      const resolvedTarget = path.resolve(this.rosettaRoot, targetStr);
      if (!targetStr || !isAllowedExternalTarget(this.rosettaRoot, resolvedTarget)) {
        throw new ValidationError('ERR_EXTERNAL_PATH_FORBIDDEN', `External skill targetDir must reside within workspace roots: ${targetStr}`);
      }

      const origin = resolveAuditOrigin(opts, 'script');
      this.ensureSeedFile();
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw.externalSkills) ? raw.externalSkills : [];

      const assigned = Object.assign({ dsh: false }, entry.assigned || {});
      for (const k of Object.keys(assigned)) {
        if (!VALID_AGENTS.includes(k)) delete assigned[k];
        else assigned[k] = Boolean(assigned[k]);
      }

      let cleanPins = undefined;
      if (entry.pinnedHashes && typeof entry.pinnedHashes === 'object') {
        cleanPins = {};
        for (const [k, v] of Object.entries(entry.pinnedHashes)) {
          const cleanKey = String(k).replace(/\\/g, '/');
          if (!cleanKey.includes('..')) {
            cleanPins[cleanKey] = String(v).toLowerCase();
          }
        }
      }

      const cleanEntry = {
        id: entry.id,
        title: String(entry.title || entry.id).slice(0, 100),
        summary: String(entry.summary || '').slice(0, 300),
        targetDir: targetStr,
        ...(entry.launcher ? { launcher: String(entry.launcher) } : {}),
        ...(entry.launcherSha256 ? { launcherSha256: String(entry.launcherSha256).toLowerCase() } : {}),
        version: String(entry.version || '1.0.0').slice(0, 32),
        license: String(entry.license || 'Unknown').slice(0, 200),
        ...(entry.licenseFile ? { licenseFile: String(entry.licenseFile) } : {}),
        ...(entry.licenseSha256 ? { licenseSha256: String(entry.licenseSha256).toLowerCase() } : {}),
        ...(entry.scriptsTreeSha256 ? { scriptsTreeSha256: String(entry.scriptsTreeSha256).toLowerCase() } : {}),
        ...(entry.targetTreeSha256 ? { targetTreeSha256: String(entry.targetTreeSha256).toLowerCase() } : {}),
        ...(cleanPins ? { pinnedHashes: cleanPins } : {}),
        routingNote: String(entry.routingNote || '').slice(0, 300),
        assigned
      };

      this.catalog.snapshots.createSnapshot(`登记外部链接技能: ${cleanEntry.id}`, origin.actor);
      const idx = list.findIndex((x) => x.id === cleanEntry.id);
      if (idx >= 0) list[idx] = cleanEntry;
      else list.push(cleanEntry);

      atomicWriteFile(this.filePath, JSON.stringify({ version: 1, externalSkills: list }, null, 2) + '\n');
      this.catalog.audit.log(Object.assign({}, origin, {
        action: 'external_skill.save',
        targetId: cleanEntry.id,
        summary: `登记外部链接技能「${cleanEntry.title}」(${cleanEntry.version})`
      }));
      return cleanEntry;
    });
  }

  setExternalAssignment(extId, agentMap, opts = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(extId, 'external skill id');
      const origin = resolveAuditOrigin(opts, 'script');
      this.ensureSeedFile();
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw.externalSkills) ? raw.externalSkills : [];
      const target = list.find((x) => x.id === extId);
      if (!target) {
        throw new ValidationError('ERR_EXTERNAL_SKILL_NOT_FOUND', `External skill not found: ${extId}`);
      }

      const current = Object.assign({ dsh: false }, target.assigned || {});
      const changes = [];
      for (const agent of VALID_AGENTS) {
        if (Object.prototype.hasOwnProperty.call(agentMap, agent)) {
          const next = Boolean(agentMap[agent]);
          if (current[agent] !== next) {
            current[agent] = next;
            changes.push(`${agent}=${next ? 'ON' : 'OFF'}`);
          }
        }
      }
      if (changes.length === 0) return current;

      this.catalog.snapshots.createSnapshot(`切换外部技能开关: ${extId}`, origin.actor, {
        coalesceKey: `ext-assign:${extId}`
      });
      target.assigned = current;
      atomicWriteFile(this.filePath, JSON.stringify({ version: 1, externalSkills: list }, null, 2) + '\n');
      this.catalog.audit.log(Object.assign({}, origin, {
        action: 'external_skill.assign',
        targetId: extId,
        summary: `切换外部技能挂载 (${changes.join(', ')})`
      }));
      return current;
    });
  }
}

function isSymbolicOrJunction(linkPath) {
  try {
    const st = fs.lstatSync(linkPath);
    return st.isSymbolicLink();
  } catch (_e) {
    return false;
  }
}

function removeLinkSafely(linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch (_err) {
    fs.rmdirSync(linkPath);
  }
}

function normalizeWinTarget(rawPath) {
  return String(rawPath || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

const DEFAULT_LINK_ADAPTER = {
  isLink: isSymbolicOrJunction,
  readTarget: (linkPath) => path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath).replace(/^\\\\\?\\/, '')),
  createLink: (targetDir, linkPath) => fs.symlinkSync(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir'),
  removeLink: removeLinkSafely
};

function syncExternalLinksForAgent(agentKey, linkSkillsRoot, externalItems, linkAdapter = DEFAULT_LINK_ADAPTER) {
  const adapter = linkAdapter || DEFAULT_LINK_ADAPTER;
  const warnings = [];
  const linked = [];
  const skippedMissing = [];
  let removed = 0;

  if (!linkSkillsRoot) return { linked, removed, skippedMissing, warnings };
  fs.mkdirSync(linkSkillsRoot, { recursive: true });

  const markerPath = path.join(linkSkillsRoot, EXTERNAL_MARKER);
  let prevManaged = [];
  if (fs.existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (Array.isArray(parsed.managedLinks)) prevManaged = parsed.managedLinks;
    } catch (_e) { /* fresh */ }
  }
  const prevSet = new Set(prevManaged);

  const desired = externalItems.filter((item) => item.assigned && item.assigned[agentKey]);
  const desiredIds = new Set(desired.map((x) => x.id));

  for (const oldId of prevManaged) {
    if (!desiredIds.has(oldId)) {
      validateSlug(oldId);
      const linkPath = path.join(linkSkillsRoot, oldId);
      if (adapter.isLink(linkPath)) {
        try {
          adapter.removeLink(linkPath);
          removed++;
        } catch (err) {
          warnings.push(`移除外部技能联接 ${oldId} 失败 (${err.code || err.message})`);
        }
      }
    }
  }

  for (const item of desired) {
    validateSlug(item.id);
    const linkPath = path.join(linkSkillsRoot, item.id);

    if (!item.allowedPath) {
      warnings.push(`[external-guard] 拦截外部技能 ${item.id}：目标路径不在受允许的工作区白名单内`);
      if (adapter.isLink(linkPath)) {
        try { adapter.removeLink(linkPath); removed++; } catch (_e) { /* best effort */ }
      }
      continue;
    }
    if (!item.targetExists) {
      skippedMissing.push(item.id);
      continue;
    }
    if (!item.integrityOk) {
      warnings.push(`[external-guard] 拦截并断开外部技能 ${item.id}：LICENSE / SKILL.md / scripts 目录树哈希校验未通过`);
      if (adapter.isLink(linkPath)) {
        try { adapter.removeLink(linkPath); removed++; } catch (_e) { /* best effort */ }
      }
      continue;
    }

    if (fs.existsSync(linkPath) || adapter.isLink(linkPath)) {
      if (adapter.isLink(linkPath)) {
        const curTarget = adapter.readTarget(linkPath);
        if (normalizeWinTarget(curTarget) === normalizeWinTarget(item.resolvedTargetDir)) {
          linked.push(item.id);
          continue;
        }
        if (prevSet.has(item.id)) {
          adapter.removeLink(linkPath);
        } else {
          warnings.push(`跳过外部技能 ${item.id}：存在指向其他路径的非托管联接`);
          continue;
        }
      } else {
        warnings.push(`保护跳过外部技能 ${item.id}：目标已存在真实目录，未覆盖`);
        continue;
      }
    }

    adapter.createLink(item.resolvedTargetDir, linkPath);
    linked.push(item.id);
  }

  fs.writeFileSync(markerPath, JSON.stringify({
    managedBy: 'Rosetta-External',
    updatedAt: new Date().toISOString(),
    managedLinks: linked
  }, null, 2) + '\n', 'utf8');

  return { linked, removed, skippedMissing, warnings };
}

module.exports = {
  DEFAULT_EXTERNAL_SKILLS,
  computeDirectoryTreeSha256,
  computeScriptsTreeSha256,
  computeTargetTreeSha256,
  isAllowedExternalTarget,
  ExternalSkillsService,
  syncExternalLinksForAgent
};
