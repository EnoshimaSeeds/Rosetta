---
name: materials-char-analysis
description: "处理拉伸/压缩曲线、DSC/TGA、FTIR/XRD、溶胀与降解等材料表征数据并写进报告时启用：数字由脚本算出，每个指标都写明定义、区间、n 和离散度。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **默认离散度口径** (`dispersion_metric`): `SD (标准差)`
<!-- ROSETTA-FLAVOR-END -->

# 材料表征数据分析与方法学报告

处理拉伸/压缩、DSC/TGA、FTIR/XRD、溶胀与降解这类表征数据时启用。目标只有一个：报告里的每个数字，别人按你写的方法能重新算出来。

## 0. 三条底线
- 数字来自脚本或保存下来的代码，不从图上估读，不心算。
- 每个指标同时给出：定义、计算区间或基线、样本数 n、离散度（写明 SD 还是 SEM）。
- 标准里的数值（应变区间、升温速率、试样尺寸）查所用标准的原文，不凭记忆写；没按标准做就直说“自选区间”并给出区间。

## 1. 拉伸 / 压缩曲线
先确认输入：应力是工程应力还是真应力，应变是小数还是百分比，试样尺寸怎么量的。

用随附脚本算指标（零依赖，Rosetta 自带的 node 就能跑）：

```bash
node scripts/tensile_metrics.cjs <data.csv> --fit-range 0.002,0.01 [--strain-col 0 --stress-col 1 --strain-unit frac --offset 0.002]
node scripts/tensile_metrics.cjs <data.csv> --strain-unit percent --auto
```

- **脚本选项与输出说明（`scripts/tensile_metrics.cjs`）**：支持 `--strain-col <name|index>`、`--stress-col <name|index>`、`--strain-unit frac|percent`（默认 `frac`）、`--fit-range a,b`（小数应变区间）、`--auto`（自动寻优线性段）、`--offset <fraction>`（默认 `0.002`）；标准输出 JSON，应力与韧性沿用输入列单位。

- **模量**：指定应变区间内的最小二乘斜率，报告区间和 R²。`--auto` 选出的区间必须画图确认后才能写进报告。
- **屈服**：默认 0.2% 偏移法，偏移线从趾部修正后的零点出发。脚本返回 `offsetYield: null` 时（脆性材料或弹性体），不要硬报屈服强度。
- **强度与断裂**：`ultimate` 是最大应力点；`lastPoint` 只是数据最后一行，它是不是断裂点要看原始曲线有没有掉载后的尾巴。
- **韧性**：`areaUnderCurve` 是到最后一点的梯形积分，单位等于应力单位（应力用 MPa 时即 MJ/m³）。

水凝胶、硅橡胶这类软材料没有线性段时，报告“某应变区间内的割线或切线模量”并写清区间，不叫杨氏模量。

## 2. 热分析（DSC / TGA）
- **DSC**：写明升温速率、气氛、取第几次升温。Tg 取台阶中点；Tm、Tc 取峰值；ΔH 用积分并说明基线类型和积分上下限。结晶度 Xc = ΔHm / (w × ΔH°m)，其中 ΔH°m 必须给出文献来源（用 literature-vault-search 核实）。
- **TGA**：报告 5% 失重温度或外推起始温度（写明是哪一个）、DTG 峰温、终点残余质量，以及气氛。
- 这部分暂时没有随附脚本：每次用 Python 或 MATLAB 写出分析代码，和数据放在一起保存。

## 3. 光谱与衍射（FTIR / XRD）
- 写明基线校正和归一化方法；峰位归属要有文献依据，不凭印象指认官能团。
- XRD：用布拉格方程换算晶面间距时写明波长；用 Scherrer 公式估晶粒尺寸时说明是否扣除了仪器展宽，并把结果当作下限估计；结晶度按面积比算时说明分峰方法。

## 4. 溶胀与降解
- 先写定义再报数：溶胀比是 (Ws − Wd) / Wd 还是 Ws / Wd，质量基还是体积基；质量损失 = (W0 − Wt) / W0。
- 写明介质、温度、时间点、换液方式、称重前如何去除表面水。每个时间点 n ≥ 3。

## 5. 统计
- 默认报告 mean ± SD (n = …)。n < 3 时只列原始值，不做显著性检验。
- 做检验时写明检验名称、是否配对、是否做了多重比较校正，以及为什么选它。
- 剔除任何数据点都要写明标准和被剔除的值。

## 6. 交付前自查
- [ ] 每个数字都能指到产生它的脚本输出或代码
- [ ] 区间、基线、n、SD/SEM 都写了
- [ ] 引用的标准值和文献常数已核对原文
- [ ] 图按 sci-figure-craft 出，坐标轴带单位
