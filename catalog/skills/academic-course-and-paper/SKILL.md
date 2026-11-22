---
name: academic-course-and-paper
description: "讲解大学课程讲义、撰写或润色英文学术论文与 LaTeX 工程、设计实验方案或联动科研绘图时启用。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **课件讲解风格** (`teaching_style`): `物理直觉先行 → 公式逐项拆解 → 考题与工程实例印证`
- **科研绘图色板规范** (`figure_palette`): `色盲安全学术色板 (Okabe-Ito)`
- **英文论文润色尺度** (`academic_english_tone`): `规范英式工科学术语体（British English，精准克制、去冗余修饰）`
<!-- ROSETTA-FLAVOR-END -->

# 高校课程精讲、LaTeX 学术写作与科研实验规范

## 1. 课程讲义与理论难点精讲
收到讲义、论文或复杂数学推导时，避免逐段机械复述原文，按三步展开：
1. **物理与工程直觉**：先用简明类比说明该概念或定理解决的核心物理/工程问题；
2. **公式逐项拆解**：明确每个符号的物理意义、国际单位制量纲（SI Units）与假设前提，指出主导项、耗散项或噪声项；
3. **实例与边界验证**：结合典型计算例题或简短脚本演示输入输出，明确推导或实验中的常见边界失效条件。

## 2. LaTeX 工程与英式学术写作规范
- **排版与符号一致**：物理量与单位使用规范正体（推荐 `siunitx`，如 `\SI{50}{\kilo\hertz}`）；标量（斜体）、矢量（粗斜体或箭头）与矩阵（粗正体）全篇体例一致；公式编号仅保留正文实际引用的条目。
- **英式学术写作准则（British Academic English）**：全文统一英式拼写（如 `characterisation`、`behaviour`、`modelling`、`analyse`）；避免口语缩略（`don't` / `can't`）、主观夸饰词（`very` / `dramatically` / `huge`）与无数据支撑的绝对断言；定量陈述必须附数值、单位与离散度。
- **项目目录守则**：在已有规范的课题仓库中工作时，严格遵守其根目录 `AGENTS.md` 或 `README.md` 约定的目录结构与索引更新规则，不修改历史归档文件。

## 3. 随附脚本接口说明（`scripts/check_tex_citations.cjs`）
修改 `.tex` 或 `.bib` 后，必须运行随附引文完整性门禁脚本核验：

```bash
node scripts/check_tex_citations.cjs <manuscript.tex> <references.bib>
```

- **检测范围**：自动剥离未转义的 `%` 注释行；识别 `\cite`、`\parencite`、`\textcite`、`\autocite`、`\citep`、`\citet`（含星号变体及可选 `[prenote][postnote]` 参数）；同步检索残留的中英文占位符（`TODO`、`FIXME`、`citation needed`、`待补引用`、`待核实引用`）。
- **输出与退出码**：标准输出 JSON `{ passed, citedCount, bibCount, missingInBib, unusedInBib, todoMarkers }`；当 `missingInBib` 为空且 `todoMarkers === 0` 时退出码为 `0`，否则退出码为 `1`。

## 4. 实验设计与科研配图联动
- **实验设计四要素**：动工或撰写方法学（Methodology）前，明确**自变量与控制变量**、**阳性/阴性对照基线（Controls）**、**重复样本量（Replicates, `n`）**以及**伪影与环境噪声控制方案**。
- **跨技能联动**：文献检索与 DOI 核验联动 `literature-vault-search`；材料表征数据处理联动 `materials-char-analysis`；Python Matplotlib 与 MATLAB 论文图表制作联动 `sci-figure-craft`（配套样式表 `rosetta-sci.mplstyle` 与导出脚本 `save_pub_fig.m`，位于 `sci-figure-craft` 技能包）。
