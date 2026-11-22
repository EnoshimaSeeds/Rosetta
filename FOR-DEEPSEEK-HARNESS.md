# Rosetta for DeepSeek Harness — Agent 接入与使用手册

> **给用户的提示**：你不需要自己折腾下面的 YAML 和命令行——直接把这份文档连同 `Rosetta-DSH` 文件夹路径发给你的 **DeepSeek Harness（大肥鱼）**，对它说：  
> **“请阅读这份手册，帮我把 Rosetta 接入到当前的 DeepSeek Harness，并完成自检验收。”**

---

## 一、给 DeepSeek Harness（`dsh`）的定位说明

你正在协助用户安装、接入并日常使用本地技能与偏好仓管系统 **Rosetta for DeepSeek Harness（v1.0.0，All Rights Reserved）**。动手前请先明确三条协作铁律：

1. **只作能力叠加，绝不替代原生能力**：Rosetta 不替代 DeepSeek Harness 原生的 Cordis 插件、终端工具或工作区能力，只在原生能力之上提供经过验证的专业规范卡、可执行校验脚本与个人偏好记忆。
2. **用户当下指令优先，事后回修卡片**：当某张技能卡的旧规则与用户当下的明确要求冲突时，一律以用户当下的指令为准（若涉及数据安全或可维护性等硬风险，先简短提示利弊，仍由用户拍板）；事后再通过提案把卡片改准。
3. **人在回路的安全边界**：所有对正式技能库的修改都必须走提案队列（`rosetta_propose`）由用户在桌面端审阅 Diff 批准，或凭用户在桌面端签发的 5 分钟单次授权码调用 `rosetta_apply_authorized`。**严禁直接修改 `catalog/skills/` 下的文件**，否则会触发全包 SHA-256 防篡改锁并冻结同步。

---

## 二、接入前环境探测（4 项必查）

在修改任何配置文件之前，先在终端只读探测以下四项信息：

1. **确认 Node.js 版本（要求 `>= 20.0.0`）**：
   ```bash
   node -v
   ```
   若低于 20 或未找到 `node`，先提示用户安装 Node.js 20+（Rosetta 零第三方 `npm` 依赖，无需执行 `npm install`）。
2. **确认 `Rosetta-DSH` 根目录的真实绝对路径**（记为 `<ROSETTA_ROOT>`），确认其中存在 `package.json`、`bin/rosetta.cjs` 与 `src/mcp/server.cjs`。
3. **探测 DeepSeek Harness 配置与技能目录**：
   - 检查环境变量 `$DSH_HOME`（若未设置，默认为用户主目录下的 `~/.dsh`）。
   - 检查全局补丁文件 `~/.dsh/profiles/web/cordis.patch.yml` 或 `~/.dsh/cordis.patch.yml` 是否已存在；若已存在，**先读取原内容并做好备份，合入时绝不覆盖用户原有插件配置**。
4. **确认用户希望全局挂载还是仅在当前项目挂载**：
   - 未特别说明时，默认走**全局挂载**（`cordis.patch.yml` + `~/.dsh/skills`），所有会话开箱即用。

---

## 三、四步安装与接入 SOP

### Step 1：用内置生成器算出当前机器的精确配置

在 `<ROSETTA_ROOT>` 下运行（支持 `--json` 输出结构化对象方便程序解析）：

```bash
node "<ROSETTA_ROOT>/bin/rosetta.cjs" dsh-config
# 或机器可读 JSON：
node "<ROSETTA_ROOT>/bin/rosetta.cjs" dsh-config --json
```

该命令会自动解析本机真实的 `node` 可执行路径、`src/mcp/server.cjs` 绝对路径与 `$DSH_HOME/skills` 目标目录，并生成带正确单引号转义的 `cordis.patch.yml` 配置片段。

