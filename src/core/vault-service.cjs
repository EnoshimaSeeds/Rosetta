'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError, validateSlug } = require('../contracts/schema.cjs');
const { atomicWriteFile } = require('./snapshot-store.cjs');
const { withCatalogLock } = require('./lock-and-audit.cjs');

const VALID_STATUSES = new Set(['active', 'superseded', 'withdrawn']);
const MAX_SNIPPET_BYTES = 4096;
const MAX_SNIPPET_LINES = 60;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function isInsideRoot(targetPath, rootDir) {
  const resolvedRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
  const resolvedTarget = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function parseLineRange(rangeStr) {
  const m = String(rangeStr || '').trim().match(/^L?(\d+)(?:\s*[-–:]\s*L?(\d+))?$/i);
  if (!m) return null;
  const start = Math.max(1, parseInt(m[1], 10));
  const end = m[2] ? Math.max(start, parseInt(m[2], 10)) : start;
  return { start, end };
}

function sliceLines(filePath, lineRange, maxLines = MAX_SNIPPET_LINES) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const startIdx = Math.max(0, (lineRange ? lineRange.start : 1) - 1);
  const requestedEnd = lineRange ? lineRange.end : Math.min(lines.length, startIdx + maxLines);
  const clampedEnd = Math.min(lines.length, startIdx + maxLines, requestedEnd);
  let slice = lines.slice(startIdx, clampedEnd).join('\n');
  let truncated = clampedEnd < requestedEnd;
  if (Buffer.byteLength(slice, 'utf8') > MAX_SNIPPET_BYTES) {
    while (Buffer.byteLength(slice, 'utf8') > MAX_SNIPPET_BYTES && slice.length > 0) {
      slice = slice.slice(0, Math.floor(slice.length * 0.85));
    }
    truncated = true;
  }
  return {
    startLine: startIdx + 1,
    endLine: clampedEnd,
    totalLines: lines.length,
    bytes: Buffer.byteLength(slice, 'utf8'),
    sourceBytes: Buffer.byteLength(raw, 'utf8'),
    truncated,
    text: slice
  };
}

