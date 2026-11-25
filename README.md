# Rosetta

**A local-first shared skill library, preference governance tool, and MCP studio for AI assistants.**

[![License: All Rights Reserved](https://img.shields.io/badge/License-All%20Rights%20Reserved-lightgrey.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Runtime%20Dependencies-Zero-informational.svg)](./package.json)

[English](#overview) · [中文说明](#中文说明rosetta-v101) · [User Guide](./docs/USER_GUIDE.md) · [Changelog](./CHANGELOG.md)

---

## Overview

When working across multiple AI assistants (such as ChatGPT/Codex, Claude, Gemini, and DeepSeek), preferences, engineering guardrails, and domain workflows quickly drift apart. **Rosetta** turns reusable task instructions (`SKILL.md`), reference guides, helper scripts, and personal review rules into one **local, versioned, hash-verified skill library**—managed through a desktop UI, CLI, and standard **Model Context Protocol (MCP)** server.

### Public Release Scope (`v1.0.1`)

This public release (`v1.0.1` — see [`CHANGELOG.md`](./CHANGELOG.md)) publishes the **zero-dependency core engine**, the interactive **3-tier desktop studio**, the **local stdio MCP server**, **15 general-purpose skill packs**, the full **test and lint suite**, and the first public client adapter (**DeepSeek Harness / `dsh`**).

> **Roadmap (`v1.1`):** Multi-client sync adapters (Codex, Claude Desktop/CLI, and Gemini/Antigravity) are currently running in the author's private workspace and are being separated from personal configuration before merging into this public repository.

---

## Key Capabilities

- **Zero Runtime Dependencies:** Pure Node.js (`>= 20.0.0`) with no external `npm install` packages required to run the core engine, CLI, MCP server, or desktop studio.
- **3-Tier Orbital Desktop Studio:** Visual interface (`Start-Rosetta.cmd` / `bash start-rosetta.sh` / `npm start`) for browsing categories, inspecting skill triggers and notes, adjusting preset parameters, editing `SKILL.md` / scripts, and reviewing pending proposals.
- **Human-in-the-Loop Governance (`CHARTER.md`):**
  - **Full-Bundle SHA-256 Tamper-Guard:** Every skill's `SKILL.md`, `references/*`, and `scripts/*` are hashed against approved baselines. Unreviewed disk drift is automatically frozen until inspected in the desktop UI.
  - **Incremental Subfile Merge & File-Level Approval Diff:** Proposals merge `references/*` and `scripts/*` incrementally by default (untouched files are preserved). Deletions require explicit `removeReferences` / `removeScripts` lists, are forced through Desktop Diff approval, and display high-contrast red deletion badges alongside broken-reference warnings.
  - **Desktop-Only Approval Boundary:** AI agents cannot silently overwrite approved skills; agent changes enter a proposal queue (`rosetta_propose`) and require explicit user approval in the desktop studio (or a 5-minute single-use authorization code for non-destructive doc edits).
  - **Hash-Chained Audit Log & Whole/Per-Skill Atomic Snapshots:** Writes are recorded in a tamper-evident SHA-256 audit chain with verified atomic rollback—supporting both whole-catalog restore and single-skill rollback (`rollback <snap-id> --skill <skill-id>`).
- **Dual Integration Channels:** Exposes skills both via a local **stdio MCP server** (`node src/mcp/server.cjs`) and differential filesystem sync into native client skill directories (`~/.dsh/skills/`).
- **Automated Quality Linting (`npm run lint`):** Built-in linter checks skill schemas, bidirectional script/reference link integrity (including `./` paths), WCAG contrast ratios for design tokens, upstream attribution, and hygiene rules.

> **Security Boundary (Threat Model):** Rosetta's SHA-256 tamper-guard, hash-chained audit log, and strict snapshot manifest checks defend against accidental corruption, unreviewed AI writes, and unlisted file injection. They provide **tamper-evidence**, not OS-level sandboxing: any local process that already holds filesystem write access to your Rosetta workspace can directly modify `catalog/`, baselines, audit logs, or snapshot manifests (`manifest.json`) alike. Defending against compromised local processes requires OS account isolation and off-machine / read-only backups.

---

## Architecture

```text
rosetta/
├── bin/rosetta.cjs              # CLI entry point (status, sync, lint, audit, rollback, vault, dsh-config)
├── src/
│   ├── contracts/               # Input schemas, path boundaries, and whitelists
│   ├── core/                    # Catalog store, incremental bundle IO, SHA-256 tamper-guard, sync, locks, audit, linter, vault
│   ├── desktop/                 # Local desktop server, launcher, and browser/Electron shell
│   ├── mcp/                     # Local stdio MCP server for AI assistants
│   └── ui/                      # 3-tier orbital studio frontend (HTML/CSS/JS)
├── catalog/                     # Skill library metadata + 15 general-purpose skill bundles
├── docs/                        # Bilingual User Guide (USER_GUIDE.md + Rosetta-User-Guide-Bilingual.pdf)
├── dsh-setup/                   # Client setup helpers (DeepSeek Harness)
├── test/                        # Unit, security, MCP, incremental-merge, rollback, and integration tests
├── CHANGELOG.md                 # Release history and v1.0.1 fix summary
└── CHARTER.md                   # Governance principles and collaboration boundaries
```

---

## Quick Start

Requires **Node.js `>= 20.0.0`** (no `npm install` needed).

```bash
# 1. Launch the interactive desktop studio
npm start
# (Windows: double-click Start-Rosetta.cmd · macOS/Linux: bash start-rosetta.sh)

# 2. Run the full automated test suite
npm test

# 3. Run the catalog quality & hygiene linter
npm run lint

# 4. Run the repository readiness audit
node catalog/skills/underwater-arch-guard/scripts/audit_repo_readiness.cjs .

# 5. Inspect catalog status, verify SHA-256 audit chain, or roll back a single skill
node bin/rosetta.cjs status
node bin/rosetta.cjs audit
node bin/rosetta.cjs rollback <snapshot-id> --skill <skill-id>
```

### Connecting DeepSeek Harness (`dsh`)

```bash
node bin/rosetta.cjs dsh-config          # Print machine-specific MCP config snippet
node bin/rosetta.cjs sync --actor cli-local
```

For agent-assisted setup, point your DeepSeek Harness session at [`FOR-DEEPSEEK-HARNESS.md`](./FOR-DEEPSEEK-HARNESS.md).

---

## Included General-Purpose Skill Packs (15)

| Category | Skills |
| :--- | :--- |
| **Engineering & Architecture** | `underwater-arch-guard`, `mcp-server-checklist`, `modern-web-guidance`, `dsh-execution-discipline` |
| **Academic & Research** | `academic-course-and-paper`, `literature-vault-search`, `materials-char-analysis`, `sci-figure-craft` |
| **Documents & Presentations** | `office-craft-suite`, `presentation-deck-craft`, `natural-chinese-prose` |
| **Visual & Creative Pipelines** | `art-style-and-ui-craft`, `game-3d-live2d-pipeline` |
| **Workflow & Personal Governance** | `workflow-triage-and-review`, `user-decisions` |

---

## License & Attribution

- **License:** [All Rights Reserved](./LICENSE) (source-available for portfolio review and technical evaluation; prior written permission required for use, modification, or redistribution)
- **Author:** Siyuan (Alex) He (`HikawaRin`)
- **Development Approach:** Product requirements, governance charter (`CHARTER.md`), review gates, and acceptance testing directed by the author; implementation built iteratively with AI coding assistants and verified via automated tests and security audits.
- Upstream open-source references cited within individual skill packs (such as Google `modern-web-guidance` Apache-2.0 and Anthropic `skills` Apache-2.0) retain full attribution inside their respective skill files.

---

## 中文说明（Rosetta v1.0.1）

**零第三方运行时依赖的本地技能、偏好与 MCP 仓管系统（All Rights Reserved · Author: `HikawaRin (Siyuan He)`）。**

Rosetta 将日常协作中打磨出的专业规范、可执行校验脚本与个人审美红线沉淀为本地可审计资产，并通过 **MCP 工具协议** 与 **原生技能目录同步** 双通道接入 AI 助手（本公版首发完整核心引擎、桌面星盘仓管界面、15 张通用技能卡及 DeepSeek Harness 适配器；ChatGPT/Codex、Claude Desktop/CLI 与 Gemini/Antigravity 同步适配器将于 `v1.1` 陆续合入公版）。

> **本地安全边界**：Rosetta 的全包 SHA-256 篡改检测、哈希链审计日志与严格快照清单校验，用于防范意外损坏、未经审阅的 AI 写入以及快照清单外文件注入，属于**可发现篡改**机制而非操作系统级沙箱；若本机已有程序获得 Rosetta 工作目录的写权限，它同样可以直接改写技能库、基线或快照 `manifest.json`。抵御本机权限失陷需配合系统账户隔离与离线/只读备份。

### 随包附带文档
1. **中英双语正式用户手册**：[`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md)（网页直读）与 [`docs/Rosetta-User-Guide-Bilingual.pdf`](./docs/Rosetta-User-Guide-Bilingual.pdf)（可打印版）—— 介绍 Rosetta 的多助手协作目标、三项设计边界、双层结构、安全治理与 15 张通用技能卡导览。
2. **版本更新说明**：[`CHANGELOG.md`](./CHANGELOG.md) —— 完整记录 `v1.0.1` 的核心工程修复与文档修订。
3. **DeepSeek Harness 自动接入指南**：[`FOR-DEEPSEEK-HARNESS.md`](./FOR-DEEPSEEK-HARNESS.md) —— 可直接交给 DeepSeek Harness 按步自动生成 `cordis.patch.yml`、同步 `~/.dsh/skills/` 并完成端到端验收。

### 常用命令
```bash
npm start                                                         # 启动三级星盘桌面仓管界面（Windows 双击 Start-Rosetta.cmd，macOS/Linux 运行 bash start-rosetta.sh）
npm test                                                          # 运行全部单元、安全、增量合并、单卡回滚与 MCP 集成测试
npm run lint                                                      # 技能编录质量、断链检查、WCAG 对比度与清洁度门禁
node bin/rosetta.cjs dsh-config                                   # 生成当前机器专属的 DeepSeek Harness 接入配置
node bin/rosetta.cjs sync --actor cli-local                       # 差异化同步已挂载技能
node bin/rosetta.cjs rollback <snap-id> --skill <skill-id>        # 按单卡精准无损回滚（不影响其余技能与开关）
node bin/rosetta.cjs audit                                        # 核验 SHA-256 审计日志哈希链
node bin/rosetta.cjs vault verify                                 # 核验交付件索引新鲜度
```
