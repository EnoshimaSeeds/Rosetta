---
name: game-3d-live2d-pipeline
description: "进行 Unreal Engine 开发、AI + Tripo 3D 建模准备与导入审计、2D 立绘拆解 Live2D 图层或 UI 交互动效设计时启用。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **主力游戏引擎规范** (`primary_game_engine`): `Unreal Engine 5.x (C++ 与 Blueprint 职责分层)`
- **3D 角色资产管线** (`tripo_workflow`): `正交多视图参考图规范 → Tripo 生成 → 拓扑/UV/骨骼审计`
<!-- ROSETTA-FLAVOR-END -->

# 游戏引擎、3D 资产、Live2D 与 UI 动效工业管线

将概念美术与玩法设想转化为符合工业管线标准的工程规范，降低跨环节返工成本。

## 1. Unreal Engine 5.x 工程分层规范
- **C++ 与 Blueprint（蓝图）职责边界**：每帧高频逻辑（Tick）、核心状态机、网络复制与基础数据结构沉淀在 C++ 基类；资产引用绑定、UI 表现编排与特效事件触发放在蓝图子类，避免构建高耦合巨型蓝图图谱。
- **标准资产命名前缀**：修改资产前须核对既有引用链（Reference Viewer），新增资产统一遵循标准前缀：
  - `BP_`（蓝图类）、`WBP_`（UMG 界面蓝图）、`M_`（主材质）、`MI_`（材质实例）、`T_`（贴图，后缀 `_D/_N/_ORM`）、`SK_`（骨骼网格）、`SM_`（静态网格）、`NS_`（Niagara 特效系统）。

## 2. AI + Tripo 3D 角色资产前置规范与导入审计
- **生成前正交参考图标准**：输入给 Tripo 等 3D 生成工具的角色设定图必须采用标准 **A-Pose 或 T-Pose**、中性均匀漫反射照明（避免强投影烘焙进反照率贴图 Albedo）、清除遮挡躯干轮廓的大面积飘带与背景杂物，并保证前/侧/背视图比例严格对齐。
- **入引擎前五项质检门禁（Asset Import Audit）**：
  1. **面数与拓扑（Topology & Polycount）**：控制合理三角面预算，优先四边面布线，关节弯曲处具备足够循环边（Edge Loops）；
  2. **法线朝向（Normals）**：全模型外法线一致，无翻转黑面与非流形几何体（Non-Manifold Geometry）；
  3. **UV 展开（UV Unwrapping）**：无异常重叠、拉伸畸变与像素密度（Texel Density）失衡；
  4. **轴心与尺度（Pivot & Scale）**：世界原点 `(0, 0, 0)` 位于角色双脚中心底面，朝向与单位尺度（Unreal 默认 `1 UU = 1 cm`）对齐；
  5. **骨骼权重（Skinning & Weight Paint）**：肩、肘、髋、膝等大角度关节形变时无明显网格穿插或塌陷。

## 3. 2D 立绘拆解与 Live2D 分层标准（PSD Layering）
- **部件精细独立拆分**：按左右对称原则拆分「前发 / 侧发 / 后发 / 眉 / 上下眼睑 / 睫毛 / 瞳孔 / 高光 / 眼白 / 口腔内壁 / 上下唇 / 脸部底图 / 颈部 / 躯干 / 大臂小臂手掌 / 衣领与裙摆前后片」。
- **遮挡区域完整补绘（Occluded Area Inpainting）**：凡被上层部件遮挡的下层结构（如刘海下方额头、眼睑下方眼白、领口与颈部交界、手臂后侧衣身），必须完整补绘出血边缘，防止模型在头部或身体旋转（XYZ 轴形变）时出现露底或边缘缝隙。

## 4. UI 交互动效规范
- **动效物理曲线**：入场优先采用快速减速曲线 `cubic-bezier(0.2, 0.8, 0.2, 1)`（180–280 ms），退场简洁收束（120–180 ms），遵守 `prefers-reduced-motion` 无障碍偏好。
