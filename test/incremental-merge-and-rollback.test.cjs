'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CatalogService } = require('../src/core/catalog-service.cjs');
const { lintSkillDir } = require('../src/core/catalog-linter.cjs');
const { DESKTOP_SESSION_SYMBOL } = require('../src/core/lock-and-audit.cjs');
const { RosettaDispatcher } = require('../src/desktop/ipc-dispatcher.cjs');

const DESKTOP_ORIGIN = {
  actor: 'User',
  channel: 'desktop',
  approval: 'direct-ui',
  desktopToken: DESKTOP_SESSION_SYMBOL
};

test('partial proposal preserves untouched references and scripts (default incremental merge)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rosetta-pub-merge-'));
  try {
    const catalog = new CatalogService(tmpRoot);
    catalog.saveSkill({
      id: 'merge-safety-skill',
      categoryId: 'aesthetics',
      title: 'Incremental Merge Test',
      summary: 'Ensures partial proposals keep untouched references and scripts.',
      body: '# Merge Test\n- `references/a.md`\n- `references/b.md`\n- `references/c.md`\n- `references/d.md`\n- `scripts/s1.cjs`\n- `scripts/s2.cjs`\n',
      references: { 'a.md': '# A1\n', 'b.md': '# B1\n', 'c.md': '# C1\n', 'd.md': '# D1\n' },
      scripts: { 's1.cjs': "'use strict';\n", 's2.cjs': "'use strict';\n" }
    }, DESKTOP_ORIGIN);

    const prop = catalog.createProposal({
      id: 'merge-safety-skill',
      categoryId: 'aesthetics',
      title: 'Incremental Merge Test',
      summary: 'Ensures partial proposals keep untouched references and scripts.',
      body: '# Merge Test\n- `references/a.md`\n- `references/b.md`\n- `references/c.md`\n- `references/d.md`\n- `scripts/s1.cjs`\n- `scripts/s2.cjs`\n',
      references: { 'a.md': '# A2\n' },
      scripts: { 's1.cjs': "'use strict';\n// v2\n" },
      rationale: 'Update only a.md and s1.cjs'
    }, 'dsh', 'mcp');

    assert.deepEqual(prop.fileChanges.removed, []);
    assert.ok(prop.fileChanges.modified.includes('references/a.md'));
    assert.ok(prop.fileChanges.modified.includes('scripts/s1.cjs'));

    catalog.resolveProposal(prop.proposalId, 'approve', DESKTOP_ORIGIN);
    const skillDir = path.join(tmpRoot, 'catalog', 'skills', 'merge-safety-skill');
    assert.deepEqual(fs.readdirSync(path.join(skillDir, 'references')).sort(), ['a.md', 'b.md', 'c.md', 'd.md']);
    assert.deepEqual(fs.readdirSync(path.join(skillDir, 'scripts')).sort(), ['s1.cjs', 's2.cjs']);
    assert.equal(fs.readFileSync(path.join(skillDir, 'references', 'a.md'), 'utf8'), '# A2\n');
    assert.equal(fs.readFileSync(path.join(skillDir, 'references', 'b.md'), 'utf8'), '# B1\n');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('explicit removeReferences and removeScripts remove only named files, require desktop diff on MCP grant, and linter catches ./ broken refs', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rosetta-pub-rm-'));
  try {
    const catalog = new CatalogService(tmpRoot);
    catalog.saveSkill({
      id: 'rm-safety-skill',
      categoryId: 'industrial',
      title: 'Explicit Remove Test',
      summary: 'Verifies explicit file deletion and broken-ref detection.',
      body: '# Remove Test\n- `references/keep.md`\n- `./references/old.md`\n- `scripts/keep.cjs`\n- `./scripts/old.cjs`\n',
      references: { 'keep.md': '# Keep\n', 'old.md': '# Old\n' },
      scripts: { 'keep.cjs': "'use strict';\n", 'old.cjs': "'use strict';\n" }
    }, DESKTOP_ORIGIN);

    const grant = catalog.grants.issueOneTimeGrant({ allowedHost: 'dsh', skillId: 'rm-safety-skill', ttlSeconds: 300 });
    const mcpRes = catalog.applyAuthorizedViaMcp({
      id: 'rm-safety-skill',
      categoryId: 'industrial',
      title: 'Explicit Remove Test',
      summary: 'Verifies explicit file deletion and broken-ref detection.',
      body: '# Remove Test\n- `references/keep.md`\n- `./references/old.md`\n- `scripts/keep.cjs`\n- `./scripts/old.cjs`\n',
      removeReferences: ['old.md'],
      removeScripts: ['old.cjs'],
      approvalToken: grant.token
    }, 'dsh');
    assert.equal(mcpRes.applied, false);
    assert.equal(mcpRes.status, 'AWAITING_DESKTOP_DIFF_APPROVAL');

    const pending = catalog.listProposals().find((p) => p.proposalId === mcpRes.proposalId);
    assert.deepEqual(pending.fileChanges.removed.sort(), ['references/old.md', 'scripts/old.cjs']);
    assert.deepEqual(pending.brokenRefs.sort(), ['references/old.md', 'scripts/old.cjs']);

    catalog.resolveProposal(mcpRes.proposalId, 'approve', DESKTOP_ORIGIN);
    const skillDir = path.join(tmpRoot, 'catalog', 'skills', 'rm-safety-skill');
    assert.deepEqual(fs.readdirSync(path.join(skillDir, 'references')), ['keep.md']);
    assert.deepEqual(fs.readdirSync(path.join(skillDir, 'scripts')), ['keep.cjs']);

    const findings = lintSkillDir(skillDir, 'rm-safety-skill');
    const brokenCodes = findings.filter((f) => f.code === 'ERR_BROKEN_SUBFILE_REF');
    assert.equal(brokenCodes.length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('per-skill snapshot rollback restores only the chosen skill while preserving concurrent skills and assignments', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rosetta-pub-rb-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rosetta-pub-home-'));
  try {
    const dispatcher = new RosettaDispatcher(tmpRoot, { homeDir: fakeHome });
    const catalog = dispatcher.catalog;
    catalog.saveSkill({
      id: 'target-card',
      categoryId: 'aesthetics',
      title: 'Target v1',
      summary: 'Skill to roll back individually.',
      body: '# Target v1\n- `references/a.md`\n- `references/b.md`\n',
      references: { 'a.md': '# A1\n', 'b.md': '# B1\n' },
      assigned: { dsh: true }
    }, DESKTOP_ORIGIN);

    const snap = catalog.snapshots.createSnapshot('Target v1 milestone', 'User', { pinned: true });

    catalog.saveSkill({
      id: 'target-card',
      categoryId: 'aesthetics',
      title: 'Target v2',
      summary: 'Skill modified after milestone.',
      body: '# Target v2\n- `references/a.md`\n',
      removeReferences: ['b.md']
    }, DESKTOP_ORIGIN);

    catalog.saveSkill({
      id: 'sibling-card',
      categoryId: 'industrial',
      title: 'Sibling Card',
      summary: 'Concurrent skill that must remain untouched.',
      body: '# Sibling\nSafe.\n',
      assigned: { dsh: true }
    }, DESKTOP_ORIGIN);

    const res = dispatcher.dispatch('rollbackSkillSnapshot', { snapshotId: snap.id, skillId: 'target-card' });
    assert.equal(res.ok, true);
    const restored = catalog.getSkill('target-card', { includeBody: true });
    assert.equal(restored.title, 'Target v1');
    assert.deepEqual(Object.keys(restored.referenceFiles).sort(), ['a.md', 'b.md']);
    assert.equal(restored.diskDrifted, false);

    const sibling = catalog.getSkill('sibling-card', { includeBody: true });
    assert.equal(sibling.title, 'Sibling Card');
    assert.equal(catalog.audit.verifyChain().ok, true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('snapshot rollback rejects unlisted injected files, keeps safety snapshot clean, blocks grant blanking/shrink, and rejects remove+add conflicts', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rosetta-pub-p8-'));
  try {
    const catalog = new CatalogService(tmpRoot);
    const longDoc = '# Detailed Spec\n' + 'Important guideline line.\n'.repeat(20);
    catalog.saveSkill({
      id: 'hardening-card',
      categoryId: 'aesthetics',
      title: 'Hardening Card',
      summary: 'Tests H1, H2, M1 and P3 invariants.',
      body: '# Card\n- `references/doc.md`\n- `references/short.md`\n- `scripts/ok.cjs`\n',
      references: { 'doc.md': longDoc, 'short.md': '# Short\n' },
      scripts: { 'ok.cjs': "'use strict';\n" }
    }, DESKTOP_ORIGIN);

    // P3 + R1: remove + upsert conflict (both direct references/scripts and extraFiles routes)
    assert.throws(() => {
      catalog.createProposal({
        id: 'hardening-card',
        categoryId: 'aesthetics',
        title: 'Hardening Card',
        summary: 'Tests H1, H2, M1 and P3 invariants.',
        body: '# Card\n',
        references: { 'short.md': '# Conflict\n' },
        removeReferences: ['short.md']
      }, 'dsh', 'mcp');
    }, /Cannot both add\/update and remove/);

    assert.throws(() => {
      catalog.createProposal({
        id: 'hardening-card',
        categoryId: 'aesthetics',
        title: 'Hardening Card',
        summary: 'Tests H1, H2, M1 and P3 invariants.',
        body: '# Card\n',
        extraFiles: { 'references/short.md': '# Conflict via extraFiles\n' },
        removeReferences: ['short.md']
      }, 'dsh', 'mcp');
    }, (err) => err && err.code === 'ERR_CONFLICTING_SUBFILE_OP');

    assert.throws(() => {
      catalog.createProposal({
        id: 'hardening-card',
        categoryId: 'aesthetics',
        title: 'Hardening Card',
        summary: 'Tests H1, H2, M1 and P3 invariants.',
        body: '# Card\n',
        extraFiles: { 'scripts/ok.cjs': "'use strict';\n" },
        removeScripts: ['ok.cjs']
      }, 'dsh', 'mcp');
    }, (err) => err && err.code === 'ERR_CONFLICTING_SUBFILE_OP');

    // M1: grant blanking & >90% shrink forced to Desktop Diff
    const g1 = catalog.grants.issueOneTimeGrant({ allowedHost: 'dsh', skillId: 'hardening-card', ttlSeconds: 300 });
    const r1 = catalog.applyAuthorizedViaMcp({
      id: 'hardening-card',
      categoryId: 'aesthetics',
      title: 'Hardening Card',
      summary: 'Tests H1, H2, M1 and P3 invariants.',
      body: '# Card\n- `references/doc.md`\n- `references/short.md`\n- `scripts/ok.cjs`\n',
      references: { 'short.md': '' },
      approvalToken: g1.token
    }, 'dsh');
    assert.equal(r1.applied, false);
    assert.equal(r1.status, 'AWAITING_DESKTOP_DIFF_APPROVAL');

    const g2 = catalog.grants.issueOneTimeGrant({ allowedHost: 'dsh', skillId: 'hardening-card', ttlSeconds: 300 });
    const r2 = catalog.applyAuthorizedViaMcp({
      id: 'hardening-card',
      categoryId: 'aesthetics',
      title: 'Hardening Card',
      summary: 'Tests H1, H2, M1 and P3 invariants.',
      body: '# Card\n- `references/doc.md`\n- `references/short.md`\n- `scripts/ok.cjs`\n',
      references: { 'doc.md': 'tiny' },
      approvalToken: g2.token
    }, 'dsh');
    assert.equal(r2.applied, false);
    assert.equal(r2.status, 'AWAITING_DESKTOP_DIFF_APPROVAL');

    // H1: clean safety snapshot (no dot staging dirs)
    const snap = catalog.snapshots.createSnapshot('Clean milestone', 'User', { pinned: true });
    const rb = catalog.snapshots.rollbackSkill(snap.id, 'hardening-card', 'User');
    const safetyDir = path.join(tmpRoot, 'snapshots', rb.safetySnapshotId, 'catalog', 'skills');
    assert.deepEqual(fs.readdirSync(safetyDir).filter((n) => n.startsWith('.')), []);

    // H2: unlisted injected scripts/evil.cjs rejected in both rollbackSkill and full rollback
    fs.writeFileSync(path.join(tmpRoot, 'snapshots', snap.id, 'catalog', 'skills', 'hardening-card', 'scripts', 'evil.cjs'), 'evil\n');
    assert.throws(() => catalog.snapshots.rollbackSkill(snap.id, 'hardening-card', 'User'), /unexpected unlisted file/);
    assert.throws(() => catalog.snapshots.rollback(snap.id, 'User'), /unexpected unlisted file/);
    assert.equal(fs.existsSync(path.join(tmpRoot, 'catalog', 'skills', 'hardening-card', 'scripts', 'evil.cjs')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
