'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError, resolveSafeChildPath } = require('../contracts/schema.cjs');
const { atomicWriteFile } = require('./snapshot-store.cjs');
const { computeLineDiff } = require('./lock-and-audit.cjs');

const ALLOWED_SUBDIRS = new Set(['scripts', 'references', 'resources', 'examples', 'assets']);
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SUBDIR_DEPTH = 2;

function validateSafeSubFileName(name, label = 'filename') {
  if (typeof name !== 'string' || !SAFE_SEGMENT_RE.test(name) || name.includes('..') || name.startsWith('.')) {
    throw new ValidationError('ERR_INVALID_SCRIPT_NAME', `Invalid ${label}: ${name}`);
  }
  return name;
}

function readAllExtraFilesFromDir(skillDir, opts = {}) {
  const strict = Boolean(opts.strict);
  const maxFileBytes = opts.maxFileBytes ?? MAX_SKILL_FILE_BYTES;
  const extraFiles = {};
  if (!fs.existsSync(skillDir)) return extraFiles;

  function walk(curDir, relPrefix, depth) {
    if (depth > 64) {
      if (strict) throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', 'Skill directory nesting exceeds safety limit.');
      return;
    }
    const entries = fs.readdirSync(curDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (depth === 0 && (entry.name === 'SKILL.md' || entry.name === 'rosetta.meta.json')) continue;

      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const candidatePath = path.join(curDir, entry.name);
      const lstat = fs.lstatSync(candidatePath);

      if (lstat.isSymbolicLink()) {
        if (strict) {
          throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', `Symlinks are forbidden inside skill bundles: ${rel}`);
        }
        extraFiles[rel] = `\0SYMLINK:${fs.readlinkSync(candidatePath)}`;
        continue;
      }

      const full = resolveSafeChildPath(curDir, entry.name);
      if (lstat.isDirectory()) {
        walk(full, rel, depth + 1);
      } else if (lstat.isFile()) {
        const tooDeep = depth >= MAX_SUBDIR_DEPTH;
        const tooLarge = lstat.size > maxFileBytes;
        const buf = fs.readFileSync(full);
        const hasNullByte = buf.includes(0);

        if (strict && (tooDeep || tooLarge || hasNullByte)) {
          const reason = hasNullByte
            ? 'binary/null-byte content'
            : (tooLarge ? `size ${lstat.size} > ${maxFileBytes} bytes` : `nesting depth ${depth + 1} > ${MAX_SUBDIR_DEPTH}`);
          throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', `Unscannable file in skill bundle (${rel}): ${reason}`);
        }

        if (tooDeep || tooLarge || hasNullByte) {
          const rawDigest = crypto.createHash('sha256').update(buf).digest('hex');
          extraFiles[rel] = `\0UNSCANNABLE_SHA256:${rawDigest}:${lstat.size}`;
        } else {
          extraFiles[rel] = buf.toString('utf8');
        }
      }
    }
  }

  walk(skillDir, '', 0);
  return extraFiles;
}

function assertCleanTextPayload(content, relPath) {
  const str = String(content ?? '');
  if (str.includes('\0')) {
    throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', `Null bytes are forbidden in skill file: ${relPath}`);
  }
  if (Buffer.byteLength(str, 'utf8') > MAX_SKILL_FILE_BYTES) {
    throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', `Skill file exceeds 512 KB limit: ${relPath}`);
  }
  return str;
}

function normalizeRemoveList(raw, fieldName, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError('ERR_INVALID_REMOVE_LIST', `Payload.${fieldName} must be an array of filenames.`);
  }
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new ValidationError('ERR_INVALID_REMOVE_LIST', `Payload.${fieldName} entries must be strings.`);
    }
    validateSafeSubFileName(item, label);
    out.push(item);
  }
  return out;
}

