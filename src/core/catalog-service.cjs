'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  VALID_AGENTS, ValidationError, validateSlug, validateActor, computeBundleHash,
  resolveSafeChildPath, parseSkillMarkdown, buildSkillMarkdown, validateCategoryInput, validateSkillMeta
} = require('../contracts/schema.cjs');
const { scanSkillBundle, scanDirectory, isExecutableFileName } = require('./security-scanner.cjs');
const { atomicWriteFile, SnapshotStore } = require('./snapshot-store.cjs');
const { DESKTOP_SESSION_SYMBOL, withCatalogLock, resolveAuditOrigin, AuditLogger, ApprovalGrantStore } = require('./lock-and-audit.cjs');
const { readAllExtraFilesFromDir, buildMergedExtraFiles, writeManagedSubdir, computeBundleDiff, computeFileChanges, detectDestructiveShrink, hydrateProposalPreview } = require('./skill-bundle-io.cjs');
const { findBrokenSubfileRefs } = require('./catalog-linter.cjs');
const { ExternalSkillsService } = require('./external-skills-service.cjs');
const { computeFileHashMap, BaselineStore } = require('./baseline-store.cjs');

const FLAVOR_START = '<!-- ROSETTA-FLAVOR-START -->';
const FLAVOR_END = '<!-- ROSETTA-FLAVOR-END -->';

function renderFlavorBlock(flavor = []) {
  if (!Array.isArray(flavor) || flavor.length === 0) return '';
  const lines = [
    FLAVOR_START,
    '## 当前预设参数（Active Rosetta Presets）',
    ...flavor.map((f) => `- **${f.label}** (\`${f.key}\`): \`${String(f.value)}\`${f.hint ? ` — ${f.hint}` : ''}`),
    FLAVOR_END
  ];
  return lines.join('\n');
}

function injectFlavorIntoBody(rawBody, flavor = []) {
  const clean = String(rawBody || '').replace(/\r\n/g, '\n');
  const stripped = clean.replace(
    new RegExp(`${FLAVOR_START}[\\s\\S]*?${FLAVOR_END}\\n*?`, 'g'),
    ''
  ).trim();
  const block = renderFlavorBlock(flavor);
  if (!block) return stripped + '\n';
  return `${block}\n\n${stripped}\n`;
}

function stripFlavorFromBody(rawBody) {
  return String(rawBody || '')
    .replace(/\r\n/g, '\n')
    .replace(new RegExp(`${FLAVOR_START}[\\s\\S]*?${FLAVOR_END}\\n*?`, 'g'), '')
    .trim();
}

function normalizeOriginArgs(actorOrOpts, channelArg) {
  if (actorOrOpts && typeof actorOrOpts === 'object') {
    return resolveAuditOrigin(actorOrOpts, 'script');
  }
  return resolveAuditOrigin({ actor: actorOrOpts, channel: channelArg || 'script' }, 'script');
}

const DEFAULT_CATEGORIES = [
  { id: 'aesthetics', code: 'SEC-01', title: '美学、视觉艺术与人文表达', subtitle: '视觉艺术与线稿控制 · 高审美演示架构 · UI 设计令牌 · 自然汉语语感与去模板腔', accent: '#eb9ab3' },
  { id: 'academic', code: 'SEC-02', title: '学术研究与专业文档', subtitle: '文献检索与 DOI 核验 · 课程精讲与 LaTeX 写作 · 办公文档工程路由 · 实验分析与科研配图', accent: '#8fa8ff' },
  { id: 'industrial', code: 'SEC-03', title: '代码工程与数字管线', subtitle: '软件分层架构与开源安全基线 · 本地 MCP 自检 · 现代 Web 规范 · 3D / Live2D 与动效管线', accent: '#e8742c' },
  { id: 'strategy', code: 'SEC-04', title: '流程调度、复核与事务文书', subtitle: '全流程精修与多视角独立复核 · 多线程认知分流排期 · 合同风控审阅与正式英文联络邮件', accent: '#eab869' },
  { id: 'calibration', code: 'CAL-05', title: '行为纪律与个人偏好校准', subtitle: '个人偏好与红线记录模板（私有校准层） · DeepSeek Harness 执行纪律与实测门禁', accent: '#5aa9e6' }
];

class CatalogService {
  constructor(rosettaRoot) {
    this.rosettaRoot = path.resolve(rosettaRoot);
    this.catalogDir = path.join(this.rosettaRoot, 'catalog');
    this.skillsDir = path.join(this.catalogDir, 'skills');
    this.stagingDir = path.join(this.rosettaRoot, 'runtime', 'staging');
    this.categoriesPath = path.join(this.catalogDir, 'categories.json');
    this.assignmentsPath = path.join(this.catalogDir, 'assignments.json');
    this.mcpRegistryPath = path.join(this.catalogDir, 'mcp-registry.json');

    this.snapshots = new SnapshotStore(this.rosettaRoot);
    this.audit = new AuditLogger(this.rosettaRoot);
    this.grants = new ApprovalGrantStore(this.rosettaRoot);
    this.externalSkills = new ExternalSkillsService(this);
    this.baselines = new BaselineStore(this);

    this.ensureInitialized();
  }

