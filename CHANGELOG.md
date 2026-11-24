# Changelog

All notable changes to the **Rosetta** public repository are documented in this file.

---

## [1.0.1] — 2026-11-24

### Safety & Core Engine Fixes
- **Default Incremental Merge for `references/` and `scripts/` (`skill-bundle-io.cjs`):** Partial proposals or updates that only pass modified subfiles no longer wipe untouched sibling files in `references/` or `scripts/`. Deletions now require explicit filename lists via `removeReferences` and `removeScripts` (validated against path traversal).
- **Mandatory Desktop Diff Gate on File Deletions & Destructive Shrink (`catalog-service.cjs`):** Even with a valid 5-minute single-use MCP authorization token (`rosetta_apply_authorized`), any payload containing `removeReferences` / `removeScripts`, blanking an existing non-empty file, or truncating a file below 10% of its original size is automatically routed to the Desktop Diff approval queue rather than applied silently. Conflicting add/update + remove on the same filename is rejected (`ERR_CONFLICTING_SUBFILE_OP`).
- **File-Level Diff Badges & Broken-Reference Preview (`catalog-service.cjs`, `modals-panel.js`, `styles.css`):** Pending proposals now compute and display structured file-level changes (`+ Added`, `~ Modified`, high-contrast red `- Deleted` chips, and `notFoundRemovals` notices) alongside pre-approval broken-reference warnings whenever `SKILL.md` points to missing `references/*` or `scripts/*` files.
- **Stronger Subfile Link Linting (`catalog-linter.cjs`):** `findBrokenSubfileRefs` now checks both bare (`references/foo.md`, `scripts/bar.cjs`) and `./`-prefixed (`./references/foo.md`, `./scripts/bar.cjs`) references across `SKILL.md`, and directory linting skips dot-prefixed entries.
- **Per-Skill Atomic Snapshot Rollback & Fail-Closed Snapshot Integrity (`snapshot-store.cjs`, `ipc-dispatcher.cjs`, `bin/rosetta.cjs`, `modals-panel.js`):** Added `rollbackSkill(snapshotId, skillId)` so a single skill directory can be verified (SHA-256) and restored from any historical snapshot without reverting concurrent edits to other skills or assignment switches. Both whole-catalog `rollback` and `rollbackSkill` now reject any unexpected unlisted files or symlinks inside snapshot directories, materialize strictly from verified buffers, and capture clean pre-rollback safety snapshots before creating staging dirs. Exposed via CLI (`node bin/rosetta.cjs rollback <snap-id> --skill <skill-id>`) and the Desktop Snapshots modal (`↩ 仅回滚此卡`).
- **Studio Script Removal Sync (`studio-panel.js`):** Removing a script in Tier 3 Studio now records `removedScripts` explicitly to stay aligned with incremental merge semantics.
- **Regression Test Suite (`test/incremental-merge-and-rollback.test.cjs`):** Added 4 dedicated tests covering incremental subfile merge, explicit deletions + grant blanking/shrink interception + `./` broken-ref linting, per-skill snapshot rollback, clean safety snapshots, and fail-closed unlisted-file rejection (16/16 passing).

### Documentation, Licensing Consistency & Polish
- **Removed Informal Nicknames:** Replaced all informal community nicknames across `FOR-DEEPSEEK-HARNESS.md`, `src/ui/index.html`, and the user manual with neutral product names (`DeepSeek Harness`, `ChatGPT / Codex`, `Claude`, `Gemini`).
- **Unified Licensing Messaging (`All Rights Reserved`):** Fixed lingering `MIT License` / `Open-Source Edition` text in the old PDF handbook, `CHARTER.md`, `README.md`, and linter message (`catalog-linter.cjs`) so every document consistently reflects the repository's `All Rights Reserved` terms (`LICENSE`).
- **Rebuilt Bilingual Multi-Assistant User Guide (`docs/USER_GUIDE.md` & `docs/Rosetta-User-Guide-Bilingual.pdf`):** Replaced the single-client Chinese-only PDF handbook with a formal Chinese/English bilingual manual covering multi-assistant architecture, incremental governance, and updated quick-start instructions (including `bash start-rosetta.sh` and per-skill rollback).

---

## [1.0.0] — 2026-11-22

- Initial public release of the zero-dependency Rosetta core engine, 3-tier orbital Desktop Studio, local stdio MCP server, full-bundle SHA-256 tamper-guard, hash-chained audit log, atomic snapshots, `rosetta lint`, 15 curated general-purpose skill packs, and the DeepSeek Harness (`dsh`) adapter.

---

## 中文更新说明（v1.0.1 · 2026-11-24）

### 核心安全与工程修复
- **`references/` 与 `scripts/` 默认改为增量合并**：局部提案只提交修改过的子文件时，不再静默清空同目录下未提及的既有文件；真要删除必须通过 `removeReferences` / `removeScripts` 显式点名，并强制校验安全文件名防路径穿越。
- **删除、清空与大幅截断均强制走桌面 Diff 审批**：即便是持有 5 分钟单次授权码的 `rosetta_apply_authorized` 调用，只要包含 `removeReferences` / `removeScripts`，或将既有非空文件清空、缩减至原体积 10% 以下，一律强制转入桌面待审队列；同一文件同时出现在增改与删除列表中时直接报错拒绝（`ERR_CONFLICTING_SUBFILE_OP`）。
- **桌面审批弹窗新增文件级差异栏与断链预警**：每条待审提案顶部直接以颜色标签展示 `+ 新增`、`~ 修改` 与**醒目红色 `- 删除`** 文件清单（删除不存在文件名时记入 `notFoundRemovals` 提示）；若 `SKILL.md` 引用了不存在的子文件，审批前即弹出红色断链警告。
- **Linter 补强 `./` 相对路径断链校验**：同时检查 `references/*`、`./references/*`、`scripts/*`、`./scripts/*` 的文件存在性，且遍历技能目录时跳过点开头隐藏目录。
- **新增按 `skillId` 单卡原子回滚与快照防注入校验**：支持只恢复指定一张技能卡的目录并刷新其基线，不回退其他并发修改过的技能与挂载开关（CLI `rollback <snap-id> --skill <skill-id>` 与桌面端「↩ 仅回滚此卡」）；整库与单卡回滚均改为先拍干净安全快照、再严格只物化 manifest 验签通过的文件，发现任何快照清单外文件（如意外塞入的脚本）或符号链接立即拒绝回滚。
- **补齐 4 条专项回归测试**：全仓测试由 12 项扩至 **16/16 全部通过**，仓库体检脚本 0 HIGH / 0 WARN。

### 文档、称谓与许可口径清理
- **彻底清除圈内昵称**：清除了 `FOR-DEEPSEEK-HARNESS.md`、`src/ui/index.html` 与用户手册中的所有非正式昵称，统一使用中性正式产品名称（`DeepSeek Harness`、`ChatGPT / Codex`、`Claude`、`Gemini`）。
- **统一 `All Rights Reserved` 许可口径**：修正了旧版 PDF 手册、宪章标题、README 与 linter 提示里残留的 `MIT` / 开源字样，与仓库根目录 `LICENSE` 与 `package.json` 完全一致。
- **重构中英双语正式用户手册**：新增可直接在线阅读的 [`docs/USER_GUIDE.md`](./docs/USER_GUIDE.md) 与重新排版生成的 [`docs/Rosetta-User-Guide-Bilingual.pdf`](./docs/Rosetta-User-Guide-Bilingual.pdf)，替代旧版单客户端手册，并同步补齐 `bash start-rosetta.sh` 等启动提示。
