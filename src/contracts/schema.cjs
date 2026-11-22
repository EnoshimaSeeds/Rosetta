'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

// Pure DeepSeek Harness host model
const VALID_AGENTS = Object.freeze(['dsh']);

const TRUSTED_SOURCE_DOMAINS = [
  'github.com',
  'google.com',
  'web.dev',
  'developer.mozilla.org',
  'anthropic.com',
  'openai.com',
  'deepseek.com',
  'mathworks.com',
  'nih.gov'
];

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function validateSlug(id, label = 'identifier') {
  if (typeof id !== 'string' || !SLUG_RE.test(id)) {
    throw new ValidationError(
      'ERR_INVALID_SLUG',
      `Invalid ${label} "${id}": must be 2-63 chars of lowercase a-z, 0-9, hyphen, or underscore.`
    );
  }
  if (WINDOWS_RESERVED.has(id.toLowerCase())) {
    throw new ValidationError(
      'ERR_RESERVED_NAME',
      `Invalid ${label} "${id}": reserved OS device name.`
    );
  }
  return id;
}

function validateActor(actor) {
  if (!actor || typeof actor !== 'string') return 'System';
  const trimmed = actor.trim();
  if (/^[A-Za-z0-9_\u4e00-\u9fa5 -]{1,32}$/.test(trimmed)) return trimmed;
  throw new ValidationError('ERR_INVALID_ACTOR', `Invalid actor name: "${actor}"`);
}

function isTrustedSourceUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return TRUSTED_SOURCE_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch (_invalid) {
    return false;
  }
}

function computeBundleHash({ markdown = '', extraFiles = {} }) {
  const h = crypto.createHash('sha256');
  h.update('SKILL.md\0');
  h.update(String(markdown || '').replace(/\r\n/g, '\n'));
  const sortedKeys = Object.keys(extraFiles || {}).sort();
  for (const k of sortedKeys) {
    h.update(`\0FILE:${k}\0`);
    h.update(String(extraFiles[k] || '').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex');
}

/**
 * Strictly confines child paths inside baseDir, blocking "..", null bytes,
 * drive jumps, and symlink escapes outside baseDir.
 */
function resolveSafeChildPath(baseDir, ...segments) {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new ValidationError('ERR_INVALID_BASE', 'Base directory is required.');
  }
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.includes('\0')) {
      throw new ValidationError('ERR_INVALID_PATH', 'Path segment contains invalid characters.');
    }
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);

  const rel = path.relative(resolvedBase, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError(
      'ERR_PATH_OUTSIDE_BOUNDARY',
      `Path escapes confined root: ${segments.join('/')}`
    );
  }

  if (fs.existsSync(resolvedBase)) {
    const realBase = fs.realpathSync(resolvedBase);
    let probe = resolvedTarget;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      const realRel = path.relative(realBase, realProbe);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw new ValidationError(
          'ERR_SYMLINK_ESCAPE',
          `Symlink escapes confined root: ${segments.join('/')}`
        );
      }
    }
  }

  return resolvedTarget;
}

function parseSkillMarkdown(rawContent) {
  if (typeof rawContent !== 'string') {
    throw new ValidationError('ERR_INVALID_MARKDOWN', 'SKILL.md content must be a string.');
  }
  const normalized = rawContent.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: normalized };
  }
  const fmLines = match[1].split('\n');
  const body = match[2];
  const fm = {};
  let currentKey = null;
  let blockMode = false;

  for (const line of fmLines) {
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (kv && !line.startsWith(' ') && !line.startsWith('\t')) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val === '>-' || val === '>' || val === '|-' || val === '|') {
        blockMode = true;
        fm[currentKey] = '';
      } else {
        blockMode = false;
        fm[currentKey] = stripQuotes(val);
      }
    } else if (blockMode && currentKey && (line.startsWith('  ') || line.startsWith('\t') || line.trim() === '')) {
      const part = line.trim();
      if (part) {
        fm[currentKey] = fm[currentKey] ? `${fm[currentKey]} ${part}` : part;
      }
    }
  }
  return { frontmatter: fm, body };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function buildSkillMarkdown({ name, description, body }) {
  validateSlug(name, 'skill name');
  const cleanDesc = String(description || '').replace(/\r?\n/g, ' ').trim();
  if (!cleanDesc) {
    throw new ValidationError('ERR_EMPTY_DESCRIPTION', 'Skill description cannot be empty.');
  }
  const safeDesc = cleanDesc.replace(/"/g, '\\"');
  const cleanBody = String(body || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `---\nname: ${name}\ndescription: "${safeDesc}"\n---\n\n${cleanBody.endsWith('\n') ? cleanBody : cleanBody + '\n'}`;
}

function validateCategoryInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('ERR_INVALID_CATEGORY', 'Category must be an object.');
  }
  const id = validateSlug(input.id, 'category id');
  const title = String(input.title || '').trim();
  if (!title || title.length > 60) {
    throw new ValidationError('ERR_INVALID_CATEGORY_TITLE', 'Category title must be 1-60 characters.');
  }
  const subtitle = String(input.subtitle || '').trim().slice(0, 140);
  const accent = /^#[0-9a-fA-F]{6}$/.test(input.accent || '') ? input.accent : '#e8742c';
  const code = String(input.code || id.toUpperCase().slice(0, 6)).trim().slice(0, 12);
  return { id, code, title, subtitle, accent };
}

