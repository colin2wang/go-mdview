# go-mdview 代码审查：问题与优化建议
先说结论：这是一个工程素养相当高的项目——单一净化配置源（`sanitize-config.json`）、DOMPurify 真实 DOM 解析、净化回归脚本、同形 Mock API、平台条件编译（`_windows/_other`）、测试覆盖核心纯函数，都属于同类项目里少见的好实践。以下问题多集中在**并发正确性、依赖治理、类型安全和防线纵深**上。
---
## 一、正确性与并发问题（优先修）
### 1. `markdown.ts` 全局渲染上下文存在交错污染风险 ⚠️ 高
```ts
let slMd = ''
let slCursor = 0
let slLineMap: number[] = []
```
`renderMarkdown` 是 async 函数（`await Promise.all([freshMarked(), ensureHljs()])`），而 `withSl`/`tokenSrcLine` 依赖上述**模块级全局游标**。快速切换文件时（旧 promise 未完成、新渲染已开始），两个渲染会共用/互相推进同一个 `slCursor`，导致 `data-sl` 行号错乱 → 同步滚动锚点漂移，且这类 bug 极难复现定位。
**建议**：把状态封装进渲染上下文对象，随 promise 传递：
```ts
function createRenderCtx(md: string, lineMap: number[]) {
  let cursor = 0
  return {
    tokenSrcLine(raw: string): number { /* 用闭包内的 cursor */ },
    withSl(html: string, raw: string): string { /* ... */ }
  }
}
```
### 2. `createState` 同一参数在不同调用点类型不一致
- `sanitizeHtml`：`createState(blockRemote, remoteAllow, blockedImgUri, t('img.blocked'))` —— 第三参传**函数**
- `sanitizeSvg`：`createState(true, '', () => '', '')` —— 传返回空串的函数
- `sanitize-check.mjs`：`createState(blockRemote, remoteAllow, PLACEHOLDER, 'blocked')` —— 传**字符串**
  `sanitize-common.js` 是 JS + `d.ts` 手写声明，这种隐式联合（`string | (() => string)`）在 `d.ts` 漂移时不会报错。建议统一为一种形态（推荐函数），并在 `d.ts` 中显式声明。
