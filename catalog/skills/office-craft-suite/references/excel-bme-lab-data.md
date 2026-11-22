# 生物医学工程与科研实验 Excel 工作簿规范（BME Lab Data）

本蓝图用于生物医学工程、材料与理工科课程实验、毕业设计或材料表征数据处理（拉伸/压缩、溶胀降解、MTT/细胞活性、组织学定量、DSC/TGA/FTIR 汇总等），与 `materials-char-analysis` 及 `sci-figure-craft` 配合使用。

---

## 1. 四层不可逆隔离架构（严禁在原始数据上直接改数字）

| 工作表名 | 权限属性 | 内容与铁律 |
| :--- | :--- | :--- |
| `01_Raw_Data` | **只读冻结** | 仪器导出的原始 CSV/TXT 数据原样粘贴；记录仪器型号、测试日期、操作者、样品批号与原始单位。**严禁手工删行、改值或删离群点。** |
| `02_Clean_Normalized` | 公式派生 | 通过跨表公式引用 `01_Raw_Data` 完成扣空白（blank subtraction）、截面积/标距归一化（应力-应变换算）与单位换算。新增 `QC_Flag`（`OK` / `Outlier`）与 `QC_Reason` 两列，离群复孔**只标注不删除**。 |
| `03_Stats_Summary` | 动态统计 | 按实验组别自动计算：`n`（`COUNTIFS`）、`Mean`（`AVERAGEIFS`）、`SD`（样本标准差 `STDEV.S`）、`SEM`（`=SD/SQRT(n)`）、`Median` / `IQR`（非正态或小样本），并明示是否排除已标记离群点。 |
| `04_Plot_Ready` | 绘图导出 | 规整的 Tidy 格式（长表或清晰宽表），无合并单元格、无多级斜线表头、列名为纯英文/ASCII 友好标识（如 `group_id`, `time_h`, `stress_MPa`），供 Python (`pandas`/`matplotlib`) 或 MATLAB 脚本直接读取出图。 |

---

## 2. 科研数据表格四项硬纪律

1. **每列必带 SI 单位**：列头写清物理量与括号单位，例如 `Load (N)`、`Displacement (mm)`、`Stress (MPa)`、`Strain (%)`、`Swelling Ratio (%)`，绝不允许“裸数字列”。
2. **零硬编码统计量**：均值、标准差、相对变化百分比与归一化比值一律写 Excel 动态公式；若统计检验（ANOVA / Shapiro-Wilk / Kruskal-Wallis）由 Python/R/SPSS 算出，须在工作表注明**计算脚本路径、检验方法、样本量 `n` 与显著性阈值**，不可无出处贴死数。
3. **误差棒与 `n` 定义一致**：同一工作簿内明确统一采用 `Mean ± SD`（展示样本离散度）还是 `Mean ± SEM`（展示均值估计误差），并写清 `n` 是独立生物重复还是同一支架的技术复测。
4. **防科学计数法与日期误转换**：样品编号（如 `1-2`、`003`、`DEC1`）在 `openpyxl` 写入时显式设置单元格格式为文本 `@`，防止 Excel 自动改成日期或吞掉前导零。

---

## 3. `openpyxl` 科研制表收尾检查清单

- [ ] `01_Raw_Data` 与原始仪器文件行数、校验和一致，零手改痕迹；
- [ ] `02_Clean_Normalized` 与 `03_Stats_Summary` 全部由公式链接，无手填均值/SD；
- [ ] 小数位数符合测量仪器有效数字精度（避免显示 `3.141592653589`）；
- [ ] `04_Plot_Ready` 无合并单元格，可直接被 `pandas.read_excel(..., sheet_name="04_Plot_Ready")` 无报错读入；
- [ ] 冻结表头、自适应列宽、无 `#DIV/0!` / `#VALUE!` / `###`。
