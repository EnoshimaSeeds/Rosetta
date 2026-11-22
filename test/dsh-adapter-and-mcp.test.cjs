'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const { CatalogService } = require('../src/core/catalog-service.cjs');
const { SyncEngine } = require('../src/core/sync-engine.cjs');
const { generateDshConfig, resolveDshSkillsDir } = require('../src/core/dsh-config-generator.cjs');
const { DESKTOP_SESSION_SYMBOL } = require('../src/core/lock-and-audit.cjs');
const { startLoopbackServer } = require('../src/desktop/launcher.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'rosetta-dsh-int-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sendRpcLines(rosettaRoot, env, requests) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(REPO_ROOT, 'src', 'mcp', 'server.cjs');
    const child = spawn(process.execPath, [serverPath], {
      env: Object.assign({}, process.env, { ROSETTA_ROOT: rosettaRoot }, env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      resolve({ code, lines, stderr });
    });
    for (const req of requests) {
      child.stdin.write(typeof req === 'string' ? req + '\n' : JSON.stringify(req) + '\n');
    }
    child.stdin.end();
  });
}

test('dsh-config-generator resolves DSH_HOME and emits valid Cordis YAML & plugin install command', () => {
  const prevDshHome = process.env.DSH_HOME;
  const fakeHome = path.join(os.tmpdir(), 'fake-dsh-home');
  process.env.DSH_HOME = fakeHome;
  try {
    assert.equal(resolveDshSkillsDir(REPO_ROOT), path.join(path.resolve(fakeHome), 'skills'));
    const cfg = generateDshConfig(REPO_ROOT);
    assert.ok(cfg.cordisPatchYaml.includes('@deepseek-ai/dsh-mcp-client'));
    assert.ok(cfg.cordisPatchYaml.includes('serverName: rosetta'));
    assert.ok(cfg.cordisPatchYaml.includes("ROSETTA_ACTOR: 'dsh'"));
    assert.equal(cfg.pluginInstallCommand, 'dsh plugin --profile web add @deepseek-ai/dsh-mcp-client');
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  }
});

