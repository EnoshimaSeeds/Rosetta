---
name: modern-web-guidance
description: "编写网页、Electron 渲染层或现代 CSS/TS 界面代码时启用：参考 GoogleChrome/modern-web-guidance（Apache-2.0）与 Web Platform Baseline，优先使用现代原生 HTML/CSS/API。"
---

<!-- ROSETTA-FLAVOR-START -->
## 当前预设参数（Active Rosetta Presets）
- **脚本语言默认标准** (`language_default`): `现代 TypeScript (strict) 或 ES2024+ 标准模块`
<!-- ROSETTA-FLAVOR-END -->

# 现代 Web 平台开发规范（非官方中文精要）

> **来源与许可声明**：本技能参考开源项目 `GoogleChrome/modern-web-guidance`（许可证：**Apache-2.0**，由 Google Chrome、Microsoft Edge、Mozilla Firefox 与 MDN 团队联合维护）与 **Web Platform Baseline** 标准，由本地团队独立整理为**非官方中文技术精要**（无外部可执行脚本依赖）。详细对照表与降级策略见 `references/baseline-patterns-and-pitfalls.md`。

编写网页、Web 应用或 Electron 渲染层代码时，避免沿用过时的 JavaScript 兼容补丁与重型工具库，优先采用现代浏览器原生 Baseline 能力。

## 1. 先确认目标运行环境与 Baseline 分级
- **通用公网 Web**：默认优先选用 **Baseline Widely Available** 特性；采用 **Newly Available** 或 **Limited Availability** 特性时，须配合 `@supports` 特性检测或提供合理降级。
- **受控渲染内核（如现代 Electron / Chromium）**：可直接采用对应内核已稳定支持的现代 HTML/CSS/DOM API，并显式记录最低内核要求。

## 2. 原生语义化 HTML 组件优先
- **模态弹窗（Modal Dialog）**：优先使用原生 `<dialog>` 配合 `.showModal()` 与 `::backdrop`（内置顶层渲染 Top Layer、焦点管理与 `Esc` 关闭），避免自行编写高 `z-index` 遮罩与全局键盘拦截补丁。
- **轻浮层与菜单（Popover）**：优先使用原生 **Popover API**（`popover="auto"`），减少不必要的第三方浮层定位依赖。
- **折叠区（Disclosure / Accordion）**：优先使用原生 `<details>` + `<summary>`（互斥展开组使用相同 `name` 属性）。
- **交互语义与无障碍（Accessibility）**：按钮一律用 `<button>`，导航链接一律用 `<a>`，表单控件关联 `<label>`，保留清晰 `:focus-visible` 焦点样式。

## 3. 现代 CSS 布局、色彩与合成层动效
- **布局与组件响应**：优先使用 CSS Grid、`subgrid`、**CSS Container Queries（`@container`）**、`:has()` 与 `clamp()` 流体排版，避免通过监听 `window.resize` 反复计算 DOM 尺寸。
- **现代色彩与主题令牌**：使用 CSS 自定义属性配合 `oklch()` 或 `color-mix()` 构建色阶与半透明层次，确保正文满足 WCAG AA 对比度（≥ 4.5:1）。
- **高性能动效**：过渡动画优先作用于合成层属性（`transform`、`opacity`）或按需渐进采用 **View Transitions API**，必须尊重 `@media (prefers-reduced-motion: reduce)`。

## 4. 原生 JavaScript / TypeScript 平台 API 与性能基线
- **内置平台能力**：日期与数字格式化优先用 `Intl.DateTimeFormat` / `Intl.NumberFormat` / `Intl.RelativeTimeFormat`；深拷贝优先用 `structuredClone()`；URL 构造一律用 `new URL()` 与 `URLSearchParams`；异步超时与取消优先用 `AbortController` / `AbortSignal.timeout()`。
- **Node.js 运行时**：使用带前缀的内置标准模块（如 `node:fs`、`node:path`、`node:test`），减少冗余第三方基础库。
- **Core Web Vitals 核查**：为图片与媒体预留尺寸或 `aspect-ratio` 防止布局偏移（CLS），关键首屏资源避免延迟加载（LCP），避免主线程阻塞交互响应（INP）。

## 5. 交付前自检
- [ ] 已查阅 `references/baseline-patterns-and-pitfalls.md` 确认所选特性的 Baseline 兼容性
- [ ] 弹窗、浮层、折叠区优先采用原生语义化标签（`<dialog>` / `popover` / `<details>`）
- [ ] 无非语义可点击 `<div>`，键盘焦点与 `prefers-reduced-motion` 均已处理
- [ ] 未引入已被现代平台原生能力替代的陈旧工具库（如 Moment.js）
