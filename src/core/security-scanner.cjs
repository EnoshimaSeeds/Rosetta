'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Advisory Static Heuristic & Capability Pre-Filter for Rosetta Skills & Scripts.
 * Hard boundaries remain:
 *   1. Mandatory Desktop Diff approval when executable scripts or capability warnings exist;
 *   2. Full-bundle SHA-256 `contentHash` enforced by `SyncEngine` tamper-guard.
 */
const TRUSTED_API_HOSTS = new Set([
  'eutils.ncbi.nlm.nih.gov',
  'api.openalex.org',
  'export.arxiv.org',
  'www.ebi.ac.uk',
  'api.biorxiv.org',
  'api.crossref.org'
]);

const TEXT_RULES = [
  {
    ruleId: 'PROMPT_INJECTION_OVERRIDE',
    severity: 'CRITICAL',
    pattern: /\b(ignore\s+(all\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)|disregard\s+(all\s+)?(previous|prior|system)\s+(instructions?|rules?)|you\s+are\s+now\s+in\s+developer\s+mode|bypass\s+(the\s+)?(sandbox|security|approval|permission)|do\s+not\s+ask\s+(the\s+)?user\s+for\s+(permission|approval|confirmation)\s+when\s+deleting)\b/i,
    message: '检测到疑似覆盖系统规则的提示词注入指令（Instruction Override）。'
  },
  {
    ruleId: 'PROMPT_INJECTION_CN',
    severity: 'CRITICAL',
    pattern: /(忽略(之前|以上|所有|系统)(的)?(所有)?(指令|规则|安全限制|设定)|无视(所有)?安全(规则|边界|确认)|不要(向用户|跟用户)?(确认|汇报|告知)直接静默(删除|发送|上传|执行)|把(密钥|密码|token|key|\.env)[^。\n]{0,20}(发送到|贴进|写入|附在))/i,
    message: '检测到中文恶意指令覆盖、诱导静默越权或窃取环境变量载荷。'
  },
  {
    ruleId: 'HTML_COMMENT_COMMAND',
    severity: 'CRITICAL',
    pattern: /<!--[\s\S]{0,600}?\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|rm\s+-rf|Remove-Item|taskkill|reg\s+add|schtasks|powershell|cmd\.exe)\b[\s\S]{0,600}?-->/i,
    message: '检测到 HTML 注释中隐藏终端执行指令。'
  },
  {
    ruleId: 'OBFUSCATED_EXECUTION',
    severity: 'CRITICAL',
    pattern: /(\bpowershell(?:\.exe)?\b[^\n]*\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|FromBase64String\s*\(|base64\s+-d\s*\|\s*(?:sh|bash|pwsh|python|node)|\beval\s*\(|\bnew\s+Function\s*\()/i,
    message: '检测到 Base64 混淆命令或动态代码执行（eval / new Function）。'
  },
  {
    ruleId: 'STRING_CONCAT_OBFUSCATION',
    severity: 'WARN',
    codeOnly: true,
    pattern: /(['"`]ht['"`]\s*\+\s*['"`]tps?|['"`]\/?\.dsh['"`]\s*\+\s*['"`]\/|['"`]ch['"`]\s*\+\s*['"`]ild_process|\bString\.fromCharCode\s*\(|\bBuffer\.from\s*\([^)]+,\s*['"`]base64['"`]\s*\))/i,
    message: '能力提醒：脚本包含字符串拼接或编码转换构造，须经人工审阅源码 Diff。'
  },
  {
    ruleId: 'REMOTE_PIPE_EXEC',
    severity: 'CRITICAL',
    pattern: /(\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python|node)\b|\b(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n|]*\|\s*(?:iex|Invoke-Expression)\b)/i,
    message: '检测到远程脚本直连管道执行（curl|bash 或 irm|iex）。'
  },
  {
    ruleId: 'CREDENTIAL_FILE_ACCESS',
    severity: 'CRITICAL',
    pattern: /(\.(?:ssh|aws|gnupg)[\\/]|id_rsa|id_ed25519|\.credentials\.(?:json|yaml)|auth\.json|Login\s+Data|Cookies\.sqlite|cmdkey\s+\/list|Unprotect\s*\()/i,
    message: '检测到尝试读取本机私钥、凭据库或浏览器隐私数据。'
  },
  {
    ruleId: 'API_KEY_HARVESTING',
    severity: 'HIGH',
    codeOnly: true,
    pattern: /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|DEEPSEEK_API_KEY|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY)\b/,
    message: '脚本中检测到读取敏感 API 密钥环境变量。'
  },
  {
    ruleId: 'CAPABILITY_SUBPROCESS',
    severity: 'WARN',
    codeOnly: true,
    pattern: /(\bchild_process\b|\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(|\bsubprocess\.(?:Popen|run|call)\b|\bos\.system\s*\()/,
    message: '能力提醒：脚本具备拉起外部子进程能力（child_process / subprocess），需人工审阅源码。'
  },
  {
    ruleId: 'CAPABILITY_FILE_DELETE',
    severity: 'WARN',
    codeOnly: true,
    pattern: /(\b(?:rmSync|rmdirSync|unlinkSync|unlink|rm)\s*\(|\bshutil\.rmtree\b|\bdel\s+\/[qfs]\b|\brm\s+-rf\b)/,
    message: '能力提醒：脚本包含文件删除操作，需人工确认路径边界。'
  },
  {
    ruleId: 'CAPABILITY_DYNAMIC_NET',
    severity: 'WARN',
    codeOnly: true,
    pattern: /(\bfetch\s*\(\s*[^'"`\s)]|\bhttp\.request\s*\(|\bhttps\.request\s*\(|\bnet\.connect\s*\()/,
    message: '能力提醒：脚本包含动态计算地址的网络请求，需人工确认不存在数据外传。'
  },
  {
    ruleId: 'EXFILTRATION_SINK',
    severity: 'CRITICAL',
    pattern: /\b(webhook\.site|requestbin\.com|pipedream\.net|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|oastify\.com|burpcollaborator\.net)\b/i,
    message: '检测到已知数据外传接收端（Webhook / 回显域名）。'
  }
];

function findHiddenUnicode(line) {
  for (let i = 0; i < line.length; i++) {
    const code = line.codePointAt(i);
    if (
      (code >= 0x200B && code <= 0x200F) ||
      (code >= 0x202A && code <= 0x202E) ||
      (code >= 0x2060 && code <= 0x2069) ||
      (code >= 0xE0000 && code <= 0xE007F) ||
      (code === 0xFEFF && i > 0)
    ) {
      return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    }
    if (code > 0xFFFF) i++;
  }
  return null;
}

function isExecutableFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ['.js', '.cjs', '.mjs', '.ts', '.py', '.ps1', '.sh', '.cmd', '.bat', '.vbs'].includes(ext);
}

function scanTextContent(content, fileName = 'SKILL.md') {
  const findings = [];
  const text = String(content || '');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const isCode = isExecutableFileName(fileName);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const lineNo = idx + 1;

    const hiddenCode = findHiddenUnicode(line);
    if (hiddenCode) {
      findings.push({
        severity: 'CRITICAL',
        ruleId: 'HIDDEN_UNICODE_PAYLOAD',
        file: fileName,
        line: lineNo,
        snippet: line.slice(0, 100),
        message: `检测到不可见零宽/双向控制字符 (${hiddenCode})。`
      });
    }

    for (const rule of TEXT_RULES) {
      if (rule.codeOnly && !isCode) continue;
      if (rule.pattern.test(line)) {
        findings.push({
          severity: rule.severity,
          ruleId: rule.ruleId,
          file: fileName,
          line: lineNo,
          snippet: line.trim().slice(0, 120),
          message: rule.message
        });
      }
    }

    if (isCode) {
      const urlMatches = line.match(/https?:\/\/([a-zA-Z0-9.-]+)(?::\d+)?(\/[^\s"'`)]*)?/g) || [];
      for (const rawUrl of urlMatches) {
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
            findings.push({
              severity: 'HIGH',
              ruleId: 'INSECURE_HTTP_IN_SCRIPT',
              file: fileName,
              line: lineNo,
              snippet: rawUrl.slice(0, 100),
              message: `脚本中包含非加密明文 HTTP 外连 (${parsed.hostname})。`
            });
          } else if (!TRUSTED_API_HOSTS.has(parsed.hostname) && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
            findings.push({
              severity: 'WARN',
              ruleId: 'UNVERIFIED_EXTERNAL_HOST',
              file: fileName,
              line: lineNo,
              snippet: rawUrl.slice(0, 100),
              message: `脚本访问未预登记的外部主机 (${parsed.hostname})，需人工核查用途。`
            });
          }
        } catch (_badUrl) { /* ignore malformed URL literal */ }
      }
    }
  }

  const htmlCmdMatch = text.match(/<!--[\s\S]{0,600}?\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|rm\s+-rf|Remove-Item|taskkill|powershell|cmd\.exe)\b[\s\S]{0,600}?-->/i);
  if (htmlCmdMatch && !findings.some((f) => f.ruleId === 'HTML_COMMENT_COMMAND')) {
    findings.push({
      severity: 'CRITICAL',
      ruleId: 'HTML_COMMENT_COMMAND',
      file: fileName,
      line: 1,
      snippet: htmlCmdMatch[0].replace(/\s+/g, ' ').slice(0, 120),
      message: '检测到跨行 HTML 注释中隐藏终端执行指令。'
    });
  }

  if (path.basename(fileName).toLowerCase() === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      const scripts = pkg.scripts || {};
      for (const hook of ['preinstall', 'install', 'postinstall', 'preuninstall', 'postuninstall']) {
        if (scripts[hook]) {
          findings.push({
            severity: 'CRITICAL',
            ruleId: 'SUPPLY_CHAIN_HOOK',
            file: fileName,
            line: 1,
            snippet: `${hook}: ${String(scripts[hook]).slice(0, 80)}`,
            message: `package.json 含有自动执行生命周期钩子 (${hook})。`
          });
        }
      }
    } catch (_badJson) { /* ignore invalid JSON during heuristic scan */ }
  }

  return findings;
}

function summarizeScan(findings, scannedFiles = 1, hasExecutableScripts = false) {
  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length;
  const highCount = findings.filter((f) => f.severity === 'HIGH').length;
  const warnCount = findings.filter((f) => f.severity === 'WARN').length;

  let verdict = 'CLEAN';
  if (criticalCount > 0 || highCount > 0) verdict = 'BLOCKED';
  else if (warnCount > 0) verdict = 'WARN';

  const penalty = criticalCount * 50 + highCount * 30 + warnCount * 10;
  const score = Math.max(0, 100 - penalty);

  return {
    scannerKind: 'static-heuristic-advisory',
    passed: verdict !== 'BLOCKED',
    verdict,
    score,
    scannedFiles,
    hasExecutableScripts: Boolean(hasExecutableScripts),
    requiresManualApproval: verdict !== 'CLEAN' || Boolean(hasExecutableScripts),
    counts: { critical: criticalCount, high: highCount, warn: warnCount },
    scannedAt: new Date().toISOString(),
    findings
  };
}

function redactFindingsSnippets(scanResult) {
  if (!scanResult || !Array.isArray(scanResult.findings)) return scanResult;
  return Object.assign({}, scanResult, {
    findings: scanResult.findings.map((f) => Object.assign({}, f, {
      snippet: '[REDACTED]'
    }))
  });
}

function isRootDrivePath(p) {
  const resolved = path.resolve(p);
  return path.dirname(resolved) === resolved;
}

function scanDirectory(dirPath, opts = {}) {
  const maxDepth = opts.maxDepth ?? 5;
  const maxFiles = opts.maxFiles ?? 200;
  const resolved = path.resolve(dirPath);

  if (isRootDrivePath(resolved)) {
    throw new Error('ERR_SCAN_ROOT_FORBIDDEN: Refusing to scan filesystem root directory.');
  }

  const allFindings = [];
  let scannedFiles = 0;
  let hasScripts = false;

  function walk(current, relPrefix, depth) {
    if (depth > maxDepth || scannedFiles >= maxFiles) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (scannedFiles >= maxFiles) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'snapshots' || entry.name === 'runtime' || entry.name === 'rosetta.meta.json') continue;
      const full = path.join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel, depth + 1);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        scannedFiles++;
        if (isExecutableFileName(rel)) hasScripts = true;
        allFindings.push(...scanTextContent(buf.toString('utf8'), rel));
      }
    }
  }

  if (fs.existsSync(resolved)) {
    walk(resolved, '', 0);
  }

  return summarizeScan(allFindings, scannedFiles, hasScripts);
}

function scanSkillBundle({ markdown, extraFiles = {} }) {
  const findings = scanTextContent(markdown, 'SKILL.md');
  let count = 1;
  let hasScripts = false;
  for (const [name, content] of Object.entries(extraFiles || {})) {
    count++;
    if (isExecutableFileName(name)) hasScripts = true;
    findings.push(...scanTextContent(content, name));
  }
  return summarizeScan(findings, count, hasScripts);
}

module.exports = {
  TRUSTED_API_HOSTS,
  isExecutableFileName,
  scanTextContent,
  scanDirectory,
  scanSkillBundle,
  summarizeScan,
  redactFindingsSnippets
};