> **关于 `nvm` / Node 升级的提醒**：`dsh-config` 默认写入当前 `node` 的绝对路径（避免 GUI 或后台启动时找不到 `PATH`）；如果用户后续通过 `nvm` / `fnm` 等工具切换或升级 Node 版本导致旧路径失效，只需重新运行 `node "<ROSETTA_ROOT>/bin/rosetta.cjs" dsh-config` 更新 `command` 即可（若系统 `PATH` 稳定提供 Node 20+，也可将 `command` 改写为 `'node'`）。

### Step 2：挂载 Rosetta MCP 服务（核心主通道 · 原生 `cordis.patch.yml`）

DeepSeek Harness 原生通过内置插件 `@deepseek-ai/dsh-mcp-client` 挂载 MCP 服务，请将 Step 1 生成的条目写入当前 profile 的补丁文件 `~/.dsh/profiles/web/cordis.patch.yml`（若希望全机全部 profile 通用，可写入 `~/.dsh/cordis.patch.yml`）：

```yaml
- insert:
    - id: mcp-rosetta
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rosetta
        transport: stdio
        command: '<本机 node 绝对路径或 node>'
        args:
          - '<ROSETTA_ROOT>/src/mcp/server.cjs'
        env:
          ROSETTA_ACTOR: 'dsh'
          ROSETTA_ROOT: '<ROSETTA_ROOT>'
```

**合入时的关键避坑点**：
- **若目标 `cordis.patch.yml` 已有 `- insert:` 块**：把 `- id: mcp-rosetta` 这一整项追加到原有 `- insert:` 列表末尾，避免重复新建导致结构冲突；若已有同 `id: mcp-rosetta` 条目则原地更新。
- **严禁在文件中留空数组 `[]`**：DeepSeek Harness 启动解析补丁时遇到空数组可能报错。
- **必须显式设置 `env.ROSETTA_ACTOR: 'dsh'`**：Rosetta MCP 服务端采用 fail-closed 身份校验，缺少 `ROSETTA_ACTOR` 或填写未知值会直接拒绝启动并退出码为 `1`。
- **Windows 路径请用单引号包裹**（例如 `'D:\Tools\Rosetta-DSH\src\mcp\server.cjs'`），防止 YAML 把反斜杠当成转义字符。
- **不要误用 `.dsh/mcp.json`**：原生 DeepSeek Harness 并不读取项目级 `.dsh/mcp.json`（仅在另行安装了对应社区桥接插件时才生效）；请一律使用上述 `cordis.patch.yml` 方式接入。

#### 核验 Cordis 配置已正确合并
```bash
dsh --profile web --dump-config
```
确认输出的配置布局中已出现 `mcp-rosetta` / `@deepseek-ai/dsh-mcp-client`。  
如果目标 profile 尚未安装 MCP 客户端插件，或 `--dump-config` 里看不到 `mcp-rosetta`，请先执行：
```bash
dsh plugin --profile web add @deepseek-ai/dsh-mcp-client
```
（如用户使用的不是 `web` profile，将命令与补丁路径中的 `web` 替换为实际 profile 名称。）

### Step 3：同步本地技能目录至 DeepSeek Harness（Skills 发现通道）

执行一次同步命令，将全部已挂载且通过全包 SHA-256 校验的技能写入 `$DSH_HOME/skills`（默认 `~/.dsh/skills`）：

```bash
node "<ROSETTA_ROOT>/bin/rosetta.cjs" sync --actor dsh
```

- **首次试用推荐隔离同步目标（可选但更稳妥）**：若用户已有长期维护的全局 `~/.dsh/skills`，建议先将 `dsh-setup/rosetta.local.example.json` 复制为 `<ROSETTA_ROOT>/rosetta.local.json`，把 `dshSkillsDir` 指向一个空白测试项目的 `<test-project>/.dsh/skills`；这样无论是命令行还是桌面端按钮都会持续只同步到测试项目，完全不碰全局技能目录。
- 如果只是临时单次同步到某个项目目录，也可以加 `--target`：
  ```bash
  node "<ROSETTA_ROOT>/bin/rosetta.cjs" sync --actor dsh --target "<project>/.dsh/skills"
  ```
