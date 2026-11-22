'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { CatalogService } = require('../core/catalog-service.cjs');
const { SyncEngine } = require('../core/sync-engine.cjs');
const { scanTextContent, summarizeScan, isExecutableFileName } = require('../core/security-scanner.cjs');
const { DESKTOP_SESSION_SYMBOL } = require('../core/lock-and-audit.cjs');
const { ValidationError, resolveSafeChildPath } = require('../contracts/schema.cjs');
const { generateDshConfig } = require('../core/dsh-config-generator.cjs');

const DESKTOP_ORIGIN = Object.freeze({
  actor: 'User',
  channel: 'desktop',
  approval: 'direct-ui',
  desktopToken: DESKTOP_SESSION_SYMBOL
});

class RosettaDispatcher {
  constructor(rosettaRoot, syncOptions = {}) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.catalog = new CatalogService(this.rosettaRoot);
    this.syncEngine = new SyncEngine(this.catalog, syncOptions);
  }

  dispatch(action, payload = {}) {
    try {
      switch (action) {
        case 'getDashboard':
          return {
            ok: true,
            data: Object.assign({}, this.catalog.getDashboardState(), {
              dshTarget: this.syncEngine.targets.dsh
            })
          };

        case 'getDshConfig':
          return {
            ok: true,
            data: generateDshConfig(this.rosettaRoot, { dshSkillsDir: this.syncEngine.targets.dsh })
          };

        case 'getSkill':
          return {
            ok: true,
            data: this.catalog.getSkill(payload.skillId, {
              includeBody: true,
              subFile: payload.subFile || undefined
            })
          };

        case 'saveSkill': {
          const saved = this.catalog.saveSkill(payload.skill, Object.assign({}, DESKTOP_ORIGIN, {
            reason: payload.reason || `界面保存: ${payload.skill && (payload.skill.title || payload.skill.id)}`
          }));
          let syncReport = null;
          if (payload.syncNow) {
            syncReport = this.syncEngine.syncAll(DESKTOP_ORIGIN);
          }
          return { ok: true, data: { skill: saved, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'deleteSkill': {
          const res = this.catalog.deleteSkill(payload.skillId, DESKTOP_ORIGIN);
          const syncReport = this.syncEngine.syncAll(DESKTOP_ORIGIN);
          return { ok: true, data: { deleted: res.deleted, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'setAssignment': {
          const updated = this.catalog.setSkillAssignment(payload.skillId, payload.assigned || {}, DESKTOP_ORIGIN);
          let syncReport = null;
          if (payload.syncNow !== false) {
            syncReport = this.syncEngine.sync(DESKTOP_ORIGIN);
          }
          return { ok: true, data: { assigned: updated, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'setExternalAssignment': {
          const updated = this.catalog.externalSkills.setExternalAssignment(payload.externalSkillId, payload.assigned || {}, DESKTOP_ORIGIN);
          let syncReport = null;
          if (payload.syncNow !== false) {
            syncReport = this.syncEngine.sync(DESKTOP_ORIGIN);
          }
          return { ok: true, data: { assigned: updated, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'saveCategory': {
          const cat = this.catalog.saveCategory(payload.category, DESKTOP_ORIGIN);
          return { ok: true, data: { category: cat, dashboard: this.catalog.getDashboardState() } };
        }

        case 'saveSkillAnnotation': {
          const skill = this.catalog.saveSkillAnnotation(payload.skillId, payload.annotation, DESKTOP_ORIGIN);
          return { ok: true, data: { skill, dashboard: this.catalog.getDashboardState() } };
        }

        case 'saveMcpAnnotation': {
          const mcp = this.catalog.saveMcpAnnotation(payload.mcpId, payload.annotation, DESKTOP_ORIGIN);
          return { ok: true, data: { mcp, dashboard: this.catalog.getDashboardState() } };
        }

        case 'scanContent': {
          const findings = scanTextContent(payload.markdown || '', payload.fileName || 'SKILL.md');
          let hasScripts = false;
          let count = 1;
          if (payload.scripts && typeof payload.scripts === 'object') {
            for (const [k, v] of Object.entries(payload.scripts)) {
              count++;
              if (isExecutableFileName(k)) hasScripts = true;
              findings.push(...scanTextContent(v, `scripts/${k}`));
            }
          }
          if (payload.references && typeof payload.references === 'object') {
            for (const [k, v] of Object.entries(payload.references)) {
              count++;
              if (isExecutableFileName(k)) hasScripts = true;
              findings.push(...scanTextContent(v, `references/${k}`));
            }
          }
          return { ok: true, data: summarizeScan(findings, count, hasScripts) };
        }

        case 'syncAll': {
          const report = this.syncEngine.syncAll(DESKTOP_ORIGIN);
          return { ok: true, data: { syncReport: report, dashboard: this.catalog.getDashboardState() } };
        }

        case 'resolveProposal': {
          const res = this.catalog.resolveProposal(payload.proposalId, payload.decision, DESKTOP_ORIGIN);
          if (res.status === 'approved') {
            this.syncEngine.syncAll(Object.assign({}, DESKTOP_ORIGIN, { channel: 'desktop-approve' }));
          }
          return { ok: true, data: { result: res, dashboard: this.catalog.getDashboardState() } };
        }

        case 'inspectSkillDrift': {
          return { ok: true, data: this.catalog.baselines.inspectDrift(payload.skillId) };
        }

        case 'resolveSkillDrift': {
          if (!payload.expectedLiveHash || typeof payload.expectedLiveHash !== 'string') {
            throw new ValidationError('ERR_DRIFT_HASH_REQUIRED', '缺少审阅时的磁盘哈希 expectedLiveHash，请重新打开漂移审阅弹窗。');
          }
          const res = this.catalog.baselines.resolveDrift(
            payload.skillId,
            payload.decision,
            Object.assign({}, DESKTOP_ORIGIN, { expectedLiveHash: payload.expectedLiveHash })
          );
          const syncReport = this.syncEngine.syncAll(Object.assign({}, DESKTOP_ORIGIN, { channel: 'desktop-drift' }));
          return { ok: true, data: { result: res, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'verifyAuditChain': {
          return { ok: true, data: this.catalog.audit.verifyChain() };
        }

        case 'rollbackSnapshot': {
          const res = this.catalog.snapshots.rollback(payload.snapshotId, 'User');
          this.catalog.baselines.seedCleanBaselines({ forceRefresh: true });
          this.catalog.audit.log(Object.assign({}, DESKTOP_ORIGIN, {
            action: 'snapshot.rollback',
            targetId: payload.snapshotId,
            summary: `无损回滚至快照 ${payload.snapshotId}`
          }));
          const syncReport = this.syncEngine.syncAll(Object.assign({}, DESKTOP_ORIGIN, { channel: 'desktop-rollback' }));
          return { ok: true, data: { rollback: res, syncReport, dashboard: this.catalog.getDashboardState() } };
        }

        case 'pinSnapshot': {
          const res = this.catalog.snapshots.setPinned(payload.snapshotId, Boolean(payload.pinned));
          this.catalog.audit.log(Object.assign({}, DESKTOP_ORIGIN, {
            action: res.pinned ? 'snapshot.pin' : 'snapshot.unpin',
            targetId: payload.snapshotId,
            summary: `${res.pinned ? '钉住里程碑快照' : '取消钉住快照'} ${payload.snapshotId}`
          }));
          return { ok: true, data: { snapshot: res, dashboard: this.catalog.getDashboardState() } };
        }

        case 'issueApprovalGrant': {
          const grant = this.catalog.grants.issueOneTimeGrant({
            allowedHost: payload.allowedHost || 'dsh',
            skillId: payload.skillId || '*',
            ttlSeconds: payload.ttlSeconds || 300
          });
          this.catalog.audit.log(Object.assign({}, DESKTOP_ORIGIN, {
            action: 'grant.issue',
            targetId: grant.grantId,
            summary: `签发 5 分钟单次写入授权码 (允许终端: ${grant.allowedHost}, 目标: ${grant.skillId})`
          }));
          return { ok: true, data: { grant, dashboard: this.catalog.getDashboardState() } };
        }

        case 'openCatalogFolder': {
          const target = payload.skillId
            ? resolveSafeChildPath(this.catalog.skillsDir, payload.skillId)
            : this.catalog.catalogDir;
          if (process.platform === 'win32') {
            const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' });
            child.unref();
          } else if (process.platform === 'darwin') {
            const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
            child.unref();
          } else {
            const child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
            child.unref();
          }
          return { ok: true, data: { opened: target } };
        }

        default:
          return { ok: false, code: 'ERR_UNKNOWN_ACTION', error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'ERR_DISPATCH_FAILED',
        error: err.message,
        details: err.scanResult || null
      };
    }
  }
}

module.exports = { RosettaDispatcher };
