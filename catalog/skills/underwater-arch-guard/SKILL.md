---
name: underwater-arch-guard
description: "开发多文件软件、桌面应用、持久化服务或准备开源发布时启用（百行内一次性脚本免除繁琐拆包）：执行模块化分层、安全隔离与仓库合规体检。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **默认按可开源卫生标准构建** (`open_source_ready`): `true` — 严禁在源码、文档或测试中硬编码个人路径、凭据或未声明许可的资产
- **最低验证门禁** (`test_requirement`): `真实入口端到端运行 + 核心边界与异常单元测试通过`
- **阶段交付附带架构与验证摘要** (`attach_health_card`): `true`
<!-- ROSETTA-FLAVOR-END -->

# 软件分层架构与开源安全基线

**适用边界**：在构建**多文件应用程序、桌面软件、持久化本地服务、MCP 服务或准备开源提交与打包**时启用。对于一次性数据探索、临时格式转换或百行以内的单文件脚本，仅需保证路径安全与结果准确，无需强行拆分多层目录。

## 1. 模块化分层解耦（Layered Modularity）
避免将业务逻辑、界面状态与磁盘 IO 混写于单一巨型文件；多模块项目按职责划分为四层：

| 层级目录 | 核心职责 | 依赖约束 |
| :--- | :--- | :--- |
| `contracts/` | 数据 Schema、类型定义、输入白名单与路径约束 | 不依赖业务逻辑与 UI |
| `core/` | 纯业务逻辑、持久化、锁与审计 | 不依赖具体窗口或宿主框架 |
| `desktop/` 或 `adapters/` | 进程通信（IPC）、CLI 入口、外部宿主适配 | 仅调用 `core/` 与 `contracts/` |
| `ui/` | 纯视图渲染与交互状态 | 仅通过受控桥接层通信，无直接文件系统权限 |

- 单个源码文件原则上控制在 **600–800 行以内**；机器相关路径或本地覆盖项抽离至环境变量或被 `.gitignore` 忽略的本地配置文件（如 `*.local.json`）。

## 2. 默认可开源的安全防线（Security & Open-Source Hygiene）
- **零私密信息硬编码**：源码、测试与公开文档中禁止出现本机专属绝对路径、私人邮箱、API Token 或未声明许可证的第三方资产。
- **路径边界与原子持久化**：所有路径参数限制在受控根目录内（校验 `..` 逃逸与符号链接真实目标）；关键状态文件采用“临时文件 → 落盘 → 原子重命名”并配跨进程锁。
- **Electron 渲染层安全基线**：强制开启 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`，配置严格 Content Security Policy（CSP），并通过 `contextBridge` 仅暴露白名单方法。

## 3. 随附脚本接口说明（`scripts/audit_repo_readiness.cjs`）
多文件工程交付或提交版本库前，运行随附零依赖体检脚本：

```bash
node scripts/audit_repo_readiness.cjs <target-project-dir>
```

- **扫描范围**：递归遍历常见源码、配置与文档扩展名（`.js/.cjs/.mjs/.ts/.tsx/.py/.java/.cs/.cpp/.h/.json/.toml/.md/.cmd/.vbs`，跳过 `node_modules`、`.git`、`dist`、`build`、`snapshots`、`runtime`、`.venv` 及超过 1 MB 的文件）。
- **检查项与分级**：
  - `HIGH`：发现硬编码本机专属路径，或检测到 Electron 开启 `nodeIntegration: true`；
  - `WARN`：缺少 `.gitignore`，或单个源码文件超过 850 行；
  - `INFO`：存在未说明原因的空 `catch` 块。
- **输出与退出码**：输出 JSON `{ targetRoot, filesScanned, issueCount, issues }`；若存在任意 `HIGH` 级问题则退出码为 `1`，否则退出码为 `0`。

## 4. 阶段交付摘要规范
多模块工程阶段交付末尾，以 3–5 条简明要点说明：模块分层边界、数据落盘与回滚位置、新增的权限或并发保护，以及实际执行的验证命令与未覆盖范围。
