---
name: office-craft-suite
description: "创建、排版或审计 .docx、.xlsx、.pdf 与 .pptx 交付件时启用：按场景渐进式加载 FAST 建模、BME 实验数据、六套光谱皮肤（含诗意绘本与先锋设定画志）及精细线条铁律。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **默认中英文字体搭配** (`doc_font_pair`): `中文思源宋体→宋体 / 思源黑体→微软雅黑 + 英文 Times / Calibri`
- **默认 Word/PDF 皮肤策略** (`default_doc_scene`): `按任务自动判别（小作业极简 student-plain，创意画册按光谱派生）` — 防止小作业套花哨壳，同时让绘本与设定集摆脱公文框
<!-- ROSETTA-FLAVOR-END -->

# 专业办公文档精制规范（Word / Excel / PDF / PPT 工程路由）

> **来源与许可声明**：本技能在文档结构化生成、表格校验与幻灯片工程约束上参考自开源仓库 `anthropics/skills`（**Apache-2.0**）与 `hugohe3/ppt-master`（**MIT**），全部规范文本与场景蓝图均为本地团队独立整理的中文工程指南。

本技能采用**按需渐进式加载（Progressive Disclosure）**：先判定当前任务所属场景，只读取对应的 `references/` 子规范，避免跨场景风格污染或挤占上下文。

## 1. 按场景路由（动工前先读对应蓝图）
- **财务、量化、预算、进度或结构化决策表格（`.xlsx`）** → 读取 `references/excel-fast-modeling.md`（FAST 标准、ICAEW 20 原则、华尔街字体色码、Excel 365 动态数组与 `openpyxl` 工程避坑）。
- **生物医学工程 / 课程与毕设实验数据工作簿（`.xlsx`）** → 读取 `references/excel-bme-lab-data.md`（原始数据只读隔离、公式派生统计、Plot-Ready 导出，衔接 `materials-char-analysis`）。
- **Word（`.docx`）/ PDF 排版、线条精修、场景换皮与合同审阅** → 读取 `references/word-scene-skins.md`（6 套基准皮肤含 `story-book` 诗意绘本与 `editorial-zine` 侘寂/先锋独立画志 + 文档精细线条构成 + `snapToGrid` 防孤页铁律）。
- **幻灯片自动化管线与原生可编辑 PPTX（`.pptx`）** → 读取 `references/ppt-pipeline-and-pptmaster-notes.md`；**默认叙事、多光谱令牌与模块化页型主控权归 `presentation-deck-craft`**，外部 `ppt-master` 仅作底层编译与导出工具链调用。

## 2. 通用工程底线（全部办公任务必守）
1. **严禁手工拼装裸 OOXML / ZIP**：创建或修改 `.docx` / `.xlsx` / `.pptx` 一律使用当前环境已配置的隔离 Python 虚拟环境或成熟库（`python-docx`、`openpyxl`、`reportlab`、`pypdf`、`python-pptx` / `PptxGenJS`），避免手工拼接 XML 导致 Office 打开报错。
2. **先定场景气质，靠线条与留白建层级而非滥用底色块**：日常课程练习与小测默认极简克制（`student-plain`）；文学画册、美术设定文档或先锋提案则启用精细发丝线、边注栏与呼吸留白，不随意叠加高饱和彩色公文横幅。
3. **本地离线底线与联网例外声明**：文档读写、表格建模与幻灯片编译一律本机离线完成，不接入云端 Microsoft 365 OAuth / Graph API。**唯一联网例外**：仅在用户明确要求生成免费语音旁白并调用可选 `edge-tts` 时，讲稿文本会发往微软在线语音服务（涉密或未公开学术数据禁止调用）。
4. **实渲染视觉核验**：任何脚本生成的 PDF / Word / PPTX，交付前必须核查分页断行、右侧溢边、公式错误（`#REF!` / `#DIV/0!` / `#NAME?`）与中文字体完整度；若受限于当前环境未能打开桌面宿主渲染复核，须如实说明。
