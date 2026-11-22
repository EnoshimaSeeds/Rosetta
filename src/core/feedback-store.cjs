'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ValidationError, validateSlug, validateActor } = require('../contracts/schema.cjs');
const { withCatalogLock } = require('./lock-and-audit.cjs');

const VALID_KINDS = new Set(['good', 'bad', 'redline', 'preference']);
const VALID_RESOLUTIONS = new Set(['promoted', 'dismissed']);
const DEFAULT_PROMOTION_THRESHOLD = 2;

function sanitizeDomain(raw) {
  const cleaned = String(raw || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return cleaned || 'general';
}

function sanitizeText(raw, maxLen) {
  return String(raw || '').replace(/\r\n/g, '\n').trim().slice(0, maxLen);
}

/**
 * Lightweight local-only deliverable feedback inbox (`runtime/feedback-log.jsonl`).
 * Keeps casual post-handoff remarks frictionless (zero approval popups, excluded from public repo),
 * and nudges the agent to promote redlines or recurring patterns via `rosetta_propose`.
 */
class FeedbackStore {
  constructor(rosettaRoot, options = {}) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.logPath = options.logPath
      ? path.resolve(options.logPath)
      : path.join(this.rosettaRoot, 'runtime', 'feedback-log.jsonl');
    this.promotionThreshold = Number.isInteger(options.promotionThreshold) && options.promotionThreshold >= 1
      ? options.promotionThreshold
      : DEFAULT_PROMOTION_THRESHOLD;
  }

  _readEvents() {
    if (!fs.existsSync(this.logPath)) return [];
    const raw = fs.readFileSync(this.logPath, 'utf8');
    const events = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch (_skipCorruptLine) { /* ignore malformed trailing line */ }
    }
    return events;
  }

  _materializeEntries() {
    const events = this._readEvents();
    const byId = new Map();
    const order = [];

    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'resolve' && Array.isArray(ev.targetIds)) {
        for (const tid of ev.targetIds) {
          const target = byId.get(tid);
          if (target) {
            target.status = ev.resolution || 'promoted';
            target.resolvedAt = ev.ts || null;
            target.resolvedBy = ev.actor || null;
            if (ev.proposalId) target.proposalId = ev.proposalId;
            if (ev.resolutionNote) target.resolutionNote = ev.resolutionNote;
          }
        }
        continue;
      }
      if (ev.id) {
        const entry = Object.assign({ status: 'open' }, ev);
        delete entry.type;
        byId.set(entry.id, entry);
        order.push(entry.id);
      }
    }

    return order.map((id) => byId.get(id)).filter(Boolean);
  }

  record(input, actor = 'dsh') {
    return withCatalogLock(this.rosettaRoot, () => {
      if (!input || typeof input !== 'object') {
        throw new ValidationError('ERR_INVALID_FEEDBACK', 'Feedback payload must be an object.');
      }
      const safeActor = validateActor(actor);
      const kind = String(input.kind || 'preference').trim().toLowerCase();
      if (!VALID_KINDS.has(kind)) {
        throw new ValidationError(
          'ERR_INVALID_FEEDBACK_KIND',
          `Invalid feedback kind "${kind}": expected one of good, bad, redline, preference.`
        );
      }
      const note = sanitizeText(input.note, 1000);
      if (!note) {
        throw new ValidationError('ERR_EMPTY_FEEDBACK_NOTE', 'Feedback note cannot be empty.');
      }
      const domain = sanitizeDomain(input.domain);
      const quote = sanitizeText(input.quote, 400);
      const artifactPath = sanitizeText(input.artifactPath, 300);
      let skillId = null;
      if (input.skillId) {
        skillId = validateSlug(String(input.skillId).trim(), 'skillId');
      }

      const entry = {
        type: 'feedback',
        id: `fb_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        ts: new Date().toISOString(),
        actor: safeActor,
        kind,
        domain,
        note,
        ...(quote ? { quote } : {}),
        ...(skillId ? { skillId } : {}),
        ...(artifactPath ? { artifactPath } : {})
      };

      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf8');

      const openEntries = this._materializeEntries().filter((e) => e.status === 'open');
      const openCountInDomain = openEntries.filter((e) => e.domain === domain).length;
      const shouldSuggestPromotion = kind === 'redline' || openCountInDomain >= this.promotionThreshold;

      const publicEntry = Object.assign({ status: 'open' }, entry);
      delete publicEntry.type;

      return {
        recorded: true,
        entry: publicEntry,
        openCountInDomain,
        totalOpen: openEntries.length,
        shouldSuggestPromotion,
        ...(shouldSuggestPromotion
          ? {
              suggestion: kind === 'redline'
                ? '此条为明确红线：建议提炼后走 rosetta_propose 更新 user-decisions 或对应技能卡。'
                : `领域 "${domain}" 已累计 ${openCountInDomain} 条未归档反馈：可适时提炼精炼规则并走 rosetta_propose 提交审阅。`
            }
          : {})
      };
    });
  }

  list(opts = {}) {
    const entries = this._materializeEntries();
    const includeResolved = Boolean(opts.includeResolved);
    const domainFilter = opts.domain ? sanitizeDomain(opts.domain) : null;
    const kindFilter = opts.kind ? String(opts.kind).trim().toLowerCase() : null;
    const skillFilter = opts.skillId ? String(opts.skillId).trim() : null;
    const rawLimit = Number(opts.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(100, Math.floor(rawLimit)) : 20;

    const openByDomain = {};
    for (const e of entries) {
      if (e.status === 'open') {
        openByDomain[e.domain] = (openByDomain[e.domain] || 0) + 1;
      }
    }

    const filtered = entries.filter((e) => {
      if (!includeResolved && e.status !== 'open') return false;
      if (domainFilter && e.domain !== domainFilter) return false;
      if (kindFilter && e.kind !== kindFilter) return false;
      if (skillFilter && e.skillId !== skillFilter) return false;
      return true;
    });

    const recent = filtered.slice(-limit).reverse();
    return {
      totalMatched: filtered.length,
      totalOpen: Object.values(openByDomain).reduce((a, b) => a + b, 0),
      openByDomain,
      entries: recent
    };
  }

  resolve(targetIds, opts = {}, actor = 'dsh') {
    return withCatalogLock(this.rosettaRoot, () => {
      const ids = Array.isArray(targetIds)
        ? [...new Set(targetIds.map((x) => String(x || '').trim()).filter(Boolean))]
        : [];
      if (ids.length === 0) {
        throw new ValidationError('ERR_EMPTY_FEEDBACK_IDS', 'At least one feedback id is required to resolve.');
      }
      const resolution = String(opts.resolution || 'promoted').trim().toLowerCase();
      if (!VALID_RESOLUTIONS.has(resolution)) {
        throw new ValidationError('ERR_INVALID_RESOLUTION', `Invalid resolution "${resolution}": expected promoted or dismissed.`);
      }
      const safeActor = validateActor(actor);
      const existing = new Set(this._materializeEntries().map((e) => e.id));
      const matched = ids.filter((id) => existing.has(id));
      if (matched.length === 0) {
        throw new ValidationError('ERR_FEEDBACK_NOT_FOUND', `No matching feedback entries found for: ${ids.join(', ')}`);
      }

      const proposalId = sanitizeText(opts.proposalId, 80);
      const resolutionNote = sanitizeText(opts.note, 300);
      const event = {
        type: 'resolve',
        ts: new Date().toISOString(),
        actor: safeActor,
        targetIds: matched,
        resolution,
        ...(proposalId ? { proposalId } : {}),
        ...(resolutionNote ? { resolutionNote } : {})
      };

      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf8');

      return {
        resolved: matched,
        resolution,
        ...(proposalId ? { proposalId } : {})
      };
    });
  }
}

module.exports = {
  VALID_KINDS,
  VALID_RESOLUTIONS,
  FeedbackStore
};