function buildMergedExtraFiles(skillDir, payload = {}, existingFiles = null, opts = {}) {
  const strict = opts.strict !== false;
  const diskFiles = existingFiles || (fs.existsSync(skillDir) ? readAllExtraFilesFromDir(skillDir, { strict }) : {});
  const merged = Object.assign({}, diskFiles);

  for (const field of ['scripts', 'references', 'extraFiles']) {
    if (Array.isArray(payload[field])) {
      throw new ValidationError('ERR_INVALID_SUBFILE_MAP', `Payload.${field} must be a filename->content map object, not an array.`);
    }
  }
  const removeScripts = normalizeRemoveList(payload.removeScripts, 'removeScripts', 'script filename');
  const removeRefs = normalizeRemoveList(payload.removeReferences, 'removeReferences', 'reference filename');

  const scriptsExplicit = payload.scripts !== undefined && payload.scripts !== null && typeof payload.scripts === 'object';
  const refsExplicit = payload.references !== undefined && payload.references !== null && typeof payload.references === 'object';
  const extraExplicit = payload.extraFiles !== undefined && payload.extraFiles !== null && typeof payload.extraFiles === 'object';

  if (scriptsExplicit && removeScripts.length > 0) {
    const conflicts = removeScripts.filter((name) => Object.prototype.hasOwnProperty.call(payload.scripts, name));
    if (conflicts.length > 0) {
      throw new ValidationError('ERR_CONFLICTING_SUBFILE_OP', `Cannot both add/update and remove scripts: ${conflicts.join(', ')}`);
    }
  }
  if (refsExplicit && removeRefs.length > 0) {
    const conflicts = removeRefs.filter((name) => Object.prototype.hasOwnProperty.call(payload.references, name));
    if (conflicts.length > 0) {
      throw new ValidationError('ERR_CONFLICTING_SUBFILE_OP', `Cannot both add/update and remove references: ${conflicts.join(', ')}`);
    }
  }

  for (const sName of removeScripts) {
    delete merged[`scripts/${sName}`];
  }
  if (scriptsExplicit) {
    for (const [sName, sCode] of Object.entries(payload.scripts)) {
      validateSafeSubFileName(sName, 'script filename');
      merged[`scripts/${sName}`] = assertCleanTextPayload(sCode, `scripts/${sName}`);
    }
  }

  for (const rName of removeRefs) {
    delete merged[`references/${rName}`];
  }
  if (refsExplicit) {
    for (const [rName, rText] of Object.entries(payload.references)) {
      validateSafeSubFileName(rName, 'reference filename');
      merged[`references/${rName}`] = assertCleanTextPayload(rText, `references/${rName}`);
    }
  }

  const removePathSet = new Set([
    ...removeScripts.map((name) => `scripts/${name}`),
    ...removeRefs.map((name) => `references/${name}`)
  ]);

  if (extraExplicit) {
    for (const [relPath, content] of Object.entries(payload.extraFiles)) {
      const parts = String(relPath || '').replace(/\\/g, '/').split('/');
      if (parts.length !== 2 || !ALLOWED_SUBDIRS.has(parts[0])) {
        throw new ValidationError('ERR_INVALID_EXTRA_PATH', `Extra file path must be <subdir>/<filename>: ${relPath}`);
      }
      validateSafeSubFileName(parts[1], 'extra filename');
      const normRel = `${parts[0]}/${parts[1]}`;
      if (removePathSet.has(normRel)) {
        throw new ValidationError('ERR_CONFLICTING_SUBFILE_OP', `Cannot both add/update (via extraFiles) and remove: ${normRel}`);
      }
      merged[normRel] = assertCleanTextPayload(content, normRel);
    }
  }

  return {
    extraFiles: merged,
    scriptsExplicit: scriptsExplicit || removeScripts.length > 0,
    refsExplicit: refsExplicit || removeRefs.length > 0,
    extraExplicit
  };
}

function writeManagedSubdir(skillDir, subDirName, extraFiles) {
  const targetDir = path.join(skillDir, subDirName);
  const prefix = `${subDirName}/`;
  const wanted = new Map();

  for (const [relKey, content] of Object.entries(extraFiles)) {
    if (relKey.startsWith(prefix)) {
      const rest = relKey.slice(prefix.length);
      if (!rest.includes('/')) {
        wanted.set(rest, content);
      }
    }
  }

  if (wanted.size > 0) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const [fileName, content] of wanted.entries()) {
      atomicWriteFile(resolveSafeChildPath(targetDir, fileName), content);
    }
  }

  if (fs.existsSync(targetDir)) {
    for (const existing of fs.readdirSync(targetDir)) {
      if (!wanted.has(existing)) {
        fs.rmSync(resolveSafeChildPath(targetDir, existing), { recursive: true, force: true });
      }
    }
    if (fs.readdirSync(targetDir).length === 0) {
      try { fs.rmdirSync(targetDir); } catch (_e) { /* ignore busy empty dir */ }
    }
  }
}

function computeBundleDiff(oldBody = '', newBody = '', oldExtra = {}, newExtra = {}) {
  const sections = [];
  if (String(oldBody || '').trim() !== String(newBody || '').trim()) {
    sections.push(`=== SKILL.md ===\n${computeLineDiff(oldBody, newBody)}`);
  } else if (Object.keys(oldExtra).length === 0 && Object.keys(newExtra).length === 0) {
    sections.push(computeLineDiff(oldBody, newBody));
  }

  const allKeys = [...new Set([...Object.keys(oldExtra || {}), ...Object.keys(newExtra || {})])].sort();
  for (const key of allKeys) {
    const prev = Object.prototype.hasOwnProperty.call(oldExtra || {}, key) ? oldExtra[key] : '';
    const next = Object.prototype.hasOwnProperty.call(newExtra || {}, key) ? newExtra[key] : '';
    if (prev !== next) {
      sections.push(`=== ${key} ===\n${computeLineDiff(prev, next)}`);
    }
  }

  return sections.join('\n\n') || computeLineDiff(oldBody, newBody);
}

