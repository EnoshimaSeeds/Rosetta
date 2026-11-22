#!/usr/bin/env node
'use strict';
/**
 * Underwater Architecture & Open-Source Readiness Auditor v0.2.0
 * Zero-dependency check for hardcoded local user/drive paths across code & docs,
 * oversized monoliths, unsafe Electron flags, and missing open-source hygiene files.
 */
const fs = require('node:fs');
const path = require('node:path');

const targetRoot = path.resolve(process.argv[2] || '.');
const issues = [];
let filesScanned = 0;

for (const reqFile of ['.gitignore']) {
  if (!fs.existsSync(path.join(targetRoot, reqFile))) {
    issues.push({ level: 'WARN', file: reqFile, msg: '缺少 .gitignore，可能导致构建产物或本地配置误入版本库。' });
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.gradle', 'snapshots', 'runtime', '.venv']);
const SCAN_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.java', '.cs', '.cpp', '.h', '.json', '.toml', '.md', '.cmd', '.vbs']);

const PERSONAL_PATH_RE = /([A-Za-z]:\\Users\\[^\\\s"'`]+\\|\/Users\/[A-Za-z0-9_.-]+\/|\/home\/[A-Za-z0-9_.-]+\/)/;

function walk(dir, relBase) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name === 'audit-log.jsonl') continue;
    const full = path.join(dir, entry.name);
    const rel = relBase ? relBase + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      walk(full, rel);
    } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name).toLowerCase())) {
      const stat = fs.statSync(full);
      if (stat.size > 1024 * 1024) continue;
      filesScanned++;
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      const isCode = !entry.name.endsWith('.json') && !entry.name.endsWith('.md');

      if (isCode && lines.length > 850) {
        issues.push({ level: 'WARN', file: rel, msg: `单文件达 ${lines.length} 行，建议按契约/服务/视图拆分模块。` });
      }

      // Skip self-regex line in auditor itself
      const isAuditorSelf = entry.name === 'audit_repo_readiness.cjs';

      lines.forEach((line, i) => {
        if (!isAuditorSelf && PERSONAL_PATH_RE.test(line)) {
          issues.push({ level: 'HIGH', file: `${rel}:${i + 1}`, msg: '发现硬编码本机专属路径，开源或跨机迁移时会暴露目录结构或报错。' });
        }
        if (isCode && new RegExp('nodeIntegration' + '\\s*:\\s*true').test(line)) {
          issues.push({ level: 'HIGH', file: `${rel}:${i + 1}`, msg: 'Electron 开启了 nodeIntegration=true，存在渲染层远程执行风险。' });
        }
        if (isCode && /catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
          issues.push({ level: 'INFO', file: `${rel}:${i + 1}`, msg: '存在未说明原因的空 catch 块。' });
        }
      });
    }
  }
}

walk(targetRoot, '');
console.log(JSON.stringify({ targetRoot, filesScanned, issueCount: issues.length, issues }, null, 2));
process.exit(issues.some((x) => x.level === 'HIGH') ? 1 : 0);
