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

function buildMergedExtraFiles(skillDir, payload = {}, existingFiles = null, opts = {}) {
  const strict = opts.strict !== false;
  const diskFiles = existingFiles || (fs.existsSync(skillDir) ? readAllExtraFilesFromDir(skillDir, { strict }) : {});
  const merged = Object.assign({}, diskFiles);

  for (const field of ['scripts', 'references', 'extraFiles']) {
    if (Array.isArray(payload[field])) {
      throw new ValidationError('ERR_INVALID_SUBFILE_MAP', `Payload.${field} must be a filename->content map object, not an array.`);
    }
  }
  const scriptsExplicit = payload.scripts !== undefined && payload.scripts !== null && typeof payload.scripts === 'object';
  const refsExplicit = payload.references !== undefined && payload.references !== null && typeof payload.references === 'object';
  const extraExplicit = payload.extraFiles !== undefined && payload.extraFiles !== null && typeof payload.extraFiles === 'object';

  if (scriptsExplicit) {
    for (const k of Object.keys(merged)) {
      if (k.startsWith('scripts/')) delete merged[k];
    }
    for (const [sName, sCode] of Object.entries(payload.scripts)) {
      validateSafeSubFileName(sName, 'script filename');
      merged[`scripts/${sName}`] = assertCleanTextPayload(sCode, `scripts/${sName}`);
    }
  }

  if (refsExplicit) {
    for (const k of Object.keys(merged)) {
      if (k.startsWith('references/')) delete merged[k];
    }
    for (const [rName, rText] of Object.entries(payload.references)) {
      validateSafeSubFileName(rName, 'reference filename');
      merged[`references/${rName}`] = assertCleanTextPayload(rText, `references/${rName}`);
    }
  }

  if (extraExplicit) {
    for (const [relPath, content] of Object.entries(payload.extraFiles)) {
      const parts = String(relPath || '').replace(/\\/g, '/').split('/');
      if (parts.length !== 2 || !ALLOWED_SUBDIRS.has(parts[0])) {
        throw new ValidationError('ERR_INVALID_EXTRA_PATH', `Extra file path must be <subdir>/<filename>: ${relPath}`);
      }
      validateSafeSubFileName(parts[1], 'extra filename');
      merged[`${parts[0]}/${parts[1]}`] = assertCleanTextPayload(content, `${parts[0]}/${parts[1]}`);
    }
  }

  return {
    extraFiles: merged,
    scriptsExplicit,
    refsExplicit,
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

module.exports = {
  ALLOWED_SUBDIRS,
  MAX_SKILL_FILE_BYTES,
  MAX_SUBDIR_DEPTH,
  validateSafeSubFileName,
  readAllExtraFilesFromDir,
  buildMergedExtraFiles,
  writeManagedSubdir,
  computeBundleDiff
};
