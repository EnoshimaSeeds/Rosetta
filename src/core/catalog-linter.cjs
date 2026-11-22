'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONTROL_BYTE_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const INTERNAL_SYMBOL_PATTERNS = [
  { re: /\bDESKTOP_SESSION_SYMBOL\b/, label: 'DESKTOP_SESSION_SYMBOL' },
  { re: /\bplanStatus\b/, label: 'planStatus' }
];
const PRIVATE_PERSONA_PATTERNS = [
  { re: /(?:\b[A-Z]:\\Users\\|\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/)/, label: 'hardcoded-user-home-path' }
];
const INFORMAL_SLANG_TERMS = [
  '拔刀', '拍胸脯', '自嗨', '脑补', '嚼碎', '乱炖', '套娃', '叠甲',
  '意大利面条', '穿帮', '抢跑', '敷衍了事', '端上桌', '装酷', '审讯笔录',
  '糊成一团', '糊彩色', '俗气色块', '盲目抽卡', '干瘪', '填坑', '飘移',
  '反VibeCoding', '简明人话', '闷头狂翻', '虎头蛇尾', '偷懒', '手搓'
];
const EXEC_SCRIPT_EXTS = new Set(['.cjs', '.js', '.mjs', '.py', '.m', '.sh', '.ps1']);
const EXEMPTABLE_LINT_CODES = new Set([
  'ERR_PRIVATE_NAME_LEAK',
  'ERR_INFORMAL_SLANG',
  'WARN_THIN_SKILL'
]);

function parseLintExemptions(meta) {
  const raw = meta && meta.lintExemptions;
  if (!raw) return { rules: new Set(), reason: '' };
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.rules) ? raw.rules : []);
  const rules = new Set(list.filter((code) => EXEMPTABLE_LINT_CODES.has(code)));
  const reason = !Array.isArray(raw) && typeof raw.reason === 'string' ? raw.reason.trim() : '';
  return { rules, reason };
}

function hexToRgbNorm(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
}