- `SyncEngine` 带有**非托管目录防覆盖保护**：若目标目录里已存在用户自己写的同名技能文件夹（含 `_mounted` 备用名），会自动跳过并给出警告，不会覆盖或误删原件。

### Step 4：端到端验收自检

依次执行以下校验命令并向用户汇报结果：

```bash
node "<ROSETTA_ROOT>/bin/rosetta.cjs" lint
node "<ROSETTA_ROOT>/bin/rosetta.cjs" audit
node "<ROSETTA_ROOT>/bin/rosetta.cjs" status
```

预期结果：
- `lint`：`ok: true`、`errorCount: 0`、`warningCount: 0`；
- `audit`：`ok: true`（SHA-256 审计哈希链完整连续）；
- `status`：已装 15 张默认技能卡，全部 `mountedForDsh: true`、`diskDrifted: false`。

**最后一步（必须提醒用户）**：
- **DeepSeek Harness 按会话快照缓存技能目录，且新接入的 MCP 工具需在重载后生效**。请提醒用户**重启/重载 DeepSeek Harness 或开启一个新会话**。
- 新会话建立后，调用一次：
  ```json
  mcp__rosetta__rosetta_list({ "onlyMounted": true, "compact": true })
  ```
  确认返回 `host: "dsh"` 以及 15 张已挂载技能列表，即完成全部接入。
- 顺带告知用户：日后想用可视化星盘界面浏览板块、调节预设参数、开关技能或审阅你提交的提案 Diff，只需双击 `<ROSETTA_ROOT>/启动Rosetta仓管系统.cmd`（macOS / Linux 运行 `bash start-rosetta.sh` 或 `npm start`）。

---

## 四、日常使用协议（如何省上下文且精准发力）

### 1. 工具总览（DeepSeek Harness 命名空间）

当 `serverName` 设为 `rosetta` 时，DeepSeek Harness 会按 `mcp__rosetta__<toolName>` 格式注册以下 10 个工具：

| DSH 工具名 | 属性 | 核心用途与调用建议 |
| :--- | :--- | :--- |
| `mcp__rosetta__rosetta_list` | 只读 | 查看板块与挂载索引；日常查目录务必传 `onlyMounted: true, compact: true` 节省上下文 |
| `mcp__rosetta__rosetta_inspect` | 只读 | **高频主工具**：传 `skillId` 读最新版 `SKILL.md` 及预设参数；再按需传 `file` 精准单读某个 `references/` 或 `scripts/` 子文件 |
| `mcp__rosetta__rosetta_verify_literature` | 只读 | 联网调用 Crossref（`mode: "doi"`）与 OpenAlex（`mode: "search"`）实时核验论文真伪，严禁凭记忆编造文献或 DOI |
| `mcp__rosetta__rosetta_security_scan` | 只读 | 引入外部 `SKILL.md` 或脚本前运行静态启发式扫描（检测指令覆盖、零宽字符、凭据窃取与外连） |
| `mcp__rosetta__rosetta_feedback` | 本地流 | **无感反馈收件箱**：`record` 静默记录用户随口点评，`list` 查询未归档条目，`resolve` 在提案通过后销账 |
| `mcp__rosetta__rosetta_propose` | 提案写入 | 向桌面端「待审变更」队列提交新增或修订草稿（自动生成多文件 Diff），不直接改正式库 |
| `mcp__rosetta__rosetta_apply_authorized` | 授权写入 | 仅当用户主动给出 Rosetta 桌面端签发的 5 分钟单次授权码 `RSTA-XXXX-XXXX` 时，用于合入无脚本修订 |
| `mcp__rosetta__rosetta_snapshots` | 只读 | 查看历史原子快照与钉住保护的里程碑版本 |
| `mcp__rosetta__rosetta_vault_search` | 只读 | 检索本机登记的项目交付件索引与章节锚点 |
| `mcp__rosetta__rosetta_vault_read` | 只读 | 按交付件 ID 核验 SHA-256 新鲜度（`CURRENT`/`STALE`/`MISSING`）并按 `anchor` 切片读取原件片段 |