### 3. `i18n.ts` 中 `t()` 的占位符正则未转义
```ts
re = new RegExp(`\\{(${names})\\}`, 'g')
```
若占位符名含正则元字符（如 `{file.name}`），`.` 会被当任意字符，可能误替换。低概率但修复成本极低：对 `names` 做 `escapeRegExp`。
---
## 二、依赖与构建治理
### 4. TypeScript 4.9 锁死整个生态，靠 override 硬扛 ⚠️ 高
```yaml
# pnpm-workspace.yaml
overrides:
  '@types/d3-dispatch': 3.0.6  # 注释自述：mermaid 传递依赖用了 TS 5.0 const 类型参数
```
这是"用旧编译器锁住全生态"的典型信号：每引入一个新依赖都可能再次踩 TS5 语法，override 列表会持续膨胀。**建议升级 TS 5.x**（Vue 3.5、vue-tsc 1.8 均兼容），随后删除该 override。
同时注意版本漂移与陈旧：
- `package.json` 写 `vue: ^3.2.37`，实际锁 3.5.44 —— 声明范围应与实际支持基线一致
- Vite 3 / vitest 0.34 / jsdom 24 均已停止维护，建议列入升级路线（Vite 5+ 收益：更快的构建、原生 ESM）
### 5. 双版本依赖导致 bundle 膨胀
lockfile 显示同时存在：
| 包 | 主应用 | mermaid 传递依赖 |
|---|---|---|
| katex | 0.16.9 | 0.16.47 |
| marked | 15.0.12 | 16.4.2 |
pnpm 会实例化两份，KaTeX 的字体资源也会重复。**建议**：主应用 katex 对齐到 0.16.47+（顺带获得安全修复），通过 `pnpm.overrides` 统一；marked 双份若无法统一（mermaid 锁 16），至少知晓成本，未来 marked 16 API 变化时 `renderer.table` 等复刻代码需要重查。
---
## 三、安全纵深（现有体系已强，补最后几块板）
### 6. `remoteAllowed` 通配符的绕过面
测试只覆盖了 `cdn.example.com/*` 的简单匹配/拒绝。若实现是"前缀 + `*` 通配"，需确认以下向量被拒绝并加入用例：
```
https://cdn.example.com@evil.com/x.png   # @ 凭据绕过
https://cdn.example.com.evil.com/x.png   # 后缀拼接
https://evil.com/?q=.cdn.example.com     # query 干扰
```
### 7. KaTeX 渲染配置未展示，确认禁用 `trust`
KaTeX 历史上有 `\href`/`\includegraphics` 相关 XSS（依赖 `trust` 选项）。`vendor.ts` 的 `maybeMath` 配置若未显式 `trust: false`（默认即 false，但不要主动开启），建议加注释固化 + 用例。
### 8. 后端 `imgsrv` 是真正的防线
前端 `resolveImgHref` 会把**任意绝对路径** hex 编码进 `/mdimg/{hex}/...`，前端不可信。必须确认 Go 侧：
- 强制校验解码后路径位于 `AllowImageDir` 白名单内（含符号链接、`..` 归一化）
- 仅监听 loopback
- 为路径穿越补 Go 单测（`fsops_test.go`/`imgserver_test.go` 应覆盖）
### 9. 建议加 CSP 作为纵深防御
净化已是第一道防线，WebView2 场景再加一层 CSP（`script-src 'self'`、禁 `object-src`、img 受控）成本很低、收益明显——即使未来某处 `v-html` 漏净化也被兜住。
---
## 四、类型安全与测试设计
### 10. `App as unknown as Api` 双重断言绕过编译期检查
```ts
function desktopApi(): Api {
  return App as unknown as Api  // bindings 缺方法时编译不报错
}
```
bindings 重新生成后若方法名/签名漂移，只会在运行时才炸。**建议**：dev 模式做一次形状校验：
```ts
if (import.meta.env.DEV) {
  for (const k of Object.keys(apiProto)) {
    if (typeof (App as any)[k] !== 'function') console.error(`binding missing: ${k}`)
  }
}
```
同类问题：`renderer: any`（marked v15 类型可用）、`demo.ts` 的 `children?: any[]`。
### 11. 对源码字符串做正则断言的测试较脆弱
```ts
const storeSrc = storeSource  // import '../store.ts?raw'
expect(storeSrc).toContain(`setProperty('${name}'`)
```
以及 `styleMdCss` 的 CSS 规则正则匹配。这类"实现细节断言"在重命名/重构时即碎，且不验证行为。作为回归护栏可以保留，但建议：提取常量（如 `CODE_MAX_H_VARS` 数组）让测试导入常量而非扫源码；或改为行为测试（调用 `applySettings` 后断言 DOM style）。
### 12. sanitize 用例双份维护
`scripts/sanitize-check.mjs` 与 vitest 各自维护一份用例表，将来必然漂移。**建议**：把 `HOSTILE_CASES/BYPASS_CASES/BENIGN_CASES` 导出为独立模块（纯数据），两侧共享；或整个迁入 vitest，build 脚本跑 `vitest run sanitize`。
---
## 五、i18n 可维护性
### 13. 单文件 4 语种词典 ≈ 1600+ 行，缺 key 静默回落中文
德语用户遇到缺失 key 会看到中文（`DICTS[lang][key] ?? zhCN[key] ?? key`），且无任何告警。**建议**：
```ts
// 编译期强制四语 key 集合一致
const en: Dict = { ... } satisfies Record<keyof typeof zhCN, string>
```
配合一个 vitest 用例遍历断言四语 key 全等 + 拆分为 `locales/*.json`。这个项目文案量已经到了该工具化的临界点。
---
## 六、性能与细节优化
| 位置 | 问题 | 建议 |
|---|---|---|
| `markdown.ts` `blockedImgUri()` | 每次渲染重新 encodeURIComponent | 按语言缓存（`useMemo` 风格的 Map） |
| `buildFootnotesHtml` | 每个脚注单独 `marked.parse` | 可合并一次解析或保持现状（脚注通常少） |
| `sanitizeSvg` | 大 SVG 主线程同步净化 | 超过阈值（如 256KB）时可显示"渲染中"再异步净化 |
| `editor-bridge.ts` `srcHeadingLines` | 每次全文件 O(n) 扫描 | 大文件可缓存 + 监听 cm change 增量失效 |
| 渲染区常驻 DOM（`v-show`） | 大文档切换文件后旧 DOM 是否释放？ | 确认 store 切换时清空 `store.html`；可对长文加 `content-visibility: auto` |
| `hexEncode` | 逐字节字符串拼接 | `Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('')` |
| `context-menu.ts` | 菜单高度按每项 40px 硬编码估算 | 用 `getBoundingClientRect` 实测后定位 |
---
## 七、工程规范
- **`frontend/README.md` 还是 Vite 脚手架模板** —— 应替换为真实文档（架构图、净化策略、`/mdimg` 回放协议、构建流程），这对后续维护者价值很高。
- **未见 lint 配置**（eslint/biome）—— 建议引入并挂进 `build` 脚本，与 `vue-tsc --noEmit` 并列。
- **`Api` 接口 40+ 方法单文件大接口** —— 可按域拆分（`FileApi/HistoryApi/SettingsApi/WindowApi/ExportApi`），浏览器 mock 也随之分组，降低 `mock.ts` 单文件体积。
- `package.json` 版本声明风格不统一（`highlight.js` 精确钉死 vs `codemirror` 范围）—— 统一策略并写明理由（安全敏感库钉死是合理选择，注释说明）。
---
## 优先级汇总
| 优先级 | 事项 | 类别 |
|---|---|---|
| P0 | 修复 `slCursor` 全局渲染上下文并发污染 | 正确性 |
| P0 | 确认 `imgsrv` 路径白名单校验 + 补路径穿越测试 | 安全 |
| P1 | 升级 TS 5.x，删除 `@types/d3-dispatch` override | 依赖 |
| P1 | katex 统一到 0.16.47+（override dedupe） | 构建/安全 |
| P1 | `remoteAllowed` 补充绕过向量用例 | 安全 |
| P1 | i18n `satisfies` 类型约束 + key 完整性测试 | 可维护性 |
| P2 | dev 模式 bindings 形状校验替代双重断言 | 类型安全 |
| P2 | sanitize 用例表共享 / 迁入 vitest | 测试 |
| P2 | CSP 纵深防御；KaTeX trust 配置确认 | 安全 |
| P3 | 重写 README、引入 lint、Api 按域拆分、细节性能项 | 工程 |
总体而言，这个项目的**安全设计（净化单一来源 + 回归脚本 + 独立净化脚注）和测试习惯是亮点**，最值得投入的下一步是：修掉全局渲染状态的并发隐患、完成 TS 5 升级解除生态锁定、以及给后端文件访问路径补齐穿越测试。
