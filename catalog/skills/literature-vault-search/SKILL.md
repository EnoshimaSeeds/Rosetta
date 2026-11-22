---
name: literature-vault-search
description: "检索学术文献、核查论文引用真伪或撰写文献综述时启用：自带 OpenAlex / Crossref API 实时核验脚本，严禁凭记忆编造文献或 DOI。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **默认参考文献格式** (`citation_style`): `APA 第7版 (APA 7th)`
- **强制联网核验每条 DOI/PMID** (`require_doi_verification`): `true` — 未通过权威数据库核验的文献严禁写入正式文稿
<!-- ROSETTA-FLAVOR-END -->

# 学术文献检索与引文真实性核验

## 1. 引文真实性底线（Citation Integrity Gate）
- **严禁凭模型记忆拼凑作者、发表年份、期刊名称、页码或 DOI**。
- 写入论文、实验报告、答辩幻灯片或文献综述的每一条参考文献，必须先经由随附脚本（Crossref / OpenAlex）或权威学科数据库（如 PubMed、Europe PMC、OpenAlex）实时检索确认存在。
- **阅读深度诚实标注**：若仅检索到题录或摘要（Abstract）而未获取并阅读全文（Full Text），必须在笔记或草稿中明确注明 **「仅核实题录/摘要，未查原文实验细节」**，禁止推测原文中的方法参数或统计结果。
- **预印本区分**：引用 bioRxiv、medRxiv、arXiv 等预印本（Preprint）时，必须明确标注其预印本属性与版本日期，不可冒充同行评审（Peer-Reviewed）期刊论文。

## 2. 随附脚本接口说明（`scripts/verify_or_search_lit.cjs`）
本技能内置零依赖 Node.js 联网核验脚本，支持两种模式：

```bash
node scripts/verify_or_search_lit.cjs doi "<DOI>"
node scripts/verify_or_search_lit.cjs search "<ENGLISH_OR_BOOLEAN_KEYWORDS>"
```

- **参数说明**：
  - `doi <DOI>`：调用 Crossref REST API 精确校验单条 DOI（自动剥离 `https://doi.org/` 前缀），返回 `{ verified, doi, title, journal, year, authors }`；若未查到则 `verified: false` 并返回 `httpStatus`。
  - `search "<keywords>"`：调用 OpenAlex Works API 检索前 8 条匹配文献，返回 `{ query, count, works: [{ title, year, doi, citedBy }] }`。
- **退出码与运行边界**：
  - `0`：检索成功（或 DOI 核验通过）；`1`：缺少参数、网络请求异常，或 `doi` 模式下 `verified === false`。
  - 单次请求内置 **8 秒超时**（`AbortSignal.timeout(8000)`）；可选配置环境变量 `ROSETTA_CONTACT_EMAIL`，向 Crossref / OpenAlex 请求头附加礼貌池联系信息以提升限流稳定性。
  - 若当前运行环境处于离线沙盒导致联网失败，须如实回报“未能联网核验”，不得退回凭记忆生成文献。

## 3. 英文学术检索式构造建议（Search Strategy）
- 优先使用目标领域的标准英文受控词（如生物医学使用 **MeSH Terms**）与同义词组合，配合布尔运算符（`AND` / `OR`）与明确时间窗。
- 综述类任务优先交叉检索近 5 年高引综述与奠基性原始实验论文，保留检索日期与检索式以便复现。

## 4. 论文精读与批判性拆解五步表（Critical Appraisal）
1. **研究问题与创新点**：针对既有研究的哪一具体缺口或局限？
2. **方法与关键参数**：样本量（`n`）、对照设置、仪器型号、采样率、激励条件或核心算法。
3. **主要定量结果与基线对比**：摘录原始数值、单位、离散度（SD/SEM/CI）与显著性指标，不以模糊形容词替代数据。
4. **局限性与潜在偏倚**：样本偏差、伪影敏感度、外部效度或实时性瓶颈。
5. **对当前课题的启示**：可复用的实验设计或需补充验证的假设。

## 5. 交付前自检
- [ ] 全部引用均已通过 `scripts/verify_or_search_lit.cjs` 或权威数据库核验 DOI / PMID
- [ ] 仅读过摘要的文献与预印本均已如实标注
- [ ] 参考文献格式与预设参数（APA 7th / Harvard / IEEE / Vancouver）一致
