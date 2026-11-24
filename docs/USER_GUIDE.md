# Rosetta User Guide · 用户手册（中英双语版）

> **Version / 版本**：`v1.0.1` · **Author / 作者**：`HikawaRin (Siyuan He)`  
> **License / 许可**：All Rights Reserved（仅授权展示、技术评估与招聘阅览；未经许可不得二次分发或商用）  
> **Runtime / 运行环境**：Node.js `>= 20.0.0`（零第三方运行时依赖 / Zero runtime dependencies）  
> **Printable PDF / 可打印版**：[`Rosetta-User-Guide-Bilingual.pdf`](./Rosetta-User-Guide-Bilingual.pdf)

---

## 1. Why Rosetta Exists · 为什么需要 Rosetta

**中文**  
经常与多个 AI 助手（如 DeepSeek Harness、ChatGPT / Codex、Claude、Gemini）协作写代码、改论文、制作演示稿或设计视觉内容的人，往往会遇到同一个瓶颈：上周在长对话里好不容易磨合好的分层规范、中文表达节奏、文献核验底线与排版偏好，一换新会话或换一个客户端就彻底归零。

问题不在模型不够聪明，而在于**协作经验缺少一个本地化、结构化且受控的沉淀位置**。Rosetta（罗塞塔）是一座完全运行在本地的技能（`SKILL.md`）、参考蓝图（`references/`）、确定性校验脚本（`scripts/`）与个人偏好仓管系统，通过标准 **MCP（Model Context Protocol）** 与**原生技能目录差异同步**双通道接入 AI 助手，让“行业硬标准”与“个人审美取舍”跨会话长期留存。

**English**  
Working across multiple AI assistants—such as DeepSeek Harness, ChatGPT / Codex, Claude, and Gemini—leads to constant preference drift. Architectural guardrails, citation rules, prose rhythm, and visual standards carefully tuned in one session vanish as soon as you open a new thread or switch tools.

**Rosetta** solves this by turning reusable task instructions (`SKILL.md`), progressive reference guides (`references/`), deterministic verification scripts (`scripts/`), and personal redlines into one **local, versioned, hash-verified studio**. It connects to AI clients via a standard local **stdio MCP server** and differential native skill-directory sync—keeping both engineering baselines and personal taste durable across sessions.

> **Client Scope / 适配范围**：`v1.0.x` 公版首发完整核心引擎、三级星盘桌面端、15 张通用技能卡与 **DeepSeek Harness (`dsh`)** 适配器；面向 **ChatGPT / Codex**、**Claude Desktop / CLI** 与 **Gemini / Antigravity** 的多端同步适配器计划于 `v1.1` 合入公版。

---

## 2. Three Design Boundaries · 三项设计边界

| Boundary / 边界 | 中文说明 | English Summary |
| :--- | :--- | :--- |
| **1. Overlay, Never Replace**<br>辅助叠加，绝不替代 | Rosetta 不替代宿主客户端原生的插件体系、终端工具或用户已有技能，只在原生能力之上叠加可复用的专业规范与个人偏好。 | Enhances native client tools and user skills without replacing or blocking them. |
| **2. Immediate Intent First**<br>当下优先，事后回修 | 任何历史卡片只是默认基线。当旧规则与用户当下的明确指令冲突时，一律以用户当下的指令为准，事后再经提案把卡片改准。 | Explicit user instructions always override stored cards; update cards afterward via proposal. |
| **3. Progressive Disclosure**<br>按需加载，轻量无感 | 日常问答保持安静不占上下文；仅保留极简索引，任务命中领域后再读取正文、子蓝图或调用随附校验脚本。 | Keeps context lean with compact indexes; loads full `SKILL.md` and `references/` only on demand. |

---

## 3. Two-Tier Architecture & Silent Feedback Flywheel · 双层结构与无感反馈闭环

1. **Tier 1 — General Standards Layer / 通用规范层（14 张领域技能卡 + 确定性脚本）**  
   覆盖软件架构体检、MCP 开发自检、现代 Web、学术写作与 LaTeX 引文检查、Crossref/OpenAlex 文献验真、材料实验数据分析、科研绘图、办公文档、演示架构、视觉美学与中文自然表达。关键设计是**把确定性校验交给零依赖本地脚本实算**，而非依赖模型口头估算。
2. **Tier 2 — Personal Calibration Layer / 个人校准层（`user-decisions` + `rosetta_feedback`）**  
   无需手工维护冗长提示词文档。用户在审阅真实产出时随口点评（好/坏/红线/偏好），AI 助手在后台静默调用 `rosetta_feedback` 入队；当遇到明确红线或同类反馈在跨场景中累计达阈值（`≥ 2` 条）时，由助手自动提炼为待审提案（`rosetta_propose`），经用户在桌面端审阅差异后一键批准生效。

---

## 4. Six Human-in-the-Loop Safety Guardrails · 六道人在回路安全防线

