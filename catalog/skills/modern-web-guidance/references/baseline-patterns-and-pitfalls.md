# 现代 Web 平台模式对照与 Baseline 避坑指南

> **来源与许可声明**：本文档为参考开源项目 [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance)（Apache-2.0，由 Google Chrome、Microsoft Edge、Mozilla Firefox 与 MDN 社区联合维护）及 W3C/WHATWG **Web Platform Baseline** 公开标准整理而成的**非官方中文技术精要**，未照搬上游原文文件，仅提炼现代 Web 开发实践与英中术语对照。

---

## 1. Web Platform Baseline 兼容分级（Compatibility Tiers）

选型任何浏览器原生特性前，须区分其 Baseline 状态与运行环境（通用公网 Web vs. 受控内核如 Electron / Chromium）：

| Baseline 状态 | 英文标准术语 | 含义与适用策略 |
| :--- | :--- | :--- |
| **广泛可用** | **Baseline Widely Available** | 已在 Chrome、Edge、Firefox、Safari 全部主流引擎稳定支持 ≥ 30 个月；可直接作为生产默认方案。 |
| **新近可用** | **Baseline Newly Available** | 已在四大核心引擎落地但不足 30 个月；现代站点与 Electron 桌面端可直接使用，面向旧浏览器时配合 `@supports` 渐进增强。 |
| **有限可用** | **Limited Availability** | 仅部分引擎支持（如部分 CSS Anchor Positioning / 特定 View Transitions 特性）；仅在明确锁定渲染内核（如现代 Electron）或已提供可靠降级方案时使用。 |

---

## 2. 传统反模式 vs. 现代原生方案对照表（Legacy vs. Modern）

| 常见场景 | 应淘汰的旧写法（Legacy Anti-Pattern） | 推荐现代原生方案（Modern Web Platform） | 工程要点与降级注意 |
| :--- | :--- | :--- | :--- |
| **模态弹窗（Modal）** | 自定义 `div` 遮罩 + `z-index: 9999` + 手写焦点陷阱与 `Esc` 监听 | 原生 `<dialog>` + `showModal()` + `::backdrop` | 自动进入顶层渲染层（Top Layer）、内置焦点管理与 `Esc` 关闭；避免破坏无障碍角色语义。 |
| **浮层/菜单/提示框** | 重型第三方弹窗定位库管理简单气泡 | **Popover API**（`popover="auto"` / `popover="manual"`）配合 **CSS Anchor Positioning**（按内核支持情况选用） | 自动处理点击外部关闭（Light Dismiss）与顶层堆叠；跨旧版 Safari 时保留基础定位回退。 |
| **折叠面板（Accordion）** | 手写 `aria-expanded` + JS 切换高度动画 | 原生 `<details>` + `<summary>`（互斥组使用相同 `name` 属性） | 零 JS 即可键盘访问与屏幕阅读器可读。 |
| **组件级响应式布局** | 监听 `window.resize` 读取 `offsetWidth` 切类名 | **CSS Container Queries**（`container-type: inline-size` + `@container`）、`subgrid`、`clamp()` | 布局响应组件自身容器而非视口，彻底消除缩放抖动与重排开销。 |
| **父级状态样式联动** | 用 JS 给父节点同步增删 `.has-error` / `.is-checked` 类 | CSS `:has()` 关系伪类 | 声明式表达父子/兄弟状态关联，减少 DOM 状态同步代码。 |
| **色彩体系与透明混色** | Sass 预编译固定色表或手算 `rgba()` | `oklch()` 感知均匀色彩空间 + `color-mix(in srgb/oklch, ...)` | 在暗色与亮色主题下更易保持一致的视觉对比度。 |
| **滚动联动与视图切换** | 监听 `scroll` 事件高频改 `style.top` / 重型转场框架 | 合成层属性（`transform` / `opacity`）、**View Transitions API**、**Scroll-Driven Animations**（按 Baseline 状态渐进启用） | 全程遵守 `@media (prefers-reduced-motion: reduce)`。 |
| **日期/数字/语言格式化** | 引入 Moment.js 等已进入维护模式的大型日期库 | 原生 `Intl.DateTimeFormat`、`Intl.NumberFormat`、`Intl.RelativeTimeFormat` | 零打包体积开销，原生支持时区与本地化格式。 |
| **对象深拷贝与 URL 拼接** | `JSON.parse(JSON.stringify(...))`（丢失 `Date`/`Map`/`Set`）或手拼 `?a=1&b=` | 原生 `structuredClone()`、`new URL()`、`URLSearchParams` | 正确处理编码转义与复杂内置类型。 |
| **异步取消与超时控制** | 手写布尔标志位忽略过时回调 | `AbortController` + `AbortSignal.timeout(ms)` | 统一取消 `fetch`、事件监听与异步流。 |

---

## 3. 无障碍（Accessibility / a11y）与性能基线（Core Web Vitals）

1. **键盘与语义化优先**：交互元素一律使用 `<button>`、`<a>`、`<input>`，禁止给 `<div>` / `<span>` 绑点击事件充当按钮；保留清晰的 `:focus-visible` 焦点轮廓；为图标按钮提供 `aria-label`。
2. **Core Web Vitals 关键约束**：
   - **LCP（Largest Contentful Paint）**：首屏主视觉资源不延迟加载，关键图片声明 `width`/`height` 与 `fetchpriority="high"`；
   - **CLS（Cumulative Layout Shift）**：图片、媒体与异步占位区预留明确纵横比（`aspect-ratio`），防止内容跳动；
   - **INP（Interaction to Next Paint）**：避免在点击/输入主线程执行同步重计算，高频事件做好节流或交由合成层动画。

---

## 4. 上游官方工具参考（可选）

若当前工程允许联网并希望基于官方完整规则库对既有代码库执行确定性扫描，可按需了解上游 CLI（Apache-2.0）：
- `npx modern-web-guidance@latest legacy-scan`：对既有 HTML / CSS / JS / TS 与 `package.json` 执行确定性静态扫描，识别可替换为原生 Web 平台能力的旧模式。
- `search` / `retrieve`：检索上游最新整理的主题指南与 Baseline 兼容数据。
> 注：在离线环境或受控沙盒中开发时，无需联网拉取该 CLI，直接遵循本技能与本参考手册即可。