function relativeLuminance(hex) {
  const rgb = hexToRgbNorm(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function computeContrastRatio(hexA, hexB) {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  if (l1 === null || l2 === null) return null;
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

function parseFrontmatter(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    fields[kv[1]] = val;
  }
  return fields;
}

function stripFrontmatterAndFlavor(md) {
  return String(md || '')
    .replace(/^---[\s\S]*?---\r?\n?/, '')
    .replace(/<!-- ROSETTA-FLAVOR-START -->[\s\S]*?<!-- ROSETTA-FLAVOR-END -->\r?\n?/, '')
    .trim();
}

function checkTextHygiene(findings, skillId, relFile, text, options = {}) {
  if (CONTROL_BYTE_RE.test(text)) {
    findings.push({ level: 'ERROR', code: 'ERR_CONTROL_BYTE', skillId, file: relFile, msg: '包含隐藏 ASCII 控制字符（可能导致渲染或解析损坏）。' });
  }
  for (const pat of INTERNAL_SYMBOL_PATTERNS) {
    if (pat.re.test(text)) {
      findings.push({ level: 'ERROR', code: 'ERR_INTERNAL_SYMBOL_LEAK', skillId, file: relFile, msg: `泄露内部实现符号 "${pat.label}"；安全与流程约束应写正向规范，不暴露内部变量名。` });
    }
  }
  if (!options.allowPrivateNames) {
    for (const pat of PRIVATE_PERSONA_PATTERNS) {
      if (pat.re.test(text)) {
        findings.push({ level: 'ERROR', code: 'ERR_PRIVATE_NAME_LEAK', skillId, file: relFile, msg: `包含本机私有路径或私人标识 "${pat.label}"，影响技能通用性与开源清洁度。` });
      }
    }
  }
  if (!options.skipSlang) {
    const hits = INFORMAL_SLANG_TERMS.filter((term) => text.includes(term));
    if (hits.length > 0) {
      findings.push({ level: 'ERROR', code: 'ERR_INFORMAL_SLANG', skillId, file: relFile, msg: `包含非标准口语或错别字：${hits.join('、')}。` });
    }
  }
  if (!options.skipMarkdownChecks) {
    const noCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, 'CODE');
    let badBold = false;
    for (const line of noCode.split(/\r?\n/)) {
      const parts = line.split('**');
      if (parts.length >= 3 && parts.length % 2 === 1) {
        for (let i = 1; i < parts.length; i += 2) {
          if (/^\s|\s$/.test(parts[i])) { badBold = true; break; }
        }
      }
      if (badBold) break;
    }
    if (badBold) {
      findings.push({ level: 'ERROR', code: 'ERR_MALFORMED_BOLD', skillId, file: relFile, msg: '检测到 Markdown 加粗语法星号内侧存在多余空格（** text **）。' });
    }
  }
}

function lintSkillDir(skillDir, skillId) {
  const findings = [];
  const metaPath = path.join(skillDir, 'rosetta.meta.json');
  const mdPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(metaPath)) {
    findings.push({ level: 'ERROR', code: 'ERR_MISSING_META', skillId, file: 'rosetta.meta.json', msg: '缺少 rosetta.meta.json。' });
    return findings;
  }
  if (!fs.existsSync(mdPath)) {
    findings.push({ level: 'ERROR', code: 'ERR_MISSING_SKILL_MD', skillId, file: 'SKILL.md', msg: '缺少 SKILL.md。' });
    return findings;
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const md = fs.readFileSync(mdPath, 'utf8');
  const fm = parseFrontmatter(md);
  const exemptions = parseLintExemptions(meta);

  if (!fm || fm.name !== skillId) {
    findings.push({ level: 'ERROR', code: 'ERR_META_MISMATCH', skillId, file: 'SKILL.md', msg: `Frontmatter name (${fm && fm.name}) 与技能目录 ID (${skillId}) 不一致。` });
  }
  if (!fm || fm.description !== meta.summary) {
    findings.push({ level: 'ERROR', code: 'ERR_META_MISMATCH', skillId, file: 'SKILL.md', msg: 'Frontmatter description 与 rosetta.meta.json 的 summary 不一致。' });
  }

  const docTextOpts = {
    allowPrivateNames: exemptions.rules.has('ERR_PRIVATE_NAME_LEAK'),
    skipSlang: exemptions.rules.has('ERR_INFORMAL_SLANG')
  };
  checkTextHygiene(findings, skillId, 'SKILL.md', md, docTextOpts);
  checkTextHygiene(findings, skillId, 'rosetta.meta.json(title/summary/tags)', [
    meta.title || '',
    meta.summary || '',
    ...(meta.tags || []),
    ...(meta.flavor || []).map((f) => `${f.label || ''} ${f.value || ''} ${f.hint || ''} ${(f.options || []).join(' ')}`)
  ].join('\n'), docTextOpts);
  checkTextHygiene(findings, skillId, 'rosetta.meta.json(annotation)', meta.annotation || '', { allowPrivateNames: true, skipMarkdownChecks: true, skipSlang: docTextOpts.skipSlang });

  const refsDir = path.join(skillDir, 'references');
  const scriptsDir = path.join(skillDir, 'scripts');
  const refs = fs.existsSync(refsDir) ? fs.readdirSync(refsDir).sort() : [];
  const scripts = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir).sort() : [];

  const allDocTexts = [md];

  for (const rf of refs) {
    const content = fs.readFileSync(path.join(refsDir, rf), 'utf8');
    allDocTexts.push(content);
    if (!md.includes(rf)) {
      findings.push({ level: 'ERROR', code: 'ERR_UNDOCUMENTED_SUBFILE', skillId, file: `references/${rf}`, msg: `参考文件 references/${rf} 未在 SKILL.md 中声明路由或引用。` });
    }
    checkTextHygiene(findings, skillId, `references/${rf}`, content, docTextOpts);
  }

  for (const sf of scripts) {
    const full = path.join(scriptsDir, sf);
    const content = fs.readFileSync(full, 'utf8');
    const ext = path.extname(sf).toLowerCase();
    if (!md.includes(sf)) {
      findings.push({ level: 'ERROR', code: 'ERR_UNDOCUMENTED_SUBFILE', skillId, file: `scripts/${sf}`, msg: `辅助脚本/资产 scripts/${sf} 未在 SKILL.md 中提及文件名及路径。` });
    }
    if (EXEC_SCRIPT_EXTS.has(ext) && !md.includes(`scripts/${sf}`)) {
      findings.push({ level: 'ERROR', code: 'ERR_MISSING_SCRIPT_PATH', skillId, file: `scripts/${sf}`, msg: `可执行脚本 scripts/${sf} 应在 SKILL.md 中写明完整相对路径 scripts/${sf} 与调用参数说明。` });
    }
    if (CONTROL_BYTE_RE.test(content)) {
      findings.push({ level: 'ERROR', code: 'ERR_CONTROL_BYTE', skillId, file: `scripts/${sf}`, msg: '脚本文件包含隐藏 ASCII 控制字符。' });
    }
    if (/^deck-tokens\..+\.json$/i.test(sf)) {
      try {
        const tok = JSON.parse(content);
        const bg = tok.color && tok.color.background;
        const recorded = tok.contrastOnBackground || tok.contrastVsBackground;
        if (bg && recorded) {
          for (const [key, val] of Object.entries(recorded)) {
            if (typeof val !== 'number') continue;
            const fg = tok.color[key];
            if (!fg) continue;
            const calc = computeContrastRatio(bg, fg);
            if (calc === null) continue;
            if (calc < 4.5) {
              findings.push({ level: 'ERROR', code: 'ERR_CONTRAST_BELOW_AA', skillId, file: `scripts/${sf}`, msg: `颜色 ${key} (${fg}) 在底色 ${bg} 上实算对比度 ${calc} < 4.5。` });
            }
            if (Math.abs(calc - val) > 0.06) {
              findings.push({ level: 'ERROR', code: 'ERR_CONTRAST_MISMATCH', skillId, file: `scripts/${sf}`, msg: `颜色 ${key} 记录对比度 ${val} 与 W3C 实算值 ${calc} 不一致。` });
            }
          }
        }
      } catch (err) {
        findings.push({ level: 'ERROR', code: 'ERR_INVALID_JSON', skillId, file: `scripts/${sf}`, msg: `JSON 解析失败：${err.message}` });
      }
    }
  }

  for (const m of md.matchAll(/(?<![a-zA-Z0-9_/-])(scripts|references)\/([a-zA-Z0-9._-]+\.[a-zA-Z0-9]+)/g)) {
    const subKind = m[1];
    const subName = m[2];
    const expectedPath = path.join(skillDir, subKind, subName);
    if (!fs.existsSync(expectedPath)) {
      findings.push({ level: 'ERROR', code: 'ERR_BROKEN_SUBFILE_REF', skillId, file: 'SKILL.md', msg: `SKILL.md 引用了 ${subKind}/${subName}，但磁盘目录中不存在该文件。` });
    }
  }

  const combinedDocs = allDocTexts.join('\n');
  if (meta.sourceUrl) {
    if (/Imbad0202\/academic-research-skills/i.test(meta.sourceUrl)) {
      findings.push({ level: 'ERROR', code: 'ERR_LICENSE_CONFLICT', skillId, file: 'rosetta.meta.json', msg: '上游非商业协议仓库不应作为 MIT 仓库自研技能卡的 sourceUrl。' });
    }
    if (!/(Apache-2\.0|MIT|BSD|GPL|CC\s*BY|非官方中文|参考|来源|出处)/i.test(combinedDocs)) {
      findings.push({ level: 'ERROR', code: 'ERR_MISSING_ATTRIBUTION', skillId, file: 'SKILL.md', msg: `已登记 sourceUrl (${meta.sourceUrl})，但正文/参考文件中缺少上游许可与整理性质声明。` });
    }
  }

  const body = stripFrontmatterAndFlavor(md);
  const bodyLines = body ? body.split(/\r?\n/).filter((l) => l.trim().length > 0).length : 0;
  if (bodyLines < 12 && refs.length === 0 && !exemptions.rules.has('WARN_THIN_SKILL')) {
    findings.push({ level: 'WARN', code: 'WARN_THIN_SKILL', skillId, file: 'SKILL.md', msg: `技能正文有效行数偏薄（仅 ${bodyLines} 行且无 references/），建议补充具体执行步骤、参数或自检标准。` });
  }

  return findings;
}

