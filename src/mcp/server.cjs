#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { VALID_AGENTS, ValidationError } = require('../contracts/schema.cjs');
const { CatalogService } = require('../core/catalog-service.cjs');
const { SyncEngine } = require('../core/sync-engine.cjs');
const { VaultService } = require('../core/vault-service.cjs');
const { FeedbackStore } = require('../core/feedback-store.cjs');
const { scanTextContent, scanDirectory, summarizeScan, redactFindingsSnippets } = require('../core/security-scanner.cjs');
const { verifyOrSearchLiterature } = require('../core/literature-verifier.cjs');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
const ROSETTA_ROOT = path.resolve(process.env.ROSETTA_ROOT || CODE_ROOT);
const HOST_AGENT = String(process.env.ROSETTA_ACTOR || '').trim().toLowerCase();

function readPackageVersionAt(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  }
  return JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'package.json'), 'utf8')).version;
}

const LOADED_VERSION = readPackageVersionAt(ROSETTA_ROOT);

function readOnDiskPackageVersion() {
  try {
    return readPackageVersionAt(ROSETTA_ROOT);
  } catch (_e) {
    return LOADED_VERSION;
  }
}

function assertNoVersionSkew() {
  const diskVersion = readOnDiskPackageVersion();
  if (diskVersion !== LOADED_VERSION) {
    throw new ValidationError(
      'ERR_MCP_VERSION_SKEW',
      `当前运行的 Rosetta MCP 进程版本 (${LOADED_VERSION}) 落后于磁盘代码版本 (${diskVersion})，已拒绝写入操作；请重启 DeepSeek Harness 后再试。`
    );
  }
}

// Fail-closed strict host identity check
if (!VALID_AGENTS.includes(HOST_AGENT)) {
  process.stderr.write(
    `[Rosetta MCP] Refusing to start: ROSETTA_ACTOR must be one of [${VALID_AGENTS.join(', ')}], received "${process.env.ROSETTA_ACTOR || ''}".\n`
  );
  process.exit(1);
}

const catalog = new CatalogService(ROSETTA_ROOT);
const syncEngine = new SyncEngine(catalog);
const vault = new VaultService(ROSETTA_ROOT);
const feedbackStore = new FeedbackStore(ROSETTA_ROOT);
const USAGE_LOG_PATH = path.join(ROSETTA_ROOT, 'runtime', 'usage-log.jsonl');

function isMountedForHost(skill) {
  return Boolean(skill && skill.assigned && skill.assigned[HOST_AGENT]);
}

function recordUsage(entry) {
  try {
    fs.mkdirSync(path.dirname(USAGE_LOG_PATH), { recursive: true });
    const row = Object.assign({
      ts: new Date().toISOString(),
      actor: HOST_AGENT
    }, entry);
    fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(row) + '\n', 'utf8');
  } catch (_ignoreLogErr) { /* usage logging must never break read tools */ }
}