class VaultService {
  constructor(rosettaRoot, options = {}) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.manifestPath = options.manifestPath
      ? path.resolve(options.manifestPath)
      : path.join(this.rosettaRoot, 'runtime', 'vault-manifest.json');
    this.allowedRoots = Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0
      ? options.allowedRoots.map((r) => path.resolve(r))
      : [
          this.rosettaRoot,
          path.resolve(this.rosettaRoot, '..')
        ];
  }

  resolveAllowedSourcePath(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new ValidationError('ERR_INVALID_VAULT_PATH', 'Vault sourcePath is required.');
    }
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.rosettaRoot, rawPath);
    if (candidate === path.parse(candidate).root) {
      throw new ValidationError('ERR_VAULT_PATH_FORBIDDEN', 'Drive root is forbidden as a vault source.');
    }
    const allowed = this.allowedRoots.some((root) => isInsideRoot(candidate, root));
    if (!allowed) {
      throw new ValidationError('ERR_VAULT_PATH_OUTSIDE_ALLOWLIST', `Source path is outside allowed workspace roots: ${rawPath}`);
    }
    return candidate;
  }

  readManifest() {
    if (!fs.existsSync(this.manifestPath)) {
      return { version: 1, updatedAt: null, entries: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
      return {
        version: parsed.version || 1,
        updatedAt: parsed.updatedAt || null,
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } catch (_err) {
      return { version: 1, updatedAt: null, entries: [] };
    }
  }

  writeManifest(manifest) {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: manifest.entries || []
    };
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    atomicWriteFile(this.manifestPath, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }

  verifyEntry(entry) {
    if (!entry) return { freshness: 'MISSING', exists: false };
    if (entry.status === 'withdrawn') {
      return { freshness: 'WITHDRAWN', exists: false, reason: '该交付件已被交付人撤回，不可引用。' };
    }
    if (entry.status === 'superseded') {
      return {
        freshness: 'SUPERSEDED',
        exists: false,
        supersededBy: entry.supersededBy || null,
        reason: entry.supersededBy
          ? `该版本已被 ${entry.supersededBy} 取代，请改查现行版本。`
          : '该版本已被新版取代，请先核对现行清单。'
      };
    }

    let resolvedPath;
    try {
      resolvedPath = this.resolveAllowedSourcePath(entry.sourcePath);
    } catch (err) {
      return { freshness: 'MISSING', exists: false, reason: err.message };
    }

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return {
        freshness: 'MISSING',
        exists: false,
        resolvedPath,
        reason: '原件文件已遗失或被移动，请勿采信旧摘要。'
      };
    }

    const stat = fs.statSync(resolvedPath);
    const liveSha256 = sha256File(resolvedPath);
    if (liveSha256 !== entry.sha256) {
      return {
        freshness: 'STALE',
        exists: true,
        resolvedPath,
        recordedSha256: entry.sha256,
        liveSha256,
        recordedSize: entry.size,
        liveSize: stat.size,
        reason: '底层原件内容哈希已变更，索引摘要可能过期；请按锚点回读当前原件确认后再引用。'
      };
    }

    return {
      freshness: 'CURRENT',
      exists: true,
      resolvedPath,
      liveSha256,
      liveSize: stat.size
    };
  }

  registerEntry(input = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      const id = validateSlug(input.id, 'vaultId');
      const project = String(input.project || 'General').trim().slice(0, 64);
      const title = String(input.title || id).trim().slice(0, 140);
      const summary = String(input.summary || '').trim().slice(0, 600);
      if (!summary) {
        throw new ValidationError('ERR_EMPTY_VAULT_SUMMARY', 'Vault entry summary is required.');
      }
      const status = VALID_STATUSES.has(input.status) ? input.status : 'active';
      const resolvedPath = this.resolveAllowedSourcePath(input.sourcePath);
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw new ValidationError('ERR_VAULT_SOURCE_MISSING', `Vault source file not found: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      const sha256 = sha256File(resolvedPath);

      const anchors = Array.isArray(input.anchors)
        ? input.anchors.slice(0, 16).map((a) => ({
            heading: String(a.heading || '').trim().slice(0, 120),
            lines: a.lines ? String(a.lines).trim().slice(0, 24) : '',
            note: a.note ? String(a.note).trim().slice(0, 240) : ''
          })).filter((a) => a.heading)
        : [];

      const tags = Array.isArray(input.tags)
        ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10)
        : [];

      const entry = {
        id,
        project,
        title,
        sourcePath: input.sourcePath,
        version: String(input.version || '1.0').trim().slice(0, 32),
        status,
        supersededBy: input.supersededBy ? validateSlug(input.supersededBy, 'supersededBy') : null,
        owner: String(input.owner || 'unknown').trim().slice(0, 48),
        sha256,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        anchors,
        summary,
        tags,
        updatedAt: new Date().toISOString()
      };

      const manifest = this.readManifest();
      const idx = manifest.entries.findIndex((e) => e.id === id);
      if (idx >= 0) manifest.entries[idx] = entry;
      else manifest.entries.push(entry);
      this.writeManifest(manifest);
      return entry;
    });
  }

  markSuperseded(oldId, newId) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(oldId, 'oldId');
      validateSlug(newId, 'newId');
      const manifest = this.readManifest();
      const target = manifest.entries.find((e) => e.id === oldId);
      if (!target) throw new ValidationError('ERR_VAULT_NOT_FOUND', `Vault entry not found: ${oldId}`);
      if (!manifest.entries.some((e) => e.id === newId)) {
        throw new ValidationError('ERR_VAULT_NOT_FOUND', `Replacement vault entry not found: ${newId}`);
      }
      target.status = 'superseded';
      target.supersededBy = newId;
      target.updatedAt = new Date().toISOString();
      this.writeManifest(manifest);
      return target;
    });
  }

  withdrawEntry(id) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(id, 'vaultId');
      const manifest = this.readManifest();
      const target = manifest.entries.find((e) => e.id === id);
      if (!target) throw new ValidationError('ERR_VAULT_NOT_FOUND', `Vault entry not found: ${id}`);
      target.status = 'withdrawn';
      target.updatedAt = new Date().toISOString();
      this.writeManifest(manifest);
      return target;
    });
  }

  listEntries(opts = {}) {
    const manifest = this.readManifest();
    const projectFilter = opts.project ? String(opts.project).trim().toLowerCase() : '';
    const queryFilter = opts.query ? String(opts.query).trim().toLowerCase() : '';
    const includeInactive = Boolean(opts.includeInactive);

    let rows = manifest.entries.slice();
    if (!includeInactive) {
      rows = rows.filter((e) => e.status === 'active');
    }
    if (projectFilter) {
      rows = rows.filter((e) => String(e.project || '').toLowerCase() === projectFilter);
    }
    if (queryFilter) {
      const tokens = queryFilter.split(/\s+/).filter(Boolean);
      rows = rows.filter((e) => {
        const hay = [
          e.id, e.project, e.title, e.summary, e.owner,
          ...(e.tags || []),
          ...(e.anchors || []).map((a) => `${a.heading} ${a.note}`)
        ].join(' ').toLowerCase();
        return tokens.every((tk) => hay.includes(tk));
      });
    }

    return {
      totalEntries: manifest.entries.length,
      matchedCount: rows.length,
      entries: rows.map((e) => ({
        id: e.id,
        project: e.project,
        title: e.title,
        version: e.version,
        status: e.status,
        ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
        owner: e.owner,
        anchorHeadings: (e.anchors || []).map((a) => a.heading),
        summary: e.summary
      }))
    };
  }

  readEntry(id, opts = {}) {
    validateSlug(id, 'vaultId');
    const manifest = this.readManifest();
    const entry = manifest.entries.find((e) => e.id === id);
    if (!entry) {
      throw new ValidationError('ERR_VAULT_NOT_FOUND', `Vault entry not found: ${id}`);
    }
    const check = this.verifyEntry(entry);
    const out = {
      id: entry.id,
      project: entry.project,
      title: entry.title,
      sourcePath: entry.sourcePath,
      version: entry.version,
      status: entry.status,
      ...(entry.supersededBy ? { supersededBy: entry.supersededBy } : {}),
      owner: entry.owner,
      freshness: check.freshness,
      ...(check.reason ? { freshnessNote: check.reason } : {}),
      sha256: entry.sha256,
      ...(check.liveSha256 && check.liveSha256 !== entry.sha256 ? { liveSha256: check.liveSha256 } : {}),
      summary: entry.summary,
      anchors: entry.anchors || [],
      tags: entry.tags || [],
      updatedAt: entry.updatedAt
    };

    const wantsSlice = Boolean(opts.includeSnippet || opts.anchor);
    if (wantsSlice && check.exists && check.resolvedPath) {
      let chosenAnchor = null;
      if (opts.anchor && Array.isArray(entry.anchors) && entry.anchors.length > 0) {
        const needle = String(opts.anchor).trim().toLowerCase();
        chosenAnchor = entry.anchors.find((a) => a.heading.toLowerCase().includes(needle)) || null;
      } else if (Array.isArray(entry.anchors) && entry.anchors.length > 0) {
        chosenAnchor = entry.anchors[0];
      }
      const lineRange = chosenAnchor && chosenAnchor.lines ? parseLineRange(chosenAnchor.lines) : null;
      out.selectedAnchor = chosenAnchor ? chosenAnchor.heading : null;
      out.snippet = sliceLines(check.resolvedPath, lineRange, opts.maxLines || MAX_SNIPPET_LINES);
    }

    return out;
  }

  verifyAll() {
    const manifest = this.readManifest();
    const results = manifest.entries.map((entry) => {
      const check = this.verifyEntry(entry);
      return {
        id: entry.id,
        project: entry.project,
        status: entry.status,
        freshness: check.freshness,
        ...(check.supersededBy ? { supersededBy: check.supersededBy } : {}),
        ...(check.reason ? { note: check.reason } : {})
      };
    });
    const counts = { CURRENT: 0, STALE: 0, MISSING: 0, SUPERSEDED: 0, WITHDRAWN: 0 };
    for (const r of results) {
      counts[r.freshness] = (counts[r.freshness] || 0) + 1;
    }
    return {
      manifestPath: this.manifestPath,
      total: results.length,
      counts,
      allActiveCurrent: counts.STALE === 0 && counts.MISSING === 0,
      results
    };
  }
}

module.exports = {
  VaultService,
  sha256File,
  parseLineRange
};
