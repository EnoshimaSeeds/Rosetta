#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CatalogService } = require('../src/core/catalog-service.cjs');
const { SyncEngine } = require('../src/core/sync-engine.cjs');
const { scanDirectory } = require('../src/core/security-scanner.cjs');
const { lintCatalog } = require('../src/core/catalog-linter.cjs');
const { VaultService } = require('../src/core/vault-service.cjs');
const { generateDshConfig } = require('../src/core/dsh-config-generator.cjs');

const root = process.env.ROSETTA_ROOT || path.resolve(__dirname, '..');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const catalog = new CatalogService(root);
const syncEngine = new SyncEngine(catalog);
const vault = new VaultService(root);

const rawArgs = process.argv.slice(2);
let cliActor = process.env.ROSETTA_ACTOR || 'cli-local';
let onBehalfOf = undefined;
let targetDir = undefined;
let outputJson = false;
const positional = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--actor' && rawArgs[i + 1]) {
    cliActor = rawArgs[++i];
  } else if (rawArgs[i] === '--on-behalf-of' && rawArgs[i + 1]) {
    onBehalfOf = rawArgs[++i];
  } else if (rawArgs[i] === '--target' && rawArgs[i + 1]) {
    targetDir = rawArgs[++i];
  } else if (rawArgs[i] === '--json') {
    outputJson = true;
  } else {
    positional.push(rawArgs[i]);
  }
}

const [cmd = 'help', arg1, arg2] = positional;