function computeFileChanges(oldBody = '', newBody = '', oldExtra = {}, newExtra = {}, opts = {}) {
  const added = [];
  const modified = [];
  const removed = [];
  const isUpdate = opts.isUpdate !== false;

  const oldB = String(oldBody || '').replace(/\r\n/g, '\n').trim();
  const newB = String(newBody || '').replace(/\r\n/g, '\n').trim();
  if (!isUpdate) {
    added.push('SKILL.md');
  } else if (oldB !== newB) {
    modified.push('SKILL.md');
  }

  const prevMap = oldExtra || {};
  const nextMap = newExtra || {};
  const allKeys = [...new Set([...Object.keys(prevMap), ...Object.keys(nextMap)])].sort();
  for (const key of allKeys) {
    const hasPrev = Object.prototype.hasOwnProperty.call(prevMap, key);
    const hasNext = Object.prototype.hasOwnProperty.call(nextMap, key);
    if (!hasPrev && hasNext) {
      added.push(key);
    } else if (hasPrev && !hasNext) {
      removed.push(key);
    } else if (prevMap[key] !== nextMap[key]) {
      modified.push(key);
    }
  }

  const notFoundRemovals = [];
  if (Array.isArray(opts.removeReferences)) {
    for (const rName of opts.removeReferences) {
      const k = `references/${rName}`;
      if (!Object.prototype.hasOwnProperty.call(prevMap, k)) notFoundRemovals.push(k);
    }
  }
  if (Array.isArray(opts.removeScripts)) {
    for (const sName of opts.removeScripts) {
      const k = `scripts/${sName}`;
      if (!Object.prototype.hasOwnProperty.call(prevMap, k)) notFoundRemovals.push(k);
    }
  }

  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
    ...(notFoundRemovals.length > 0 ? { notFoundRemovals: notFoundRemovals.sort() } : {})
  };
}

function detectDestructiveShrink(existing, nextBody, nextExtra) {
  if (!existing) return [];
  const shrunk = [];
  const checkPair = (relPath, prevText, nextText) => {
    const prevTrim = String(prevText || '').trim();
    const nextTrim = String(nextText || '').trim();
    if (prevTrim.length === 0) return;
    if (nextTrim.length === 0) {
      shrunk.push(relPath);
      return;
    }
    const prevBytes = Buffer.byteLength(prevTrim, 'utf8');
    const nextBytes = Buffer.byteLength(nextTrim, 'utf8');
    if (prevBytes >= 40 && nextBytes < prevBytes * 0.1) {
      shrunk.push(relPath);
    }
  };
  if (nextBody !== undefined) {
    checkPair('SKILL.md', existing.body || '', nextBody);
  }
  const prevExtra = existing.extraFiles || {};
  for (const [relPath, prevContent] of Object.entries(prevExtra)) {
    if (Object.prototype.hasOwnProperty.call(nextExtra || {}, relPath)) {
      checkPair(relPath, prevContent, nextExtra[relPath]);
    }
  }
  return shrunk.sort();
}

function hydrateProposalPreview(p, liveSkill, skillDir, findBrokenSubfileRefs) {
  if (!p || !p.skillPayload || !p.skillPayload.id) return;
  if (p.fileChanges && Array.isArray(p.brokenRefs)) return;
  try {
    const oldExtra = liveSkill ? (liveSkill.extraFiles || {}) : {};
    const { extraFiles: nextExtra } = buildMergedExtraFiles(skillDir, p.skillPayload, oldExtra, { strict: false });
    const nextBody = p.skillPayload.body !== undefined ? String(p.skillPayload.body) : (liveSkill ? liveSkill.body : '');
    if (!p.fileChanges) {
      p.fileChanges = computeFileChanges(liveSkill ? liveSkill.body : '', nextBody, oldExtra, nextExtra, {
        isUpdate: Boolean(liveSkill),
        removeReferences: p.skillPayload.removeReferences,
        removeScripts: p.skillPayload.removeScripts
      });
    }
    if (!Array.isArray(p.brokenRefs) && typeof findBrokenSubfileRefs === 'function') {
      p.brokenRefs = findBrokenSubfileRefs(nextBody, nextExtra);
    }
  } catch (_fallbackErr) {
    p.fileChanges = p.fileChanges || { added: [], modified: [], removed: [] };
    p.brokenRefs = Array.isArray(p.brokenRefs) ? p.brokenRefs : [];
  }
}

module.exports = {
  ALLOWED_SUBDIRS,
  MAX_SKILL_FILE_BYTES,
  MAX_SUBDIR_DEPTH,
  validateSafeSubFileName,
  readAllExtraFilesFromDir,
  buildMergedExtraFiles,
  writeManagedSubdir,
  computeBundleDiff,
  computeFileChanges,
  detectDestructiveShrink,
  hydrateProposalPreview
};
