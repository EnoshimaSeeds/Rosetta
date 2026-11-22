'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readLocalOverrides(rosettaRoot) {
  const localCfgPath = path.join(path.resolve(rosettaRoot), 'rosetta.local.json');
  if (!fs.existsSync(localCfgPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(localCfgPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_ignored) {
    return {};
  }
}

/**
 * Resolves the DeepSeek Harness global skills directory following DSH discovery order:
 *   1. Explicit option `dshSkillsDir`
 *   2. `ROSETTA_DSH_SKILLS_DIR` env var
 *   3. `rosetta.local.json` -> `dshSkillsDir`
 *   4. `$DSH_HOME/skills`
 *   5. `~/.dsh/skills` (default DeepSeek Harness global skills root)
 */
function resolveDshSkillsDir(rosettaRoot, options = {}) {
  if (options.dshSkillsDir) {
    return path.resolve(options.dshSkillsDir);
  }
  if (process.env.ROSETTA_DSH_SKILLS_DIR) {
    return path.resolve(process.env.ROSETTA_DSH_SKILLS_DIR);
  }
  const localCfg = readLocalOverrides(rosettaRoot);
  if (localCfg.dshSkillsDir) {
    return path.resolve(rosettaRoot, localCfg.dshSkillsDir);
  }
  if (process.env.DSH_HOME) {
    return path.join(path.resolve(process.env.DSH_HOME), 'skills');
  }
  const home = options.homeDir || os.homedir();
  return path.join(home, '.dsh', 'skills');
}

function resolveDshHomeDir(options = {}) {
  if (process.env.DSH_HOME) {
    return path.resolve(process.env.DSH_HOME);
  }
  const home = options.homeDir || os.homedir();
  return path.join(home, '.dsh');
}

function resolveNodeExecutable(options = {}) {
  if (options.nodePath) return options.nodePath;
  if (process.env.ROSETTA_NODE_BIN) return process.env.ROSETTA_NODE_BIN;
  const curBase = path.basename(process.execPath || '').toLowerCase();
  if (!process.versions.electron && (curBase === 'node' || curBase === 'node.exe')) {
    return process.execPath;
  }
  return 'node';
}

function yamlSingleQuote(val) {
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Generates ready-to-paste DeepSeek Harness (`dsh`) MCP & Skills config snippets
 * using the real resolved paths on the current machine.
 */
function generateDshConfig(rosettaRoot, options = {}) {
  const root = path.resolve(rosettaRoot);
  const serverScript = path.join(root, 'src', 'mcp', 'server.cjs');
  const nodeBin = resolveNodeExecutable(options);
  const dshHome = resolveDshHomeDir(options);
  const dshSkillsDir = resolveDshSkillsDir(root, options);
  const cordisPatchPath = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');

  const cordisPatchYaml = [
    '- insert:',
    '    - id: mcp-rosetta',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: rosetta',
    '        transport: stdio',
    `        command: ${yamlSingleQuote(nodeBin)}`,
    '        args:',
    `          - ${yamlSingleQuote(serverScript)}`,
    '        env:',
    "          ROSETTA_ACTOR: 'dsh'",
    `          ROSETTA_ROOT: ${yamlSingleQuote(root)}`
  ].join('\n');

  return {
    rosettaRoot: root,
    nodeCommand: nodeBin,
    mcpServerScript: serverScript,
    dshHome,
    dshSkillsDir,
    suggestedCordisPatchPath: cordisPatchPath,
    fallbackGlobalCordisPatchPath: path.join(dshHome, 'cordis.patch.yml'),
    toolNamePrefix: 'mcp__rosetta__',
    pluginInstallCommand: 'dsh plugin --profile web add @deepseek-ai/dsh-mcp-client',
    cordisPatchYaml,
    verifyCommands: [
      'dsh --profile web --dump-config',
      `node "${path.join(root, 'bin', 'rosetta.cjs')}" sync --actor dsh`,
      `node "${path.join(root, 'bin', 'rosetta.cjs')}" status`
    ]
  };
}

module.exports = {
  readLocalOverrides,
  resolveDshSkillsDir,
  resolveDshHomeDir,
  resolveNodeExecutable,
  generateDshConfig
};