  ensureInitialized() {
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });

    if (!fs.existsSync(this.categoriesPath)) {
      atomicWriteFile(this.categoriesPath, JSON.stringify({ version: 1, categories: DEFAULT_CATEGORIES }, null, 2) + '\n');
    }
    if (!fs.existsSync(this.assignmentsPath)) {
      atomicWriteFile(this.assignmentsPath, JSON.stringify({ version: 1, assignments: {} }, null, 2) + '\n');
    }
    if (!fs.existsSync(this.mcpRegistryPath)) {
      const defaultMcp = {
        version: 1,
        servers: [
          {
            id: 'rosetta',
            title: 'Rosetta Armory MCP',
            summary: 'DeepSeek Harness 技能按需读取、Crossref/OpenAlex 论文核验、安全扫描、无感反馈流、待审提案与快照服务。',
            annotation: '【接入方式】通过 DeepSeek Harness 原生插件 @deepseek-ai/dsh-mcp-client（写入 ~/.dsh/profiles/web/cordis.patch.yml 或 ~/.dsh/cordis.patch.yml）以 stdio 挂载，并显式传入环境变量 ROSETTA_ACTOR=dsh。\n【工具命名】接入成功后在 DeepSeek Harness 中以 mcp__rosetta__<toolName> 形式调用。',
            origin: 'bespoke',
            command: 'node',
            entryRel: 'src/mcp/server.cjs',
            mounted: { dsh: true }
          }
        ]
      };
      atomicWriteFile(this.mcpRegistryPath, JSON.stringify(defaultMcp, null, 2) + '\n');
    }
    this.externalSkills.ensureSeedFile();
    this.baselines.seedCleanBaselines();
  }

  getCategories() {
    const raw = JSON.parse(fs.readFileSync(this.categoriesPath, 'utf8'));
    return Array.isArray(raw.categories) ? raw.categories : [];
  }

  saveCategory(input, actorOrOpts = 'local-script', channel = 'script') {
    return withCatalogLock(this.rosettaRoot, () => {
      const valid = validateCategoryInput(input);
      const origin = normalizeOriginArgs(actorOrOpts, channel);
      const safeActor = validateActor(origin.actor);
      this.snapshots.createSnapshot(`保存板块分类: ${valid.title} (${valid.id})`, safeActor);

      const categories = this.getCategories();
      const idx = categories.findIndex((c) => c.id === valid.id);
      if (idx >= 0) categories[idx] = valid;
      else categories.push(valid);

      atomicWriteFile(this.categoriesPath, JSON.stringify({ version: 1, categories }, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'category.save',
        targetId: valid.id,
        summary: `保存分类轮盘「${valid.title}」`
      }));
      return valid;
    });
  }

  getAssignments() {
    const raw = JSON.parse(fs.readFileSync(this.assignmentsPath, 'utf8'));
    return raw.assignments || {};
  }

  getMcpRegistry() {
    const raw = JSON.parse(fs.readFileSync(this.mcpRegistryPath, 'utf8'));
    return raw.servers || [];
  }

  saveSkillAnnotation(skillId, annotation, actorOrOpts = 'local-script', channel = 'script') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(skillId, 'skillId');
      const origin = normalizeOriginArgs(actorOrOpts, channel);
      const safeActor = validateActor(origin.actor);
      const skillDir = resolveSafeChildPath(this.skillsDir, skillId);
      const metaPath = path.join(skillDir, 'rosetta.meta.json');
      if (!fs.existsSync(metaPath)) {
        throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill metadata not found: ${skillId}`);
      }
      const cleanNote = String(annotation || '').replace(/\r\n/g, '\n').trim().slice(0, 1500);
      const currentMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if ((currentMeta.annotation || '') === cleanNote) {
        return this.getSkill(skillId, { includeBody: false });
      }
      this.snapshots.createSnapshot(`更新技能注解: ${currentMeta.title || skillId}`, safeActor, {
        coalesceKey: `note:${skillId}`
      });
      currentMeta.annotation = cleanNote;
      currentMeta.updatedAt = new Date().toISOString();
      currentMeta.updatedBy = safeActor;
      atomicWriteFile(metaPath, JSON.stringify(currentMeta, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'skill.annotate',
        targetId: skillId,
        summary: `更新技能「${currentMeta.title || skillId}」的人工注解`
      }));
      return this.getSkill(skillId, { includeBody: false });
    });
  }

  saveMcpAnnotation(mcpId, annotation, actorOrOpts = 'local-script', channel = 'script') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(mcpId, 'mcpId');
      const origin = normalizeOriginArgs(actorOrOpts, channel);
      const safeActor = validateActor(origin.actor);
      const raw = JSON.parse(fs.readFileSync(this.mcpRegistryPath, 'utf8'));
      const servers = Array.isArray(raw.servers) ? raw.servers : [];
      const target = servers.find((m) => m.id === mcpId);
      if (!target) {
        throw new ValidationError('ERR_MCP_NOT_FOUND', `MCP server not found: ${mcpId}`);
      }
      const cleanNote = String(annotation || '').replace(/\r\n/g, '\n').trim().slice(0, 1500);
      if ((target.annotation || '') === cleanNote) {
        return target;
      }
      this.snapshots.createSnapshot(`更新 MCP 注解: ${target.title || mcpId}`, safeActor, {
        coalesceKey: `mcp-note:${mcpId}`
      });
      target.annotation = cleanNote;
      target.updatedAt = new Date().toISOString();
      atomicWriteFile(this.mcpRegistryPath, JSON.stringify({ version: raw.version || 1, servers }, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'mcp.annotate',
        targetId: mcpId,
        summary: `更新 MCP「${target.title || mcpId}」的注解`
      }));
      return target;
    });
  }

  setSkillAssignment(skillId, agentMap, actorOrOpts = 'local-script', channel = 'script') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(skillId, 'skillId');
      const origin = normalizeOriginArgs(actorOrOpts, channel);
      const safeActor = validateActor(origin.actor);
      const skillDir = resolveSafeChildPath(this.skillsDir, skillId);
      if (!fs.existsSync(skillDir)) {
        throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill not found: ${skillId}`);
      }

      const all = this.getAssignments();
      const current = Object.assign({ dsh: false }, all[skillId] || {});
      const changes = [];
      for (const agent of VALID_AGENTS) {
        if (Object.prototype.hasOwnProperty.call(agentMap, agent)) {
          const nextBool = Boolean(agentMap[agent]);
          if (current[agent] !== nextBool) {
            current[agent] = nextBool;
            changes.push(`${agent}=${nextBool ? 'ON' : 'OFF'}`);
          }
        }
      }
      if (changes.length === 0 && all[skillId]) {
        return current;
      }

      this.snapshots.createSnapshot(`更新挂载开关: ${skillId}`, safeActor, {
        coalesceKey: `assign:${skillId}`
      });
      all[skillId] = current;
      atomicWriteFile(this.assignmentsPath, JSON.stringify({ version: 1, assignments: all }, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'skill.assign',
        targetId: skillId,
        summary: `切换挂载开关 (${changes.join(', ')})`
      }));
      return current;
    });
  }

  listSkillsWithDiagnostics() {
    const assignments = this.getAssignments();
    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const items = [];
    const brokenSkills = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const item = this.getSkill(entry.name, { includeBody: false, assignmentsCache: assignments });
        items.push(item);
      } catch (err) {
        brokenSkills.push({ id: entry.name, error: err.message });
      }
    }

    items.sort((a, b) => a.categoryId.localeCompare(b.categoryId) || a.id.localeCompare(b.id));
    return { items, brokenSkills };
  }

  listSkills() {
    return this.listSkillsWithDiagnostics().items;
  }

  computeLiveSkillHash(skillId) {
    validateSlug(skillId, 'skillId');
    const skillDir = resolveSafeChildPath(this.skillsDir, skillId);
    const mdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(mdPath)) return null;
    const mdStat = fs.lstatSync(mdPath);
    let rawMd;
    if (mdStat.isSymbolicLink()) {
      rawMd = `\0SYMLINK:${fs.readlinkSync(mdPath)}`;
    } else {
      const buf = fs.readFileSync(mdPath);
      rawMd = (buf.includes(0) || mdStat.size > 512 * 1024)
        ? `\0UNSCANNABLE_MD:${crypto.createHash('sha256').update(buf).digest('hex')}:${mdStat.size}`
        : buf.toString('utf8');
    }
    const extraFiles = readAllExtraFilesFromDir(skillDir, { strict: false });
    return computeBundleHash({ markdown: rawMd, extraFiles });
  }

  getSkill(skillId, opts = {}) {
    validateSlug(skillId, 'skillId');
    const skillDir = resolveSafeChildPath(this.skillsDir, skillId);
    const mdPath = path.join(skillDir, 'SKILL.md');
    const metaPath = path.join(skillDir, 'rosetta.meta.json');

    if (!fs.existsSync(mdPath)) {
      throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill "${skillId}" not found.`);
    }

    let meta = null;
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }

    const liveContentHash = this.computeLiveSkillHash(skillId);
    const diskDrifted = Boolean(meta && meta.contentHash && liveContentHash !== meta.contentHash);
    let contentDir = skillDir;
    let servingApprovedBaseline = false;
    if (opts.approvedOnly && (diskDrifted || !meta || !meta.contentHash)) {
      contentDir = this.baselines.resolveApprovedDir(skillId, meta ? meta.contentHash : null);
      servingApprovedBaseline = true;
    }

    const rawMd = fs.readFileSync(path.join(contentDir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillMarkdown(rawMd);
    if (!meta) {
      meta = {
        id: skillId, categoryId: 'industrial', title: skillId,
        summary: parsed.frontmatter.description || skillId, annotation: '',
        origin: 'bespoke', sourceUrl: '', version: '1.0.0', tags: [], flavor: [],
        updatedAt: fs.statSync(mdPath).mtime.toISOString(), updatedBy: 'System'
      };
    }

    const assignments = opts.assignmentsCache || this.getAssignments();
    const assigned = Object.assign({ dsh: false }, assignments[skillId] || {});

    const scriptsDir = path.join(contentDir, 'scripts');
    const scripts = fs.existsSync(scriptsDir)
      ? fs.readdirSync(scriptsDir).filter((f) => !f.startsWith('.')).sort()
      : [];

    const refsDir = path.join(contentDir, 'references');
    const references = fs.existsSync(refsDir)
      ? fs.readdirSync(refsDir).filter((f) => !f.startsWith('.')).sort()
      : [];

    const hasExecScripts = scripts.some(isExecutableFileName);
    const security = (diskDrifted && !servingApprovedBaseline)
      ? scanDirectory(skillDir)
      : (meta.security || scanDirectory(contentDir));

    const result = {
      id: skillId,
      categoryId: meta.categoryId,
      title: meta.title || skillId,
      summary: meta.summary || parsed.frontmatter.description || '',
      annotation: meta.annotation || '',
      description: parsed.frontmatter.description || meta.summary || '',
      origin: meta.origin || 'bespoke',
      sourceUrl: meta.sourceUrl || '',
      version: meta.version || '1.0.0',
      tags: meta.tags || [],
      flavor: meta.flavor || [],
      ...(meta.lintExemptions ? { lintExemptions: meta.lintExemptions } : {}),
      scripts,
      references,
      assigned,
      contentHash: meta.contentHash || null,
      liveContentHash,
      diskDrifted,
      servingApprovedBaseline,
      resolvedSkillDir: contentDir,
      security: {
        scannerKind: security.scannerKind || 'static-heuristic-advisory',
        passed: security.passed,
        verdict: security.verdict,
        score: security.score,
        scannedFiles: security.scannedFiles,
        hasExecutableScripts: Boolean(security.hasExecutableScripts || hasExecScripts),
        requiresManualApproval: Boolean(security.requiresManualApproval || hasExecScripts),
        counts: security.counts,
        scannedAt: security.scannedAt,
        findings: opts.includeBody ? security.findings : undefined
      },
      updatedAt: meta.updatedAt,
      updatedBy: meta.updatedBy
    };

    if (opts.includeBody !== false) {
      result.body = stripFlavorFromBody(parsed.body);
      result.rawMarkdown = rawMd;
      const rawExtra = readAllExtraFilesFromDir(contentDir, { strict: false });
      result.extraFiles = {};
      result.scriptFiles = {};
      result.referenceFiles = {};
      result.unscannableFiles = [];
      for (const [relKey, content] of Object.entries(rawExtra)) {
        if (typeof content === 'string' && content.startsWith('\0')) {
          result.unscannableFiles.push(relKey);
          continue;
        }
        result.extraFiles[relKey] = content;
        if (relKey.startsWith('scripts/')) result.scriptFiles[relKey.slice('scripts/'.length)] = content;
        else if (relKey.startsWith('references/')) result.referenceFiles[relKey.slice('references/'.length)] = content;
      }
    }

    if (opts.subFile) {
      const cleanRel = String(opts.subFile).replace(/\\/g, '/').replace(/^\/+/, '');
      const candidates = cleanRel.includes('/') ? [cleanRel] : [`references/${cleanRel}`, `scripts/${cleanRel}`, cleanRel];
      let resolvedSub = null;
      let matchedRel = null;
      for (const cand of candidates) {
        const parts = cand.split('/');
        const fullCand = resolveSafeChildPath(contentDir, ...parts);
        if (fs.existsSync(fullCand) && fs.statSync(fullCand).isFile()) {
          resolvedSub = fullCand;
          matchedRel = cand;
          break;
        }
      }
      if (!resolvedSub || path.basename(resolvedSub) === 'rosetta.meta.json') {
        throw new ValidationError('ERR_SUBFILE_NOT_FOUND', `Skill subfile not found: ${opts.subFile}`);
      }
      result.selectedFile = {
        relativePath: matchedRel,
        content: fs.readFileSync(resolvedSub, 'utf8')
      };
    }

    return result;
  }

  saveSkill(payload, opts = {}) {
    return withCatalogLock(this.rosettaRoot, () => {
      if (!payload || typeof payload !== 'object') {
        throw new ValidationError('ERR_INVALID_SKILL_META', 'Skill payload must be an object.');
      }
      validateSlug(payload.id, 'skill id');
      const origin = resolveAuditOrigin(opts, 'script');
      const safeActor = validateActor(origin.actor);
      const skillDir = resolveSafeChildPath(this.skillsDir, payload.id);
      const existingMetaPath = path.join(skillDir, 'rosetta.meta.json');
      const existingMdPath = path.join(skillDir, 'SKILL.md');
      const existedBefore = fs.existsSync(existingMetaPath) || fs.existsSync(existingMdPath);
      let prevMeta = {};
      let prevBody = '';
      if (fs.existsSync(existingMetaPath)) {
        try { prevMeta = JSON.parse(fs.readFileSync(existingMetaPath, 'utf8')); } catch (_e) { prevMeta = {}; }
      }
      if (fs.existsSync(existingMdPath)) {
        try { prevBody = stripFlavorFromBody(parseSkillMarkdown(fs.readFileSync(existingMdPath, 'utf8')).body); } catch (_e) { prevMeta = prevMeta || {}; }
      }

      if (existedBefore && prevMeta.contentHash && this.computeLiveSkillHash(payload.id) !== prevMeta.contentHash) {
        throw new ValidationError(
          'ERR_UNREVIEWED_DISK_DRIFT',
          `检测到技能 ${payload.id} 的磁盘文件与上次入库哈希不一致（含未审阅改动），请先在桌面端审阅磁盘漂移 Diff（采纳或单卡还原）后再保存。`
        );
      }

      const definedPayload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
      const mergedInput = Object.assign({}, prevMeta, definedPayload, {
        updatedBy: safeActor,
        updatedAt: new Date().toISOString()
      });
      if (!this.getCategories().some((c) => c.id === mergedInput.categoryId)) {
        throw new ValidationError('ERR_UNKNOWN_CATEGORY', `Unknown categoryId: "${mergedInput.categoryId}"`);
      }
      const meta = validateSkillMeta(mergedInput);
      const effectiveBody = String(payload.body !== undefined ? payload.body : prevBody);
      if (effectiveBody.includes('\0') || Buffer.byteLength(effectiveBody, 'utf8') > 512 * 1024) {
        throw new ValidationError('ERR_UNSCANNABLE_SKILL_FILE', 'SKILL.md body contains null bytes or exceeds 512 KB.');
      }
      const fullMarkdown = buildSkillMarkdown({
        name: meta.id,
        description: payload.description || meta.summary,
        body: injectFlavorIntoBody(effectiveBody, meta.flavor)
      });
      const { extraFiles, scriptsExplicit, refsExplicit, extraExplicit } = buildMergedExtraFiles(skillDir, payload, null, { strict: true });
      const scanResult = scanSkillBundle({ markdown: fullMarkdown, extraFiles });
      if (!scanResult.passed) {
        this.audit.log(Object.assign({}, origin, {
          actor: safeActor,
          action: 'skill.save_blocked',
          targetId: meta.id,
          status: 'BLOCKED',
          summary: `安全扫描拦截 (${scanResult.verdict})：高危 ${scanResult.counts.critical} / 严重 ${scanResult.counts.high}`
        }));
        const err = new ValidationError(
          'ERR_SECURITY_BLOCKED',
          `安全检查拦截 (${scanResult.verdict})：发现 ${scanResult.counts.critical} 项高危、${scanResult.counts.high} 项严重风险，拒绝入库。`
        );
        err.scanResult = scanResult;
        throw err;
      }
      if (!opts.skipSnapshot) {
        this.snapshots.createSnapshot(opts.reason || `保存技能: ${meta.title} (${meta.id})`, safeActor);
      }
      fs.mkdirSync(skillDir, { recursive: true });
      meta.contentHash = computeBundleHash({ markdown: fullMarkdown, extraFiles });
      meta.fileHashes = computeFileHashMap(fullMarkdown, extraFiles);
      meta.security = scanResult;
      atomicWriteFile(path.join(skillDir, 'SKILL.md'), fullMarkdown);
      atomicWriteFile(path.join(skillDir, 'rosetta.meta.json'), JSON.stringify(meta, null, 2) + '\n');
      if (scriptsExplicit || extraExplicit) writeManagedSubdir(skillDir, 'scripts', extraFiles);
      if (refsExplicit || extraExplicit) writeManagedSubdir(skillDir, 'references', extraFiles);
      if (extraExplicit) {
        for (const dirName of ['resources', 'examples', 'assets']) writeManagedSubdir(skillDir, dirName, extraFiles);
      }
      this.baselines.recordCleanBaseline(meta.id);

      if (payload.assigned && typeof payload.assigned === 'object' && !opts.forbidAssignMutation) {
        const allAssign = this.getAssignments();
        const baseAssign = Object.assign({ dsh: false }, allAssign[meta.id] || {});
        for (const agent of VALID_AGENTS) {
          if (Object.prototype.hasOwnProperty.call(payload.assigned, agent)) {
            baseAssign[agent] = Boolean(payload.assigned[agent]);
          }
        }
        allAssign[meta.id] = baseAssign;
        atomicWriteFile(this.assignmentsPath, JSON.stringify({ version: 1, assignments: allAssign }, null, 2) + '\n');
      }

      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'skill.save',
        targetId: meta.id,
        status: 'OK',
        summary: `${existedBefore ? '更新' : '新建'}技能「${meta.title}」(files:${scanResult.scannedFiles}, hash:${meta.contentHash.slice(0, 10)})`
      }));

      return this.getSkill(meta.id, { includeBody: true });
    });
  }

  deleteSkill(skillId, actorOrOpts = 'local-script', channel = 'script') {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(skillId, 'skillId');
      const origin = normalizeOriginArgs(actorOrOpts, channel);
      const safeActor = validateActor(origin.actor);
      const skillDir = resolveSafeChildPath(this.skillsDir, skillId);
      if (!fs.existsSync(skillDir)) {
        throw new ValidationError('ERR_SKILL_NOT_FOUND', `Skill not found: ${skillId}`);
      }

      this.snapshots.createSnapshot(`移除技能: ${skillId}`, safeActor);
      fs.rmSync(skillDir, { recursive: true, force: true });
      this.baselines.removeBaseline(skillId);

      const allAssign = this.getAssignments();
      delete allAssign[skillId];
      atomicWriteFile(this.assignmentsPath, JSON.stringify({ version: 1, assignments: allAssign }, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'skill.delete',
        targetId: skillId,
        summary: `移除技能包 ${skillId}`
      }));
      return { deleted: skillId };
    });
  }

  createProposal(payload, hostActor = 'dsh', channel = 'mcp') {
    return withCatalogLock(this.rosettaRoot, () => {
      const safeActor = validateActor(hostActor);
      validateSlug(payload.id, 'skill id');

      let existing = null;
      try {
        existing = this.getSkill(payload.id, { includeBody: true });
      } catch (_notFound) {
        existing = null;
      }

      if (existing && existing.contentHash && this.computeLiveSkillHash(payload.id) !== existing.contentHash) {
        throw new ValidationError(
          'ERR_UNREVIEWED_DISK_DRIFT',
          `技能 ${payload.id} 存在未审阅的磁盘改动，拒绝基于漂移磁盘生成待审提案；请先由用户在桌面端审阅磁盘漂移 Diff。`
        );
      }

      const mergedMetaInput = Object.assign(
        {},
        existing || {},
        Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined)),
        { updatedBy: safeActor }
      );
      const meta = validateSkillMeta(mergedMetaInput);
      const nextBody = payload.body !== undefined ? String(payload.body) : (existing ? existing.body : '');
      const previewMd = buildSkillMarkdown({
        name: meta.id,
        description: payload.description || meta.summary,
        body: injectFlavorIntoBody(nextBody, meta.flavor)
      });

      const skillDir = resolveSafeChildPath(this.skillsDir, meta.id);
      const oldExtra = existing ? (existing.extraFiles || {}) : {};
      const { extraFiles: nextExtra } = buildMergedExtraFiles(skillDir, payload, oldExtra);

      const scanResult = scanSkillBundle({ markdown: previewMd, extraFiles: nextExtra });
      const baseHash = existing ? this.computeLiveSkillHash(meta.id) : null;
      const diffText = computeBundleDiff(existing ? existing.body : '', nextBody, oldExtra, nextExtra);
      const fileChanges = computeFileChanges(existing ? existing.body : '', nextBody, oldExtra, nextExtra, {
        isUpdate: Boolean(existing),
        removeReferences: payload.removeReferences,
        removeScripts: payload.removeScripts
      });
      const brokenRefs = findBrokenSubfileRefs(previewMd, nextExtra);

      const cleanSkillPayload = Object.assign({}, payload, {
        id: meta.id,
        categoryId: meta.categoryId,
        title: meta.title,
        summary: meta.summary,
        body: nextBody,
        ...(meta.lintExemptions ? { lintExemptions: meta.lintExemptions } : {})
      });
      delete cleanSkillPayload.assigned;
      delete cleanSkillPayload.approvalToken;
      delete cleanSkillPayload.actor;

      const propId = `prop_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const proposal = {
        proposalId: propId,
        createdAt: new Date().toISOString(),
        actor: safeActor,
        rationale: String(payload.rationale || payload.reason || '新增或修订技能提案').slice(0, 300),
        status: 'pending',
        isUpdate: Boolean(existing),
        baseHash,
        diffText,
        fileChanges,
        brokenRefs,
        security: scanResult,
        skillPayload: cleanSkillPayload
      };

      atomicWriteFile(resolveSafeChildPath(this.stagingDir, `${propId}.json`), JSON.stringify(proposal, null, 2) + '\n');
      this.audit.log({
        actor: safeActor,
        channel,
        action: 'proposal.create',
        targetId: meta.id,
        approval: 'pending-review',
        summary: `提交待审提案 ${propId}：「${meta.title}」(${scanResult.verdict})`
      });
      return proposal;
    });
  }

  applyAuthorizedViaMcp(payload, hostAgent) {
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(payload.id, 'skill id');
      const hasNewScripts = Boolean(
        (payload.scripts && Object.keys(payload.scripts).length > 0) ||
        (payload.extraFiles && Object.keys(payload.extraFiles).some(isExecutableFileName))
      );
      const hasFileDeletions = Boolean(
        (Array.isArray(payload.removeReferences) && payload.removeReferences.length > 0) ||
        (Array.isArray(payload.removeScripts) && payload.removeScripts.length > 0)
      );

      let existingForShrink = null;
      try { existingForShrink = this.getSkill(payload.id, { includeBody: true }); } catch (_nf) { existingForShrink = null; }
      const skillDirForShrink = resolveSafeChildPath(this.skillsDir, payload.id);
      const { extraFiles: previewExtraForShrink } = buildMergedExtraFiles(
        skillDirForShrink,
        payload,
        existingForShrink ? (existingForShrink.extraFiles || {}) : {},
        { strict: true }
      );
      const shrunkFiles = detectDestructiveShrink(existingForShrink, payload.body, previewExtraForShrink);
      const hasDestructiveShrink = shrunkFiles.length > 0;

      if (hasNewScripts || hasFileDeletions || hasDestructiveShrink) {
        const prop = this.createProposal(payload, hostAgent, 'mcp');
        this.audit.log({
          actor: hostAgent,
          channel: 'mcp',
          action: hasNewScripts
            ? 'mcp.apply_queued_scripts'
            : (hasFileDeletions ? 'mcp.apply_queued_deletions' : 'mcp.apply_queued_shrink'),
          targetId: payload.id,
          status: 'QUEUED',
          approval: 'requires-desktop-diff',
          summary: hasNewScripts
            ? `含可执行脚本，强制转入桌面 Diff 审批 (${prop.proposalId})`
            : (hasFileDeletions
              ? `含显式子文件删除，强制转入桌面 Diff 审批 (${prop.proposalId})`
              : `检测到文件清空或缩减至 10% 以下 (${shrunkFiles.join(', ')})，按删除处理转入桌面 Diff 审批 (${prop.proposalId})`)
        });
        return {
          applied: false,
          status: 'AWAITING_DESKTOP_DIFF_APPROVAL',
          reason: hasNewScripts
            ? '包含可执行脚本的技能变更必须在 Rosetta 桌面端审阅源码 Diff 后批准。'
            : (hasFileDeletions
              ? '包含显式子文件删除（removeReferences/removeScripts）的变更必须在 Rosetta 桌面端核对红色删除清单后批准。'
              : `检测到文件内容被清空或缩减至原体积 10% 以下（${shrunkFiles.join(', ')}），按删除操作转入 Rosetta 桌面端 Diff 审批。`),
          proposalId: prop.proposalId
        };
      }

      const grantCheck = this.grants.consumeGrant(payload.approvalToken, hostAgent, payload.id);
      if (!grantCheck.ok) {
        const prop = this.createProposal(payload, hostAgent, 'mcp');
        this.audit.log({
          actor: hostAgent,
          channel: 'mcp',
          action: 'mcp.apply_queued_no_grant',
          targetId: payload.id,
          status: 'QUEUED',
          approval: 'awaiting-user',
          summary: `未持单次授权码 (${grantCheck.reason})，已转入桌面待审队列 (${prop.proposalId})`
        });
        return {
          applied: false,
          status: 'AWAITING_USER_APPROVAL',
          reason: `${grantCheck.reason}。变更已记入审计日志与桌面「待审变更」队列，请由用户在桌面端审阅 Diff 点批准（或签发单次授权码后再调）。`,
          proposalId: prop.proposalId
        };
      }

      const cleanPayload = Object.assign({}, payload);
      delete cleanPayload.assigned;
      delete cleanPayload.approvalToken;
      delete cleanPayload.actor;

      const saved = this.saveSkill(cleanPayload, {
        actor: hostAgent,
        channel: 'mcp',
        approval: `one-time-grant:${grantCheck.grantId}`,
        forbidAssignMutation: true,
        reason: payload.reason || `MCP 凭单次授权码 (${grantCheck.grantId}) 更新: ${payload.id}`
      });

      return {
        applied: true,
        status: 'APPLIED_WITH_GRANT',
        grantId: grantCheck.grantId,
        skill: saved
      };
    });
  }

  listProposals() {
    if (!fs.existsSync(this.stagingDir)) return [];
    const files = fs.readdirSync(this.stagingDir).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(this.stagingDir, f), 'utf8'));
        if (p.status === 'pending') {
          const liveHash = p.skillPayload && p.skillPayload.id
            ? this.computeLiveSkillHash(p.skillPayload.id)
            : null;
          p.stale = Boolean(p.isUpdate && p.baseHash && liveHash && p.baseHash !== liveHash);
          if (!p.diffText && p.skillPayload && p.skillPayload.body) {
            p.diffText = computeBundleDiff('', p.skillPayload.body);
          }
          if ((!p.fileChanges || !Array.isArray(p.brokenRefs)) && p.skillPayload && p.skillPayload.id) {
            let liveSkill = null;
            try { liveSkill = this.getSkill(p.skillPayload.id, { includeBody: true }); } catch (_nf) { liveSkill = null; }
            hydrateProposalPreview(p, liveSkill, resolveSafeChildPath(this.skillsDir, p.skillPayload.id), findBrokenSubfileRefs);
          }
          out.push(p);
        }
      } catch (_badProp) { /* skip unreadable staging file */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  resolveProposal(proposalId, decision, actorOrOpts = 'local-script') {
    if (!actorOrOpts || typeof actorOrOpts !== 'object' || actorOrOpts.desktopToken !== DESKTOP_SESSION_SYMBOL) {
      throw new ValidationError(
        'ERR_DESKTOP_APPROVAL_REQUIRED',
        '待审提案仅限用户在 Rosetta 桌面端点击批准或驳回，禁止通过脚本或 CLI 自行审批。'
      );
    }
    return withCatalogLock(this.rosettaRoot, () => {
      validateSlug(proposalId, 'proposalId');
      const origin = normalizeOriginArgs(actorOrOpts, 'desktop');
      const safeActor = validateActor(origin.actor);
      const pPath = resolveSafeChildPath(this.stagingDir, `${proposalId}.json`);
      if (!fs.existsSync(pPath)) {
        throw new ValidationError('ERR_PROPOSAL_NOT_FOUND', `Proposal not found: ${proposalId}`);
      }
      const prop = JSON.parse(fs.readFileSync(pPath, 'utf8'));
      if (decision === 'approve') {
        const saved = this.saveSkill(prop.skillPayload, Object.assign({}, origin, {
          actor: safeActor,
          desktopToken: actorOrOpts.desktopToken,
          approval: `approved-proposal:${proposalId}`,
          forbidAssignMutation: true,
          reason: `批准 ${prop.actor} 提案: ${prop.skillPayload.title || prop.skillPayload.id}`
        }));
        prop.status = 'approved';
        prop.resolvedAt = new Date().toISOString();
        prop.resolvedBy = safeActor;
        atomicWriteFile(pPath, JSON.stringify(prop, null, 2) + '\n');
        this.audit.log(Object.assign({}, origin, {
          actor: safeActor,
          action: 'proposal.approve',
          targetId: saved.id,
          summary: `批准提案 ${proposalId}（来源: ${prop.actor}）正式入库`
        }));
        return { status: 'approved', skill: saved };
      }

      prop.status = 'rejected';
      prop.resolvedAt = new Date().toISOString();
      prop.resolvedBy = safeActor;
      atomicWriteFile(pPath, JSON.stringify(prop, null, 2) + '\n');
      this.audit.log(Object.assign({}, origin, {
        actor: safeActor,
        action: 'proposal.reject',
        targetId: prop.skillPayload ? prop.skillPayload.id : proposalId,
        summary: `驳回提案 ${proposalId}（来源: ${prop.actor}）`
      }));
      return { status: 'rejected', proposalId };
    });
  }

  getDashboardState() {
    const { items, brokenSkills } = this.listSkillsWithDiagnostics();
    return {
      categories: this.getCategories(),
      skills: items,
      externalSkills: this.externalSkills.listExternalSkills(),
      brokenSkills,
      mcpServers: this.getMcpRegistry(),
      proposals: this.listProposals(),
      snapshots: this.snapshots.listSnapshots(),
      auditLogs: this.audit.listRecent(50),
      auditChain: this.audit.verifyChain()
    };
  }
}

module.exports = {
  DEFAULT_CATEGORIES,
  CatalogService,
  injectFlavorIntoBody,
  stripFlavorFromBody
};