function buildServerInstructions() {
  const mounted = [];
  for (const s of catalog.listSkills()) {
    if (!isMountedForHost(s)) continue;
    try {
      const safeSkill = s.diskDrifted ? catalog.getSkill(s.id, { includeBody: false, approvedOnly: true }) : s;
      if (safeSkill.security && safeSkill.security.passed) mounted.push(safeSkill);
    } catch (_skipUnapproved) { /* skip skill with drift and no approved baseline */ }
  }
  const lines = [
    'Rosetta 是用户的本地技能与偏好仓管系统（详见 CHARTER.md）：只做能力叠加，绝不替代 DeepSeek Harness 原生工具或插件；当卡片规则与用户当下的明确要求冲突时，一律以用户当下的话为准，事后再通过提案把卡片改准。',
    ...mounted.map((s) => `- ${s.id}：${String(s.summary || s.title).replace(/\s+/g, ' ').trim()}`),
    '用法：任务命中后先调用 rosetta_inspect(skillId) 读取最新版正文（需要时传 file 读 references/ 或 scripts/），再照做。',
    '无感反馈 SOP：当用户对真实成品随口给出好坏评价、偏好或红线时，不要让用户填表，后台静默调用 rosetta_feedback(action:"record") 记入本机流；若是明确红线或同领域累计 >=2 条，主动提炼后走 rosetta_propose 更新 user-decisions 或对应技能卡。'
  ];
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'rosetta_list',
    description: '列出 Rosetta 技能库板块、已登记外部链接技能与当前挂载给 DeepSeek Harness 的精简技能索引（节省上下文）。查看完整正文或 references 子文件请调 rosetta_inspect。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: '可选：按板块 ID 过滤' },
        onlyMounted: { type: 'boolean', description: '仅返回挂载给当前宿主的技能（默认 false）' },
        compact: { type: 'boolean', description: '极简模式：仅返回 id/cat/title/summary，大幅压缩上下文字节（默认 false）' }
      }
    }
  },
  {
    name: 'rosetta_inspect',
    description: '读取指定技能包的完整规范正文（含当前预设参数）、references 参考文件列表、安全报告及脚本路径；可传 file 读取指定 references/ 或 scripts/ 子文件正文。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能包 ID' },
        file: { type: 'string', description: '可选：要读取的子文件相对路径或文件名（如 references/excel-fast-modeling.md）' },
        includeReferences: { type: 'boolean', description: '可选：一次性返回全部 references/ 文件正文映射（默认 false）' }
      },
      required: ['skillId']
    }
  },
  {
    name: 'rosetta_verify_literature',
    description: '通过 Crossref 与 OpenAlex 官方学术接口实时核验论文 DOI 真伪或检索真实文献元数据。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['doi', 'search'], description: 'doi 精确核验或 search 关键词检索' },
        query: { type: 'string', description: 'DOI 编号或英文检索词' }
      },
      required: ['mode', 'query']
    }
  },
  {
    name: 'rosetta_security_scan',
    description: '对拟引入的外部 SKILL.md 文本或受允许工作区子目录运行静态启发式提示扫描（提示性质，含可执行脚本仍须经桌面人工审阅源码 Diff；目录扫描结果自动隐去原文片段）。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: '待扫描的文本内容' },
        directoryPath: { type: 'string', description: '待扫描的工作区或临时子目录路径（严格白名单限制）' }
      }
    }
  },
  {
    name: 'rosetta_propose',
    description: '向 Rosetta 待审变更队列提交新技能或修订草稿（支持 SKILL.md、references 与 scripts 多文件 Diff，记入带哈希链的追加审计日志，不直接修改正式库）。',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        categoryId: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string' },
        references: { type: 'object', description: '可选：references/ 文件名到 Markdown 文本映射' },
        scripts: { type: 'object', description: '可选：scripts/ 文件名到源码映射' },
        lintExemptions: {
          type: 'object',
          description: '可选：个人专用卡的按规则质检豁免（仅开放 ERR_PRIVATE_NAME_LEAK / ERR_INFORMAL_SLANG / WARN_THIN_SKILL）',
          properties: {
            rules: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
            scope: { type: 'string', enum: ['personal-only'] }
          }
        },
        rationale: { type: 'string', description: '新增或修改理由' }
      },
      required: ['id', 'categoryId', 'title', 'summary', 'body']
    }
  },
  {
    name: 'rosetta_apply_authorized',
    description: '受控写入入口：须传入用户在 Rosetta 桌面端「审计与授权」签发的单次授权码 approvalToken 方可直接合入纯文档/references 技能；未传授权码或含可执行脚本时自动转入桌面 Diff 待审队列，全程记入带 SHA-256 哈希链的追加审计日志。禁止修改挂载开关。',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        categoryId: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        body: { type: 'string' },
        references: { type: 'object', description: '可选：references/ 文件名到 Markdown 文本映射' },
        origin: { type: 'string', enum: ['official', 'github-verified', 'bespoke'] },
        sourceUrl: { type: 'string' },
        approvalToken: { type: 'string', description: '用户在 Rosetta 桌面端签发的 5 分钟单次授权码 (如 RSTA-XXXX-XXXX)' },
        reason: { type: 'string' }
      },
      required: ['id', 'body']
    }
  },
  {
    name: 'rosetta_snapshots',
    description: '查看 Rosetta 的历史原子快照与钉住里程碑列表。',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rosetta_vault_search',
    description: '只读检索本机已登记的项目交付件索引（原件保留在原项目目录，仅返回精简摘要与章节锚点目录，节省重读整文件的上下文开销）。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '可选：按项目名过滤' },
        query: { type: 'string', description: '可选：按关键词匹配标题、摘要、标签或章节锚点' },
        includeInactive: { type: 'boolean', description: '是否包含已取代 (superseded) 或撤回条目（默认 false）' }
      }
    }
  },
  {
    name: 'rosetta_vault_read',
    description: '按交付件 ID 读取索引详情并实时执行 SHA-256 哈希新鲜度核验（返回 CURRENT / STALE / MISSING / SUPERSEDED / WITHDRAWN）；可选按 anchor 精准切片读取原件片段。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '已登记的交付件唯一 ID' },
        anchor: { type: 'string', description: '可选：按章节标题关键词定位并切片读取该段落原件' },
        includeSnippet: { type: 'boolean', description: '可选：是否随响应附带首锚点或指定锚点的原件行切片（默认 false）' }
      },
      required: ['id']
    }
  },
  {
    name: 'rosetta_feedback',
    description: '轻量无感交付反馈流（仅写本机 runtime/feedback-log.jsonl，不改动正式技能库，不弹窗打扰用户）：record 随手记一条用户对真实产出的好/坏/红线评价，list 查看未归档反馈，resolve 在提案归档后标记已消化。',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'list', 'resolve'], description: '操作类型：record（记录）、list（查询）、resolve（标记已归档）' },
        kind: { type: 'string', enum: ['good', 'bad', 'redline', 'preference'], description: 'record 必填：评价类别（好/坏/红线/偏好）' },
        domain: { type: 'string', description: '领域标签（如 code / aesthetic / prose / academic / workflow / communication）' },
        note: { type: 'string', description: 'record 必填：提炼后的具体反馈与原因；resolve 可选备注' },
        quote: { type: 'string', description: '可选：用户的原话短句' },
        skillId: { type: 'string', description: '可选：关联的 Rosetta 技能 ID' },
        artifactPath: { type: 'string', description: '可选：关联的真实作品路径或名称' },
        includeResolved: { type: 'boolean', description: 'list 可选：是否包含已归档条目（默认 false）' },
        limit: { type: 'number', description: 'list 可选：最多返回条数（默认 20）' },
        ids: { type: 'array', items: { type: 'string' }, description: 'resolve 必填：要标记已归档的反馈 ID 列表' },
        resolution: { type: 'string', enum: ['promoted', 'dismissed'], description: 'resolve 可选：归档结论（默认 promoted）' },
        proposalId: { type: 'string', description: 'resolve 可选：对应的 rosetta_propose 提案 ID' }
      },
      required: ['action']
    }
  }
];