test('SyncEngine syncs to DSH skills root, protects unmanaged dirs, and freezes drifted skills', () => {
  const tmp = makeTempDir();
  const dshSkills = path.join(tmp, 'dsh-skills');
  try {
    const catalog = new CatalogService(tmp);
    const syncEngine = new SyncEngine(catalog, { dshSkillsDir: dshSkills });

    catalog.saveSkill({
      id: 'alpha-skill',
      categoryId: 'industrial',
      title: 'Alpha Skill',
      summary: '测试同步技能 A',
      body: '# Alpha\n\nOriginal verified body.\n',
      assigned: { dsh: true }
    }, { actor: 'User', channel: 'desktop', desktopToken: DESKTOP_SESSION_SYMBOL });

    // Create a pre-existing unmanaged user skill with same name as beta-skill
    const unmanagedDir = path.join(dshSkills, 'beta-skill');
    fs.mkdirSync(unmanagedDir, { recursive: true });
    fs.writeFileSync(path.join(unmanagedDir, 'SKILL.md'), '# User Private Skill\n', 'utf8');

    // Create an unmanaged `<skillId>_mounted` directory that Rosetta does NOT own
    const unmanagedMountedDir = path.join(dshSkills, 'alpha-skill_mounted');
    fs.mkdirSync(unmanagedMountedDir, { recursive: true });
    fs.writeFileSync(path.join(unmanagedMountedDir, 'notes.txt'), 'Keep user files intact\n', 'utf8');

    catalog.saveSkill({
      id: 'beta-skill',
      categoryId: 'industrial',
      title: 'Beta Skill',
      summary: '测试同名碰撞保护',
      body: '# Beta\n\nShould not overwrite user unmanaged dir.\n',
      assigned: { dsh: true }
    }, { actor: 'User', channel: 'desktop', desktopToken: DESKTOP_SESSION_SYMBOL });

    const rep1 = syncEngine.syncAll({ actor: 'dsh', channel: 'cli' });
    assert.equal(rep1.results.dsh.synced, 1);
    assert.deepEqual(rep1.results.dsh.skippedCollisions, ['beta-skill']);
    assert.ok(fs.readFileSync(path.join(unmanagedDir, 'SKILL.md'), 'utf8').includes('User Private Skill'));
    assert.ok(fs.existsSync(path.join(unmanagedMountedDir, 'notes.txt')), 'Unmanaged _mounted directory must never be deleted');
    assert.ok(fs.readFileSync(path.join(dshSkills, 'alpha-skill', 'SKILL.md'), 'utf8').includes('Original verified body'));

    // Tamper alpha-skill on disk -> SyncEngine must block update and freeze previous clean copy
    fs.appendFileSync(path.join(tmp, 'catalog', 'skills', 'alpha-skill', 'SKILL.md'), '\nTampered!\n', 'utf8');
    const rep2 = syncEngine.syncAll({ actor: 'dsh', channel: 'cli' });
    assert.ok(rep2.warnings.some((w) => w.includes('[tamper-guard]')));
    const syncedContent = fs.readFileSync(path.join(dshSkills, 'alpha-skill', 'SKILL.md'), 'utf8');
    assert.ok(!syncedContent.includes('Tampered!'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP server enforces fail-closed ROSETTA_ACTOR and serves full JSON-RPC lifecycle for dsh', async () => {
  const serverPath = path.join(REPO_ROOT, 'src', 'mcp', 'server.cjs');
  const badRes = spawnSync(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, { ROSETTA_ACTOR: 'unknown_host' }),
    encoding: 'utf8'
  });
  assert.equal(badRes.status, 1);
  assert.ok(badRes.stderr.includes('Refusing to start'));

  const tmp = makeTempDir();
  try {
    // Copy clean catalog into isolated tmp root so tests never touch repo runtime
    fs.cpSync(path.join(REPO_ROOT, 'catalog'), path.join(tmp, 'catalog'), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(tmp, 'package.json'));

    const res = await sendRpcLines(tmp, { ROSETTA_ACTOR: 'dsh' }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rosetta_list', arguments: { onlyMounted: true, compact: true } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rosetta_inspect', arguments: { skillId: 'user-decisions' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rosetta_feedback', arguments: { action: 'record', kind: 'preference', domain: 'workflow', note: '偏好简洁回复' } } },
      { jsonrpc: '2.0', id: 6, method: 'prompts/list', params: {} },
      { jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} },
      { jsonrpc: '2.0', id: 8, method: 'unknown/method', params: {} },
      '{malformed-json'
    ]);

    assert.equal(res.code, 0);
    const byId = new Map(res.lines.filter((x) => x.id !== null).map((x) => [x.id, x]));

    assert.equal(byId.get(1).result.serverInfo.name, 'rosetta-dsh');
    assert.ok(byId.get(1).result.instructions.includes('DeepSeek Harness'));
    assert.equal(byId.get(2).result.tools.length, 10);

    const listPayload = JSON.parse(byId.get(3).result.content[0].text);
    assert.equal(listPayload.host, 'dsh');
    assert.equal(listPayload.skills.length, 15);

    const inspectPayload = JSON.parse(byId.get(4).result.content[0].text);
    assert.equal(inspectPayload.id, 'user-decisions');
    assert.equal(inspectPayload.mountedForCurrentHost, true);

    const fbPayload = JSON.parse(byId.get(5).result.content[0].text);
    assert.equal(fbPayload.recorded, true);

    assert.equal(byId.get(6).result.prompts.length, 15);
    assert.ok(byId.get(7).result.resources.length >= 15);
    assert.equal(byId.get(8).error.code, -32601);
    assert.ok(res.lines.some((x) => x.error && x.error.code === -32700));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('desktop loopback server enforces session token, host header, and returns getDshConfig', async () => {
  const tmp = makeTempDir();
  fs.cpSync(path.join(REPO_ROOT, 'catalog'), path.join(tmp, 'catalog'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(tmp, 'package.json'));

  const srv = await startLoopbackServer({
    rosettaRoot: tmp,
    keepAlive: true,
    persistState: false,
    syncOptions: { dshSkillsDir: path.join(tmp, 'dsh-skills') }
  });

  function postRpc(bodyObj, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(bodyObj);
      const req = http.request({
        hostname: '127.0.0.1',
        port: srv.port,
        path: '/__rosetta_rpc',
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers)
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  try {
    const unauth = await postRpc({ action: 'getDashboard' });
    assert.equal(unauth.status, 403);

    const dashRes = await postRpc({ action: 'getDashboard' }, { 'x-rosetta-token': srv.sessionToken });
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.body.ok, true);
    assert.equal(dashRes.body.data.skills.length, 15);

    const cfgRes = await postRpc({ action: 'getDshConfig' }, { 'x-rosetta-token': srv.sessionToken });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.body.ok, true);
    assert.ok(cfgRes.body.data.cordisPatchYaml.includes('serverName: rosetta'));
  } finally {
    await new Promise((r) => srv.server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