function lintCatalog(rosettaRoot) {
  const skillsDir = path.join(rosettaRoot, 'catalog', 'skills');
  if (!fs.existsSync(skillsDir)) {
    return { ok: false, skillsChecked: 0, errorCount: 1, warningCount: 0, findings: [{ level: 'ERROR', code: 'ERR_NO_SKILLS_DIR', skillId: '*', file: 'catalog/skills', msg: '未找到 catalog/skills 目录。' }] };
  }
  const ids = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const findings = [];
  const exemptedSkills = [];
  for (const id of ids) {
    const skillDir = path.join(skillsDir, id);
    const mp = path.join(skillDir, 'rosetta.meta.json');
    if (fs.existsSync(mp)) {
      try {
        const ex = parseLintExemptions(JSON.parse(fs.readFileSync(mp, 'utf8')));
        if (ex.rules.size > 0) {
          exemptedSkills.push({ skillId: id, rules: [...ex.rules], reason: ex.reason });
        }
      } catch (_e) { /* handled inside lintSkillDir */ }
    }
    findings.push(...lintSkillDir(skillDir, id));
  }
  const errorCount = findings.filter((f) => f.level === 'ERROR').length;
  const warningCount = findings.filter((f) => f.level === 'WARN').length;
  return {
    ok: errorCount === 0,
    skillsChecked: ids.length,
    errorCount,
    warningCount,
    exemptedSkills,
    findings
  };
}

module.exports = {
  lintCatalog,
  lintSkillDir,
  computeContrastRatio,
  EXEMPTABLE_LINT_CODES
};
