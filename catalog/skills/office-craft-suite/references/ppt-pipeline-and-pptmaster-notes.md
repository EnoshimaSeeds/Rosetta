# 幻灯片自动化管线与可编辑 PPTX 工程笔记

本蓝图作为 `presentation-deck-craft`（叙事节奏、四套 WCAG 令牌与模块化页型）的**底层 `.pptx` 工程执行补充**，吸收自 `anthropics/skills/pptx`（Apache-2.0）与 `hugohe3/ppt-master`（MIT）源码审计经验，以及 `python-pptx` / `PptxGenJS` 官方规范整理。

---

## 0. 默认路由主控权约定（防多技能抢活打架）

当宿主同时挂载 `presentation-deck-craft`、`office-craft-suite` 与外部技能 `ppt-master` 时：
1. **内容、结构与视觉页型主控权**：默认归 **`presentation-deck-craft`**（含其随附的四套 WCAG 令牌 JSON 及 `academic-deck-patterns.md` / `visual-deck-patterns.md` 蓝图）。
2. **`ppt-master` 的默认角色**：仅作为**底层 SVG → 原生可编辑 DrawingML 编译、静态质检（`svg_quality_checker.py`）、视觉审查与视频导出工具链**按需调用，不启动其自带的多角色扮演与通用模板提问流程——**除非用户明确点名“按 PPT Master 原生全流程制作”**。

---

## 1. 三段式生产流水线（Spec Lock → 内容定稿 → 矢量转原生 PPTX）

1. **Stage 1：Spec Lock（规格锁死）**
   - 先锁定目标场景（学术答辩 / 课程批判性汇报 / 项目路演 / 美术设定集）、页数上限、讲解时长、画幅（默认 16:9：`13.333 × 7.5 in` 或 `1280 × 720` 逻辑画布）与视觉令牌（学术汇报直接读取 `presentation-deck-craft/scripts/deck-tokens.academic.json`）。
2. **Stage 2：内容与版面分离（先锁逐页大纲，再写生成代码）**
   - 先确认逐页标题、唯一视觉主体（图表/对比/流程/数字卡/设定卡）、精炼要点（45–70 词以内）与图表来源，确认无逻辑硬伤后再进入脚本生成。
3. **Stage 3：原生可编辑构建 + 质量门禁（Quality Gate）**
   - **可编辑优先**：优先产出原生 PowerPoint 文本框、矢量形状（DrawingML）与原生图表，避免把整页文字压死成不可修改的位图截图。
   - **SVG → DrawingML 路线**：复杂信息图或自定义版式可先输出严格 `viewBox="0 0 1280 720"` 的合规 SVG（显式声明 `spec_lock.md`、`data-pptx-page-role` 与顶层 `<g id="..." data-pptx-bounds="...">`），经静态质检后编译为原生可编辑 `.pptx`。

---

## 2. 脚本生成 `.pptx` 的高频工程坑（`python-pptx` / `PptxGenJS`）

- **画幅统一**：确认使用标准宽屏 `13.333 × 7.5 in`（`PptxGenJS` 中为 `LAYOUT_WIDE`，而非 10×5.625 的 `LAYOUT_16x9`）。
- **颜色与选项对象**：`PptxGenJS` 颜色传 6 位无 `#` 十六进制（如 `"1F4E8C"`），且每次 `addText` / `addShape` 传全新 options 对象（禁止复用同一对象引用导致库就地修改污染后续页面）。
- **文本框防溢出**：`python-pptx` 显式开启 `text_frame.word_wrap = True`，留足边距（画幅左右 ≥ 8%），正文不低于 `18pt`，注脚/来源不低于 `13pt`；严禁把浅色字直接盖在无半透明暗底遮罩的照片上。
- **交付前逐页核验**：导出预览或打开检查每一页的文本换行、公式字符、图元遮挡与页脚来源。

---

## 3. 可选外部引擎 `ppt-master` 扩展说明与许可边界

本开源整合包默认不捆绑第三方 `ppt-master` 仓库；若需要本地 SVG → 原生 DrawingML 编译与视频导出能力，可自行拉取开源仓库 `hugohe3/ppt-master`（MIT）至独立工具目录，并在 Rosetta 的 `catalog/external-skills.json` 中按哈希钉死后挂载：
- **离线边界与联网例外**：SVG 质检、SVG → PPTX 编译与本地渲染均为离线执行；若使用其可选旁白配音脚本（`edge-tts`），讲稿文本会发往微软在线语音服务，涉密或未公开学术数据禁止调用。
- **许可证边界**：使用时完整保留上游 MIT `LICENSE`；其可选本地 PDF 解析依赖 `PyMuPDF` 为 AGPL-3.0，仅限个人本机自用，勿打包再分发。