1. **Static Heuristic Pre-Scan / 静态启发式预检**：入库与导入前扫描提示词覆盖、隐藏控制字符、凭据读取与异常外连，高危内容直接拦截。
2. **Full-Bundle SHA-256 Tamper-Guard / 全包哈希防篡改锁**：对 `SKILL.md`、`references/*` 与 `scripts/*` 计算整包哈希；磁盘发生未审阅改动时自动冻结同步并保留上一版干净副本，直至在桌面端裁决「采纳」或「单卡还原」。
3. **Default Incremental Subfile Merge / 双目录默认增量合并（v1.0.1）**：更新技能时 `references/` 与 `scripts/` 默认保留未提及的既有子文件，彻底杜绝局部提案静默覆盖丢失文件；删除必须通过 `removeReferences` / `removeScripts` 显式点名。
4. **Desktop-Only Approval & Red Deletion Diff / 桌面审批主权与文件级差异**：AI 代理仅拥有草稿权；待审弹窗在正文 Diff 顶部直观列出 `+ 新增`、`~ 修改` 与**红色 `- 删除`** 文件清单，并实时标注 `SKILL.md` 指向缺失文件的引用断链警告。
5. **5-Minute Single-Use Grant with Hard Exceptions / 5 分钟单次授权码**：桌面端可按需签发 `RSTA-XXXX-XXXX` 授权码以放行纯文档微调；但凡包含**可执行脚本**或**显式子文件删除**，系统仍强制转入桌面 Diff 审批。
6. **SHA-256 Audit Chain & Whole / Per-Skill Rollback / 哈希链审计与整库/单卡原子回滚**：全部写操作追加写入带哈希链校验的 `catalog/audit-log.jsonl`；每次变更前自动留存原子快照，支持整库回滚与**按 `skillId` 单卡精准回滚**（不影响其他并发修改过的技能与开关）。

---

## 5. Starter Catalog Overview · 预装 15 张通用技能速查

| Sector / 板块 | Skill ID | Scope / 适用场景 | Bundled Assets / 随附蓝图与脚本 |
| :--- | :--- | :--- | :--- |
| `SEC-01` Aesthetics | `natural-chinese-prose` | 中文汇报、演示与叙事文案去人机味 | Core rules |
| `SEC-01` Aesthetics | `art-style-and-ui-craft` | 生图风格与线稿、服装剪裁、UI 线条与短片前期 | 4 `references/` blueprints |
| `SEC-01` Aesthetics | `presentation-deck-craft` | 学术答辩、路演与设定集演示架构 | 2 blueprints + 4 WCAG token JSONs |
| `SEC-02` Academic | `academic-course-and-paper` | 课程精讲、规范英文学术写作与 LaTeX 工程 | `scripts/check_tex_citations.cjs` |
| `SEC-02` Academic | `literature-vault-search` | 学术文献检索与 Crossref/OpenAlex 实名验真 | `scripts/verify_or_search_lit.cjs` + MCP |
| `SEC-02` Academic | `office-craft-suite` | Word / Excel / PDF / PPT 工程路由与六套皮肤 | 4 `references/` blueprints |
| `SEC-02` Academic | `sci-figure-craft` | 印刷尺寸、色盲安全科研数据图 | Matplotlib / MATLAB style assets |
| `SEC-02` Academic | `materials-char-analysis` | 拉伸曲线、DSC/TGA、FTIR/XRD 与溶胀分析 | `scripts/tensile_metrics.cjs` |
| `SEC-03` Industrial | `underwater-arch-guard` | 多文件工程架构分层、安全隔离与发布合规体检 | `scripts/audit_repo_readiness.cjs` |
| `SEC-03` Industrial | `mcp-server-checklist` | 本地 stdio MCP 服务五维设计审查清单 | Core checklist |
| `SEC-03` Industrial | `modern-web-guidance` | 现代原生 HTML / CSS / TS / Baseline 规范（Apache-2.0） | 1 pitfall reference |
| `SEC-03` Industrial | `game-3d-live2d-pipeline` | UE5 分层、3D 资产入引擎质检、Live2D 与动效 | Core pipeline guide |
| `SEC-04` Strategy | `workflow-triage-and-review` | 全流程精修、多视角独立复核、任务分流与合同审阅 | Adjustable review presets |
| `CAL-05` Calibration | `user-decisions` | 个人偏好与红线模板（空白起步，随用随攒） | Silent feedback SOP |
| `CAL-05` Calibration | `dsh-execution-discipline` | DeepSeek Harness 通用执行纪律与端到端门禁 | Adjustable guardrails |

---

## 6. Five-Minute Quick Start · 五分钟上手指南

### Step 1 · Launch Desktop Studio / 启动桌面星盘
Requires **Node.js `>= 20.0.0`** (no `npm install` needed):
- **Windows**: Double-click `Start-Rosetta.cmd` or `启动Rosetta仓管系统.cmd`
- **macOS / Linux**: Run `bash start-rosetta.sh` or `npm start`

### Step 2 · Connect Your AI Assistant / 接入 AI 助手（当前首发 DeepSeek Harness）
You do not need to hand-edit YAML. Hand [`FOR-DEEPSEEK-HARNESS.md`](../FOR-DEEPSEEK-HARNESS.md) and your local Rosetta folder path to **DeepSeek Harness**, and ask it to run `dsh-config`, merge `cordis.patch.yml`, sync `~/.dsh/skills/`, and verify with `lint` / `audit` / `status`.

### Step 3 · Everyday CLI Essentials / 常用命令行
```bash
npm test                                                  # Run full verification suite
npm run lint                                              # Validate schemas, links, WCAG contrast & hygiene
node bin/rosetta.cjs dsh-config                           # Generate machine-specific DeepSeek Harness config
node bin/rosetta.cjs sync --actor cli-local               # Differential sync to native skill directory
node bin/rosetta.cjs rollback <snap-id> --skill <id>      # Atomic per-skill snapshot rollback
node bin/rosetta.cjs audit                                # Verify SHA-256 audit chain integrity
```

---

*Rosetta v1.0.1 · Copyright (c) 2026 Siyuan He (HikawaRin). All Rights Reserved.*