### 2. 三段式按需读取策略（防止撑爆上下文）

1. **不要每轮都把全部技能正文拉进上下文**：你已经通过 MCP `instructions` 或 `~/.dsh/skills/` 索引知道全部技能的 ID 和一句话触发条件。
2. **命中即查**：当用户任务明确落入某个领域（见下方路由表），直接调用 `mcp__rosetta__rosetta_inspect({ skillId: "<id>" })` 读取该卡正文与当前预设参数。
3. **子文件渐进加载**：如果该卡带有 `references/`（例如 `office-craft-suite` 的 4 份蓝图）或 `scripts/`，只在确认需要对应子场景时，再传 `file: "references/<filename>"` 读取，或者直接用返回的 `scriptPaths` 路径运行随附校验脚本。

### 3. 预装 15 张技能卡速查路由表

| 板块 | `skillId` | 触发场景与随附工具 |
| :--- | :--- | :--- |
| **美学与表达** | `natural-chinese-prose` | 撰写/润色中文演示文案、汇报、图鉴与叙事文本（双向去人机味、防标题克隆与行尾劈词） |
| **美学与表达** | `art-style-and-ui-craft` | 绘画线稿、角色服装剪裁、现代 UI 空间/线条设计与短片前期策划（含 4 份 `references/`） |
| **美学与表达** | `presentation-deck-craft` | 学术答辩、路演、设定集 PPT/Slides（含 2 份页型蓝图 + 4 套 WCAG 令牌 `scripts/deck-tokens.*.json`） |
| **学术与文档** | `academic-course-and-paper` | 大学课程精讲、英文学术写作、LaTeX 工程与实验设计（含 `scripts/check_tex_citations.cjs`） |
| **学术与文档** | `literature-vault-search` | 学术文献检索与引文真实性核验（含 `scripts/verify_or_search_lit.cjs` + `rosetta_verify_literature`） |
| **学术与文档** | `office-craft-suite` | Word / Excel / PDF / PPT 工程路由（含 FAST 财务建模、实验数据、六套文档皮肤等 4 份蓝图） |
| **学术与文档** | `sci-figure-craft` | Python / MATLAB 论文级数据图（含 `scripts/rosetta-sci.mplstyle` 与 `scripts/save_pub_fig.m`） |
| **学术与文档** | `materials-char-analysis` | 拉伸/压缩曲线、DSC/TGA、FTIR/XRD 与溶胀降解分析（含 `scripts/tensile_metrics.cjs`） |
| **代码与管线** | `underwater-arch-guard` | 多文件工程、桌面应用与开源发布合规体检（含 `scripts/audit_repo_readiness.cjs`） |
| **代码与管线** | `mcp-server-checklist` | 编写或审查本地 stdio MCP 服务（协议、身份、文件锁、测试五维清单） |
| **代码与管线** | `modern-web-guidance` | 现代 Web / Electron 渲染层 CSS/TS/原生 API 规范（含 `references/baseline-patterns-and-pitfalls.md`） |
| **代码与管线** | `game-3d-live2d-pipeline` | Unreal Engine 5 分层、Tripo 3D 入引擎五项质检、Live2D 拆层与 UI 动效 |
| **调度与文书** | `workflow-triage-and-review` | 「走一遍流程」精修、「多视角独立复核」、多线程任务分流、合同四列表审阅与正式英文邮件 |
| **偏好与纪律** | `user-decisions` | **个人偏好与红线模板（私有校准层）**——产出重要代码、设计、文档前优先查阅 |
| **偏好与纪律** | `dsh-execution-discipline` | **DSH 通用执行纪律**——需求分岔先确认、多步长任务落盘、真实入口端到端验证 |