try {
  switch (cmd) {
    case 'status':
    case 'list': {
      const state = catalog.getDashboardState();
      console.log(JSON.stringify({
        version: pkgVersion,
        edition: 'DeepSeek Harness',
        rosettaRoot: root,
        dshSkillsTarget: syncEngine.targets.dsh,
        categories: state.categories.length,
        skills: state.skills.length,
        auditChain: state.auditChain,
        externalSkills: (state.externalSkills || []).map((e) => ({
          id: e.id,
          version: e.version,
          integrityOk: e.integrityOk,
          mountedForDsh: Boolean(e.assigned && e.assigned.dsh)
        })),
        pendingProposals: state.proposals.length,
        snapshots: state.snapshots.length,
        items: state.skills.map((s) => ({
          id: s.id,
          category: s.categoryId,
          title: s.title,
          scannedFiles: s.security.scannedFiles,
          security: s.security.verdict,
          diskDrifted: Boolean(s.diskDrifted),
          mountedForDsh: Boolean(s.assigned && s.assigned.dsh)
        }))
      }, null, 2));
      break;
    }
    case 'dsh-config': {
      const cfg = generateDshConfig(root);
      if (outputJson) {
        console.log(JSON.stringify(cfg, null, 2));
      } else {
        console.log([
          `# Rosetta for DeepSeek Harness (v${pkgVersion}) — 本机实算接入配置`,
          '',
          `Rosetta Root:       ${cfg.rosettaRoot}`,
          `DSH Skills Target:  ${cfg.dshSkillsDir}`,
          `Cordis Patch Path:  ${cfg.suggestedCordisPatchPath}`,
          `Global Fallback:    ${cfg.fallbackGlobalCordisPatchPath}`,
          `MCP Tool Prefix:    ${cfg.toolNamePrefix}<toolName>`,
          '',
          '## 1. Cordis Patch 配置（写入 ~/.dsh/profiles/web/cordis.patch.yml 或 ~/.dsh/cordis.patch.yml）',
          cfg.cordisPatchYaml,
          '',
          '## 2. 若目标 profile 尚未安装 MCP 客户端插件，先执行：',
          `  ${cfg.pluginInstallCommand}`,
          '',
          '## 3. 核验与同步命令（如后续使用 nvm 等工具切换 Node 版本，请重新运行 dsh-config 更新 command 路径）',
          ...cfg.verifyCommands.map((c) => `  ${c}`)
        ].join('\n'));
      }
      break;
    }
    case 'inspect': {
      if (!arg1) throw new Error('Usage: rosetta inspect <skill-id> [subfile]');
      console.log(JSON.stringify(catalog.getSkill(arg1, { includeBody: true, subFile: arg2 || undefined }), null, 2));
      break;
    }
    case 'scan': {
      if (!arg1) throw new Error('Usage: rosetta scan <directory-path>');
      console.log(JSON.stringify(scanDirectory(path.resolve(arg1)), null, 2));
      break;
    }
    case 'sync': {
      console.log(JSON.stringify(syncEngine.syncAll({ actor: cliActor, channel: 'cli', onBehalfOf, targetDir }), null, 2));
      break;
    }
    case 'audit': {
      const chain = catalog.audit.verifyChain();
      console.log(JSON.stringify(chain, null, 2));
      if (!chain.ok) process.exit(1);
      break;
    }
    case 'lint': {
      const rep = lintCatalog(root);
      console.log(JSON.stringify(rep, null, 2));
      if (!rep.ok) process.exit(1);
      break;
    }
    case 'vault': {
      const sub = arg1 || 'list';
      if (sub === 'list') {
        console.log(JSON.stringify(vault.listEntries({ project: arg2 || undefined, includeInactive: true }), null, 2));
      } else if (sub === 'verify') {
        const res = vault.verifyAll();
        console.log(JSON.stringify(res, null, 2));
        if (!res.allActiveCurrent) process.exit(1);
      } else if (sub === 'read') {
        if (!arg2) throw new Error('Usage: rosetta vault read <id> [anchor]');
        const anchorArg = positional[3] || undefined;
        console.log(JSON.stringify(vault.readEntry(arg2, { anchor: anchorArg, includeSnippet: Boolean(anchorArg) }), null, 2));
      } else {
        throw new Error('Usage: rosetta vault <list|verify|read> ...');
      }
      break;
    }
    case 'backfill-hashes': {
      const { computeFileHashMap } = require('../src/core/baseline-store.cjs');
      const { atomicWriteFile } = require('../src/core/snapshot-store.cjs');
      const { withCatalogLock } = require('../src/core/lock-and-audit.cjs');
      const updated = withCatalogLock(root, () => {
        const allSkills = catalog.listSkills();
        const changed = [];
        for (const s of allSkills) {
          const mp = path.join(catalog.skillsDir, s.id, 'rosetta.meta.json');
          if (!fs.existsSync(mp)) continue;
          const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const full = catalog.getSkill(s.id, { includeBody: true });
          const nextHashes = computeFileHashMap(full.rawMarkdown, full.extraFiles);
          if (JSON.stringify(meta.fileHashes || null) !== JSON.stringify(nextHashes)) {
            meta.fileHashes = nextHashes;
            atomicWriteFile(mp, JSON.stringify(meta, null, 2) + '\n');
            changed.push(s.id);
          }
        }
        catalog.audit.log({
          actor: cliActor,
          ...(onBehalfOf ? { onBehalfOf } : {}),
          channel: 'cli',
          action: 'catalog.backfill_hashes',
          targetId: 'all',
          approval: 'cli-command',
          summary: `执行元数据 fileHashes 同步校验（更新 ${changed.length} 张技能卡，全仓 ${allSkills.length} 张已对齐）`
        });
        return changed;
      });
      console.log(JSON.stringify({ ok: true, updatedCount: updated.length, updated }, null, 2));
      break;
    }
    case 'snapshots': {
      console.log(JSON.stringify(catalog.snapshots.listSnapshots(), null, 2));
      break;
    }
    case 'rollback': {
      if (!arg1) throw new Error('Usage: rosetta rollback <snapshot-id> [--actor <name>] [--on-behalf-of <name>]');
      const actorName = arg2 || cliActor;
      const res = catalog.snapshots.rollback(arg1, actorName);
      catalog.baselines.seedCleanBaselines({ forceRefresh: true });
      catalog.audit.log({
        actor: actorName,
        ...(onBehalfOf ? { onBehalfOf } : {}),
        channel: 'cli',
        action: 'snapshot.rollback',
        targetId: arg1,
        approval: 'cli-command',
        summary: `CLI 回滚至快照 ${arg1}`
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    default:
      console.log([
        `Rosetta CLI v${pkgVersion} — Local Skill & MCP Studio for DeepSeek Harness`,
        '',
        'Commands:',
        '  node bin/rosetta.cjs status                         查看全仓概览、DSH 目标目录与审计链状态',
        '  node bin/rosetta.cjs dsh-config [--json]            生成当前机器的 DeepSeek Harness 接入配置块',
        '  node bin/rosetta.cjs sync [--target <dir>]          同步已挂载技能至 ~/.dsh/skills 或指定项目目录',
        '  node bin/rosetta.cjs inspect <skill-id> [file]      查看指定技能详情及 references/ 子文件',
        '  node bin/rosetta.cjs scan <dir>                     对目录运行静态启发式与能力提示扫描',
        '  node bin/rosetta.cjs lint                           运行技能编录质检与清洁度门禁',
        '  node bin/rosetta.cjs audit                          校验 SHA-256 操作审计日志哈希链连续性',
        '  node bin/rosetta.cjs vault <list|verify|read>       管理本地交付件索引与哈希新鲜度校验',
        '  node bin/rosetta.cjs snapshots                      查看历史原子快照',
        '  node bin/rosetta.cjs rollback <snap-id>             无损回滚至指定快照'
      ].join('\n'));
  }
} catch (err) {
  console.error('[Rosetta Error]', err.message);
  process.exit(1);
}