function validateFlavorParameter(param) {
  if (!param || typeof param !== 'object') {
    throw new ValidationError('ERR_INVALID_FLAVOR', 'Flavor parameter must be an object.');
  }
  const key = validateSlug(param.key, 'flavor parameter key');
  const label = String(param.label || key).trim().slice(0, 80);
  const type = ['select', 'boolean', 'text'].includes(param.type) ? param.type : 'text';
  const hint = String(param.hint || '').trim().slice(0, 200);
  const options = type === 'select' && Array.isArray(param.options)
    ? param.options.map((o) => String(o).trim().slice(0, 80)).filter(Boolean)
    : undefined;
  let value = param.value;
  if (type === 'boolean') value = Boolean(value);
  else value = String(value ?? '').slice(0, 300);

  return { key, label, type, value, ...(options ? { options } : {}), ...(hint ? { hint } : {}) };
}

const VALID_LINT_EXEMPTIONS = new Set([
  'ERR_PRIVATE_NAME_LEAK',
  'ERR_INFORMAL_SLANG',
  'WARN_THIN_SKILL'
]);

function validateLintExemptions(raw) {
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.rules) ? raw.rules : []);
  const rules = [...new Set(list.filter((r) => VALID_LINT_EXEMPTIONS.has(r)))];
  if (rules.length === 0) return undefined;
  const reason = !Array.isArray(raw) && typeof raw.reason === 'string'
    ? raw.reason.trim().slice(0, 200)
    : '';
  const scope = !Array.isArray(raw) && raw.scope === 'personal-only' ? 'personal-only' : undefined;
  return { rules, ...(reason ? { reason } : {}), ...(scope ? { scope } : {}) };
}

function validateSkillMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    throw new ValidationError('ERR_INVALID_SKILL_META', 'Skill metadata must be an object.');
  }
  const id = validateSlug(meta.id, 'skill id');
  const categoryId = validateSlug(meta.categoryId, 'categoryId');
  const title = String(meta.title || id).trim().slice(0, 80);
  const summary = String(meta.summary || '').trim();
  if (!summary || summary.length > 400) {
    throw new ValidationError('ERR_INVALID_SUMMARY', 'Skill summary must be 1-400 characters.');
  }
  const origin = ['official', 'github-verified', 'bespoke'].includes(meta.origin) ? meta.origin : 'bespoke';
  const sourceUrl = meta.sourceUrl ? String(meta.sourceUrl).trim().slice(0, 300) : '';
  if (sourceUrl && !isTrustedSourceUrl(sourceUrl)) {
    throw new ValidationError('ERR_UNTRUSTED_SOURCE_URL', 'External sourceUrl must use HTTPS from a trusted official/GitHub domain.');
  }
  const version = /^\d+\.\d+\.\d+$/.test(meta.version || '') ? meta.version : '1.0.0';
  const tags = Array.isArray(meta.tags)
    ? [...new Set(meta.tags.map((t) => String(t).trim().slice(0, 32)).filter(Boolean))].slice(0, 12)
    : [];
  const flavor = Array.isArray(meta.flavor) ? meta.flavor.map(validateFlavorParameter) : [];
  const annotation = String(meta.annotation || '').replace(/\r\n/g, '\n').trim().slice(0, 1500);
  const lintExemptions = validateLintExemptions(meta.lintExemptions);

  return {
    id,
    categoryId,
    title,
    summary,
    annotation,
    origin,
    sourceUrl,
    version,
    tags,
    flavor,
    ...(lintExemptions ? { lintExemptions } : {}),
    ...(meta.contentHash ? { contentHash: String(meta.contentHash) } : {}),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    updatedBy: validateActor(meta.updatedBy || 'System')
  };
}

module.exports = {
  VALID_AGENTS,
  ValidationError,
  validateSlug,
  validateActor,
  isTrustedSourceUrl,
  computeBundleHash,
  resolveSafeChildPath,
  parseSkillMarkdown,
  buildSkillMarkdown,
  validateCategoryInput,
  validateFlavorParameter,
  validateSkillMeta
};