---

## 五、无感反馈与个人校准闭环（让 Rosetta 越用越懂用户）

用户不需要手动维护自己的偏好文档，请按以下三步在后台帮用户自然沉淀：

1. **静默记录**：每当用户审阅你交付的代码、文档、图表、网页或文案，并随口点评某处“很好 / 以后就这样 / 不要这么写 / 必须保留某点”时，不要打断对话，也不要让用户填表——在后台静默调用：
   ```json
   mcp__rosetta__rosetta_feedback({
     "action": "record",
     "kind": "good | bad | redline | preference",
     "domain": "code | aesthetic | prose | academic | workflow | communication",
     "note": "提炼后的具体规则或原因",
     "quote": "用户的原话短句（可选）",
     "skillId": "关联的 skillId（可选）"
   })
   ```
2. **达阈升格**：当返回值中 `shouldSuggestPromotion: true`（遇到明确 `redline`，或同一领域累计 ≥ 2 条未归档反馈）时，主动把规律浓缩为 1–2 句可执行的条款，调用 `mcp__rosetta__rosetta_propose` 提交更新到 `user-decisions` 或对应的专业技能卡，并简短提醒用户：“我把你刚才提到的偏好整理成了一条待审提案，有空时在 Rosetta 桌面端点一下「待审变更」审阅批准即可生效。”
3. **批准后销账**：确认提案已被批准入库后，调用 `mcp__rosetta__rosetta_feedback({ action: "resolve", ids: [...], resolution: "promoted", proposalId: "..." })` 清理已消化反馈。

---

## 六、常见故障速查

| 现象 | 原因 | 解决办法 |
| :--- | :--- | :--- |
| `--dump-config` 看不到 `mcp-rosetta`，或提示缺少 `@deepseek-ai/dsh-mcp-client` | 目标 profile 尚未安装 MCP 客户端插件 | 先执行 `dsh plugin --profile web add @deepseek-ai/dsh-mcp-client`（按实际 profile 名替换 `web`），再复检 `--dump-config` |
| MCP 启动失败，stderr 提示 `Refusing to start: ROSETTA_ACTOR must be one of [dsh]` | 未在配置中传 `ROSETTA_ACTOR`，或拼写不是 `dsh` | 在 `cordis.patch.yml` 的 `env` 中显式写入 `ROSETTA_ACTOR: 'dsh'` |
| `dsh` 启动时报 YAML 解析错 | `cordis.patch.yml` 存在空数组 `[]`、缩进错位或 Windows 反斜杠未加单引号 | 重新运行 `node bin/rosetta.cjs dsh-config` 复制标准单引号 YAML，并用 `dsh --profile web --dump-config` 验证 |
| 升级或用 `nvm` 切换 Node 后 MCP 突然无法拉起 | `cordis.patch.yml` 中记录的旧 `node` 绝对路径已不存在 | 重新运行 `node bin/rosetta.cjs dsh-config` 刷新 `command` 路径并更新配置 |
| `sync` 已成功，但当前对话看不到新技能 | DeepSeek Harness 按会话快照加载技能目录 | 重载 DSH 或开启一个新会话即可识别 |
| `sync` 提示 `[tamper-guard] 拦截 ... 哈希不一致` | 有人在 Rosetta 之外直接手改了 `catalog/skills/<id>/` 下的文件 | 请用户在 Rosetta 桌面端点击该卡的「审阅磁盘漂移 Diff」，选择「采纳并重新盖章」或「单卡还原至入库基线」 |
| `sync` 提示 `保护跳过 <id>：目标目录已存在非 Rosetta 托管的同名文件夹` | `~/.dsh/skills/` 中原本就有用户自建的同名技能 | 属于正常防覆盖保护；向用户确认是否需要保留原件、改名或由 Rosetta 接管 |
