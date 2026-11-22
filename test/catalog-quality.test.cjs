'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lintCatalog } = require('../src/core/catalog-linter.cjs');
const { CatalogService } = require('../src/core/catalog-service.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

test('bundled catalog passes rosetta lint with zero errors and zero warnings', () => {
  const rep = lintCatalog(REPO_ROOT);
  assert.equal(rep.ok, true, JSON.stringify(rep.findings, null, 2));
  assert.equal(rep.skillsChecked, 15);
  assert.equal(rep.errorCount, 0);
  assert.equal(rep.warningCount, 0);
});

test('all 15 bundled skills have clean stamped hashes, zero drift, and pass security scan', () => {
  const catalog = new CatalogService(REPO_ROOT);
  const { items, brokenSkills } = catalog.listSkillsWithDiagnostics();
  assert.equal(brokenSkills.length, 0);
  assert.equal(items.length, 15);
  for (const s of items) {
    assert.equal(s.diskDrifted, false, `Skill ${s.id} has disk drift`);
    assert.equal(s.security.passed, true, `Skill ${s.id} failed security scan`);
    assert.equal(s.assigned.dsh, true, `Skill ${s.id} should be mounted to dsh by default`);
  }
});

test('repository passes underwater-arch-guard open-source readiness audit with zero HIGH/WARN issues', () => {
  const auditScript = path.join(REPO_ROOT, 'catalog', 'skills', 'underwater-arch-guard', 'scripts', 'audit_repo_readiness.cjs');
  const res = spawnSync(process.execPath, [auditScript, REPO_ROOT], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.issueCount, 0, JSON.stringify(parsed.issues, null, 2));
});

test('open-source repository contains zero hardcoded personal home directories or secrets', () => {
  const forbidden = /([A-Za-z]:\\Users\\[^\\\s"'`]+\\|\/Users\/[A-Za-z0-9_.-]+\/|\/home\/[A-Za-z0-9_.-]+\/|sk-[A-Za-z0-9]{20,})/g;
  const hits = [];
  function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['runtime', 'snapshots', '.git', 'node_modules', 'docs'].includes(e.name)) continue;
      if (rel === 'test' && e.name === 'catalog-quality.test.cjs') continue;
      if (rel === 'catalog/skills/underwater-arch-guard/scripts' && e.name === 'audit_repo_readiness.cjs') continue;
      if (rel === 'src/core' && e.name === 'catalog-linter.cjs') continue;
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (['.pdf', '.png', '.jpg', '.zip'].includes(ext)) continue;
        const txt = fs.readFileSync(full, 'utf8');
        if (forbidden.test(txt)) {
          forbidden.lastIndex = 0;
          hits.push(r);
        }
      }
    }
  }
  walk(REPO_ROOT, '');
  assert.deepEqual(hits, [], `Unexpected hardcoded paths/secrets found in: ${hits.join(', ')}`);
});