function isPathInsideBase(candidatePath, baseDir) {
  const realBase = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);
  const probe = fs.existsSync(candidatePath) ? fs.realpathSync(candidatePath) : path.resolve(candidatePath);
  const rel = path.relative(realBase, probe);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function validateSafeScanDir(dirPath) {
  const resolved = path.resolve(dirPath);
  const rootParsed = path.parse(resolved).root;
  if (resolved === rootParsed) {
    throw new Error('ERR_SCAN_ROOT_FORBIDDEN: Scanning drive root is forbidden.');
  }

  const workspaceRoot = path.resolve(ROSETTA_ROOT, '..');
  const tmpRoot = os.tmpdir();
  const extraAllow = process.env.ROSETTA_SCAN_ALLOWLIST
    ? process.env.ROSETTA_SCAN_ALLOWLIST.split(path.delimiter).map((p) => p.trim()).filter(Boolean)
    : [];
  const allowedRoots = [ROSETTA_ROOT, workspaceRoot, tmpRoot, ...extraAllow];

  const allowed = allowedRoots.some((base) => isPathInsideBase(resolved, base));
  if (!allowed) {
    throw new Error('ERR_SCAN_OUTSIDE_ALLOWLIST: Directory must reside inside the workspace or temporary scratch directory.');
  }
  return resolved;
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'rosetta_list': {
      recordUsage({
        tool: 'rosetta_list',
        skillId: null,
        file: null,
        categoryId: args.categoryId || null,
        onlyMounted: Boolean(args.onlyMounted),
        compact: Boolean(args.compact)
      });
      const state = catalog.getDashboardState();
      let skills = args.categoryId
        ? state.skills.filter((s) => s.categoryId === args.categoryId)
        : state.skills;
      let compact = skills.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        title: s.title,
        summary: s.summary,
        version: s.version,
        hasScripts: (s.scripts || []).length > 0,
        referenceCount: (s.references || []).length,
        diskDrifted: Boolean(s.diskDrifted),
        mountedForCurrentHost: isMountedForHost(s)
      }));
      if (args.onlyMounted) {
        compact = compact.filter((s) => s.mountedForCurrentHost);
      }
      const externalCompact = (state.externalSkills || []).map((ext) => ({
        id: ext.id,
        title: ext.title,
        version: ext.version,
        routingNote: ext.routingNote,
        integrityOk: ext.integrityOk,
        mountedForCurrentHost: Boolean(ext.assigned && ext.assigned[HOST_AGENT])
      }));
      const diskVer = readOnDiskPackageVersion();
      if (args.compact) {
        return {
          host: HOST_AGENT,
          ver: LOADED_VERSION,
          ...(diskVer !== LOADED_VERSION ? { versionSkewWarning: `进程版本 (${LOADED_VERSION}) 落后于磁盘版本 (${diskVer})` } : {}),
          skills: compact.map((s) => ({ id: s.id, cat: s.categoryId, title: s.title, summary: s.summary }))
        };
      }
      return {
        currentHost: HOST_AGENT,
        serverVersion: LOADED_VERSION,
        ...(diskVer !== LOADED_VERSION ? { versionSkewWarning: `进程版本 (${LOADED_VERSION}) 落后于磁盘版本 (${diskVer})，请重启 DeepSeek Harness` } : {}),
        categories: state.categories.map((c) => ({ id: c.id, code: c.code, title: c.title })),
        skillCount: compact.length,
        mountedCount: compact.filter((s) => s.mountedForCurrentHost).length,
        externalSkills: args.onlyMounted ? externalCompact.filter((e) => e.mountedForCurrentHost) : externalCompact,
        pendingProposals: state.proposals.length,
        brokenCount: (state.brokenSkills || []).length,
        skills: compact
      };
    }
    case 'rosetta_inspect': {
      const detail = catalog.getSkill(args.skillId, {
        includeBody: true,
        subFile: args.file || undefined,
        approvedOnly: true
      });
      recordUsage({
        tool: 'rosetta_inspect',
        skillId: detail.id,
        file: args.file || (args.includeReferences ? '*references' : null)
      });
      const skillDir = detail.resolvedSkillDir || path.join(catalog.skillsDir, detail.id);
      return {
        id: detail.id,
        categoryId: detail.categoryId,
        title: detail.title,
        summary: detail.summary,
        origin: detail.origin,
        sourceUrl: detail.sourceUrl,
        version: detail.version,
        flavor: detail.flavor,
        mountedForCurrentHost: isMountedForHost(detail),
        diskDrifted: Boolean(detail.diskDrifted),
        servingApprovedBaseline: Boolean(detail.servingApprovedBaseline),
        securityVerdict: detail.security.verdict,
        scannedFiles: detail.security.scannedFiles,
        rawMarkdown: detail.rawMarkdown,
        references: detail.references || [],
        referencePaths: (detail.references || []).map((f) => path.join(skillDir, 'references', f)),
        ...(args.includeReferences ? { referenceFiles: detail.referenceFiles || {} } : {}),
        ...(detail.selectedFile ? { selectedFile: detail.selectedFile } : {}),
        nodeRuntime: process.execPath,
        scriptPaths: (detail.scripts || []).map((f) => path.join(skillDir, 'scripts', f))
      };
    }
    case 'rosetta_verify_literature':
      return await verifyOrSearchLiterature(args.mode, args.query);
    case 'rosetta_security_scan': {
      if (args.directoryPath) {
        const safeDir = validateSafeScanDir(args.directoryPath);
        return redactFindingsSnippets(scanDirectory(safeDir, { maxDepth: 4, maxFiles: 120 }));
      }
      const findings = scanTextContent(args.markdown || '', 'SKILL.md');
      return summarizeScan(findings, 1, false);
    }
    case 'rosetta_propose':
      assertNoVersionSkew();
      return catalog.createProposal(args, HOST_AGENT, 'mcp');
    case 'rosetta_apply_authorized': {
      assertNoVersionSkew();
      const out = catalog.applyAuthorizedViaMcp(args, HOST_AGENT);
      if (out.applied) {
        syncEngine.syncAll({ actor: HOST_AGENT, channel: 'mcp-grant' });
      }
      return out;
    }
    case 'rosetta_snapshots':
      return { snapshots: catalog.snapshots.listSnapshots() };
    case 'rosetta_vault_search':
      return vault.listEntries({
        project: args.project,
        query: args.query,
        includeInactive: Boolean(args.includeInactive)
      });
    case 'rosetta_vault_read':
      return vault.readEntry(args.id, {
        anchor: args.anchor,
        includeSnippet: Boolean(args.includeSnippet)
      });
    case 'rosetta_feedback': {
      const action = String(args.action || '').trim().toLowerCase();
      recordUsage({
        tool: 'rosetta_feedback',
        action,
        skillId: args.skillId || null,
        domain: args.domain || null
      });
      if (action === 'record') {
        return feedbackStore.record({
          kind: args.kind,
          domain: args.domain,
          note: args.note,
          quote: args.quote,
          skillId: args.skillId,
          artifactPath: args.artifactPath
        }, HOST_AGENT);
      }
      if (action === 'list') {
        return feedbackStore.list({
          domain: args.domain,
          kind: args.kind,
          skillId: args.skillId,
          includeResolved: Boolean(args.includeResolved),
          limit: args.limit
        });
      }
      if (action === 'resolve') {
        return feedbackStore.resolve(args.ids, {
          resolution: args.resolution,
          proposalId: args.proposalId,
          note: args.note
        }, HOST_AGENT);
      }
      throw new ValidationError('ERR_INVALID_FEEDBACK_ACTION', `Unsupported rosetta_feedback action: "${args.action}"`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

let useContentLength = false;
function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const byteLen = Buffer.byteLength(json, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function handleRpc(req) {
  if (!req || typeof req !== 'object') return;
  const { id, method, params } = req;

  if (method === 'notifications/initialized' || id === undefined) {
    return;
  }

  try {
    if (method === 'initialize') {
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: {
            tools: {},
            prompts: {},
            resources: {}
          },
          serverInfo: { name: 'rosetta-dsh', version: LOADED_VERSION },
          instructions: buildServerInstructions()
        }
      });
    } else if (method === 'ping') {
      sendMessage({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      sendMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      try {
        const out = await handleToolCall(params.name, params.arguments || {});
        sendMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
            isError: false
          }
        });
      } catch (toolErr) {
        sendMessage({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: toolErr.code || 'ERROR', message: toolErr.message, details: toolErr.scanResult }, null, 2) }],
            isError: true
          }
        });
      }
    } else if (method === 'prompts/list') {
      const mounted = [];
      for (const s of catalog.listSkills()) {
        if (!isMountedForHost(s)) continue;
        try {
          const safeSkill = s.diskDrifted ? catalog.getSkill(s.id, { includeBody: false, approvedOnly: true }) : s;
          if (safeSkill.security && safeSkill.security.passed) mounted.push(safeSkill);
        } catch (_skipUnapproved) { /* skip skill with drift and no approved baseline */ }
      }
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          prompts: mounted.map((s) => ({
            name: s.id,
            description: `${s.title} — ${s.summary}`,
            arguments: [
              { name: 'task', description: '当前要处理的具体问题或内容（可选）', required: false }
            ]
          }))
        }
      });
    } else if (method === 'prompts/get') {
      const skillId = params && params.name;
      const detail = catalog.getSkill(skillId, { includeBody: true, approvedOnly: true });
      const userTask = params && params.arguments && params.arguments.task
        ? `\n\n---\n当前任务：\n${params.arguments.task}`
        : '';
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          description: detail.title,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `请严格启用并遵循以下 Rosetta 技能规范（${detail.title}）：\n\n${detail.rawMarkdown}${userTask}`
              }
            }
          ]
        }
      });
    } else if (method === 'resources/list') {
      const mounted = [];
      for (const s of catalog.listSkills()) {
        if (!isMountedForHost(s)) continue;
        try {
          const safeSkill = s.diskDrifted ? catalog.getSkill(s.id, { includeBody: false, approvedOnly: true }) : s;
          if (safeSkill.security && safeSkill.security.passed) mounted.push(safeSkill);
        } catch (_skipUnapproved) { /* skip skill with drift and no approved baseline */ }
      }
      const resources = [];
      for (const s of mounted) {
        resources.push({
          uri: `rosetta://skills/${s.id}`,
          name: s.title,
          description: s.summary,
          mimeType: 'text/markdown'
        });
        for (const refFile of s.references || []) {
          resources.push({
            uri: `rosetta://skills/${s.id}/references/${refFile}`,
            name: `${s.title} · ${refFile}`,
            description: `${s.id} 按需加载参考文档 (${refFile})`,
            mimeType: 'text/markdown'
          });
        }
      }
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: { resources }
      });
    } else if (method === 'resources/read') {
      const uri = String((params && params.uri) || '');
      const m = uri.match(/^rosetta:\/\/skills\/([a-z0-9_-]+)(?:\/(.+))?$/);
      if (!m) throw new Error(`Unsupported resource URI: ${uri}`);
      const detail = catalog.getSkill(m[1], {
        includeBody: true,
        subFile: m[2] || undefined,
        approvedOnly: true
      });
      recordUsage({
        tool: 'resources/read',
        skillId: detail.id,
        file: m[2] || null
      });
      const text = detail.selectedFile ? detail.selectedFile.content : detail.rawMarkdown;
      sendMessage({
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text
            }
          ]
        }
      });
    } else {
      sendMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  } catch (err) {
    sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message }
    });
  }
}

let buffer = Buffer.alloc(0);
let rpcQueue = Promise.resolve();
function enqueueRpc(parsed) {
  rpcQueue = rpcQueue.then(() => handleRpc(parsed)).catch(() => {});
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const str = buffer.toString('utf8');
    if (str.startsWith('Content-Length:')) {
      useContentLength = true;
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buffer = Buffer.alloc(0); return; }
      const len = parseInt(m[1], 10);
      const totalNeeded = headerEnd + 4 + len;
      if (buffer.length < totalNeeded) return;
      const bodyStr = buffer.slice(headerEnd + 4, totalNeeded).toString('utf8');
      buffer = buffer.slice(totalNeeded);
      try {
        enqueueRpc(JSON.parse(bodyStr));
      } catch (_parseErr) {
        sendMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON payload' } });
      }
    } else {
      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = buffer.slice(0, nlIdx).toString('utf8').trim();
      buffer = buffer.slice(nlIdx + 1);
      if (line) {
        try {
          enqueueRpc(JSON.parse(line));
        } catch (_parseErr) {
          sendMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: invalid JSON line' } });
        }
      }
    }
  }
});

process.stdin.on('end', () => {
  rpcQueue.finally(() => process.exit(0));
});
