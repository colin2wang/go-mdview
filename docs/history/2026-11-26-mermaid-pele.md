# 可行性结论
**可以，而且非常契合这个项目。** 我调研了 [obsidianmd/pele](https://github.com/obsidianmd/pele)（Obsidian 团队出的 Mermaid→SVG 渲染器，MIT 协议），它的特性与 mdview 的架构几乎无缝对接：
| 特性 | Pele | 对 mdview 的意义 |
| --- | --- | --- |
| 同步渲染 `render()`，直接返回 SVG 字符串 | ✅ | 现有管线是"拿 SVG 字符串 → sanitize → `innerHTML`"，Pele 比 `await mermaid.render()` 更简单 |
| 主题用 CSS 变量（`--pele-*`），切深浅色**无需重绘** | ✅ | 现在切主题要 `force` 重绘 Mermaid，Ple 可省掉 |
| 输出保证：无 script / 无事件属性 / 无 `<style>` / 无 foreignObject / 文本已转义 | ✅ | 与"DOMPurify 兜底"策略兼容，可继续走现有净化出口 |
| `links:false, images:false` 选项 + scheme 白名单 | ✅ | 完美契合"100% 离线、拦截远程资源"承诺 |
| 体积 ~230KB gzip（vs Mermaid ~2.7MB） | ✅ | exe 增量约 0.7MB，远小于 Mermaid |
| 兼容 Mermaid 12.1.0 语法（`style`/`classDef`/`class`/`:::`/`linkStyle` 都支持） | ✅ | 现有文档基本无需改动 |
| 浏览器全局构建 `dist/pele.global.js`，挂载 `window.pele` | ✅ | 与现有 `/static/mermaid.min.js` 的 `loadScript` 模式一致 |
需要注意的差异（见文末"限制"）：Pele 有自己的视觉风格与布局引擎（`themeVariables` 不生效）；首次渲染 1–2 秒的 Mermaid 解析问题在 Pele 上会消失（毫秒级）。
---
# 修改方案：双引擎 + 全局设置切换
新增设置项 **`mermaidEngine: 'mermaid' | 'pele'`**（默认 `'mermaid'`），渲染期按该值分流；两种引擎共用现有的图形卡片（`.md-diagram`）、源码切换按钮和 DOMPurify 净化管线，用 `data-engine` 标记每个块由谁渲染，切换引擎时自动重绘。
## 1. 引入 Pele 本地文件（离线打包）
下载固定版本到静态目录（与 `mermaid.min.js` 同样方式，exe 内嵌）：
```powershell
# frontend/public/static/pele.global.js（~716KB，gzip 后 ~230KB）
Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/pele@1.13.0/dist/pele.global.js" -OutFile "frontend/public/static/pele.global.js"
```
> **锁死精确版本**（不要用 `@1` 浮动版本）。参考 Tiptap 的做法——Pele 的内部标记会随版本变动。写入 README 的构建说明。
`frontend/src/vendor.ts`（与 `ensureHljs`/`ensureKatex` 同风格）：
```TypeScript
/** Pele 全局构建（window.pele），同步渲染 Mermaid 语法为 SVG。 */
export async function ensurePele(): Promise<any> {
  await loadScript('/static/pele.global.js')
  const pele = (window as any).pele
  if (!pele || typeof pele.render !== 'function') throw new Error('pele unavailable')
  return pele
}
```
`frontend/src/globals.d.ts` 的 `Window` 接口补一行 `pele?: Record<string, any>`。
## 2. 设置项：`types.ts` + Go 侧
**`frontend/src/types.ts`**：
```TypeScript
export type MermaidEngine = 'mermaid' | 'pele'
export interface Settings {
  // ...现有字段...
  mermaidEngine: MermaidEngine
}
export const defaultSettings = (): Settings => ({
  // ...现有字段...
  mermaidEngine: 'mermaid',
})
```
**`internal/mdv/settings.go`** —— ⚠️ **必须加**，否则 Go 侧保存 settings.json 时会把未知字段丢掉，用户的选择每次保存都被重置：
```Go
// Settings 结构体新增：
MermaidEngine string `json:"mermaidEngine"` // "mermaid" | "pele"
// 加载/读取后归一化：旧配置缺省或非法值回退默认引擎
if s.MermaidEngine != "pele" {
    s.MermaidEngine = "mermaid"
}
```
前端所有读取处统一用 `store.settings?.mermaidEngine ?? 'mermaid'` 兜底。
## 3. 净化层：为 Pele 派生专用配置
**关键点**：Pele 的输出与 Mermaid 不同——它**没有 `<style>` 块**，但会把图内 `classDef`/`style` 指令写成**内联 `style` 属性**（且 Pele 自己已做白名单过滤：仅保留 `fill`/`stroke`/`font-weight` 等固定属性，含 `url(`、分号的一律丢弃）。而现有配置 `FORBID_ATTR: ["style"]` 会把 classDef 配色剥掉。因此给 Pele 一个放行 `style` 属性的派生配置。
**`frontend/src/sanitize-common.js`**：
```JavaScript
/** Pele 输出专用配置：Pele 自身保证输出无 script/foreignObject/<style>/事件属性，
 * 且内联 style 仅含白名单属性（classDef 着色依赖它）。在此放行 style 属性，
 * 其余口径与 svgConfig 一致；DOMPurify hook 仍兜底远程引用。 */
export function peleSvgConfig(parts) {
  return {
    ...svgConfig(parts, true),
    FORBID_ATTR: (parts.cfg.FORBID_ATTR ?? ['style']).filter((a) => a !== 'style'),
  }
}
```
**`frontend/src/sanitize-common.d.ts`** 补 `export function peleSvgConfig(parts: SanitizeParts, ): Record<string, any>`。
**`frontend/src/markdown.ts`**（紧挨 `sanitizeMermaidSvg`）：
```TypeScript
/** Pele 输出二次净化：保留 classDef 内联样式（Pele 已按属性白名单过滤），其余同 SVG 严格口径。 */
export function sanitizePeleSvg(code: string): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(DOMPurify, parts, stripSvgExternalRefs(code), state, peleSvgConfig(parts))
  return normalizeSvgRoot(clean)
}
```
**回归用例**（`frontend/scripts/sanitize-check.mjs`，项目已有此验证框架）：
```JavaScript
import { peleSvgConfig } from '../src/sanitize-common.js'
// Pele：classDef 内联样式保留（Pele 已做属性白名单），script 仍删除，远程引用仍拦截
const peleGot = sanitizeWith(
  DOMPurify, parts,
  '<svg class="pele"><g style="fill:#f00;stroke:url(https://e.com/x)"><rect/></g>' +
  '[script 测试样本已脱敏]<image href="https://example.com/i.png"/></svg>',
  createState(true, '', () => '', ''),
  peleSvgConfig(parts)
)
check(
  peleGot.includes('style="fill:#f00;stroke:url(https://e.com/x)"'.replace(';stroke:url(https://e.com/x)','')) ||
  peleGot.includes('fill:#f00'),
  'pele config keeps classDef style',
  `got: ${peleGot}`
)
check(!peleGot.includes('[script 测试样本已脱敏]') && !peleGot.includes('example.com'),
  'pele config still blocks scripts and remote refs', `got: ${peleGot}`)
```
## 4. 渲染分流：`markdown.ts` 的 `renderDiagramsIn`
改造核心函数（提取现有 Mermaid 逻辑，新增 Pele 分支），用 `data-engine` 记账实现"切引擎自动重绘、切主题 Pele 免重绘"：
```TypeScript
export type MermaidEngine = 'mermaid' | 'pele'
let peleSeq = 0
/**
 * 渲染页面中的图形卡片。engine 由设置项 mermaidEngine 决定：
 * - pele：同步 render，CSS 变量驱动主题，切换深浅色无需重绘
 * - mermaid：现有逻辑不变
 * 块级 dataset.engine 记录渲染来源；引擎切换后旧块会自动重绘。
 */
export async function renderDiagramsIn(
  el: HTMLElement,
  dark: boolean,
  force = false,
  engine: MermaidEngine = 'mermaid'
): Promise<void> {
  const blocks = el.querySelectorAll<HTMLElement>('[data-mermaid],[data-svg]')
  if (!blocks.length) return
  if (force) {
    // 主题变了：SVG 块重绘；Mermaid.js 块要换配色重绘；Pele 块走 CSS 变量免重绘
    blocks.forEach((b) => {
      if (b.hasAttribute('data-svg') ||
          (engine === 'mermaid' && (b.dataset.engine ?? 'mermaid') === 'mermaid')) {
        delete b.dataset.done
        b.classList.remove('ok', 'err')
      }
    })
  }
  // ---------- 内联 SVG：与引擎无关，原逻辑不动 ----------
  // （原 data-svg 循环保持不变）
  const mmBlocks = Array.from(el.querySelectorAll<HTMLElement>('[data-mermaid]'))
  if (!mmBlocks.length) return
  if (engine === 'pele') {
    await renderPeleBlocks(mmBlocks, el)
    return
  }
  await renderMermaidBlocks(mmBlocks, dark)   // ← 提取出现有的 mermaid 循环
}
/** 跳过条件：done 且由本引擎渲染的块不再处理；引擎不符时自动重绘。 */
const isDoneBy = (b: HTMLElement, e: MermaidEngine) =>
  b.dataset.done === '1' && (b.dataset.engine ?? 'mermaid') === e
async function renderPeleBlocks(blocks: HTMLElement[], el: HTMLElement): Promise<void> {
  let pele: any = null
  try {
    pele = await ensurePele()
  } catch { /* 下方逐块提示加载失败 */ }
  // 标签字号/字体跟随正文：render() 无容器可读，需显式传字体
  const fontFamily = getComputedStyle(el).fontFamily || 'sans-serif'
  for (const block of blocks) {
    if (isDoneBy(block, 'pele')) continue
    const holder = srcHolder(block)
    if (!holder) continue
    block.dataset.engine = 'pele'
    const code = decodeURIComponent(block.dataset.mermaid ?? '')
    if (!pele) {
      holder.textContent = t('diag.mermaidLoadFailed')
      block.dataset.done = '1'
      block.classList.add('err')
      continue
    }
    try {
      // 离线承诺：禁链接禁图片（Pele 默认允许 http(s)，必须显式关掉）
      // idPrefix 保证同页辅助 ID 唯一；同步返回，无需 await
      const res = pele.render(code, {
        fontFamily,
        idPrefix: `mdv-pele-${++peleSeq}`,
        links: false,
        images: false,
      })
      holder.innerHTML = sanitizePeleSvg(res.svg)
      block.dataset.done = '1'
      block.classList.add('ok')
      block.classList.remove('err')
    } catch (e) {
      // PeleError 的 message/snippet 含图源码 —— 走 escapeHtml，与 textContent 等价
      const msg = e instanceof Error ? escapeHtml(e.message) : ''
      holder.innerHTML =
        `<div class="md-diagram-hint"><div class="md-diagram-hint-text">${escapeHtml(t('diag.mermaidErr'))}` +
        (msg ? ` <code>${msg}</code>` : '') +
        `</div><pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
      block.dataset.done = '1'
      block.classList.add('err')
      block.classList.remove('ok')
    }
  }
}
```
同时把现有 Mermaid 循环的跳过条件改为：
```TypeScript
// 原来：if (block.dataset.done === '1') continue
if (isDoneBy(block, 'mermaid')) continue
// 且渲染成功后补：block.dataset.engine = 'mermaid'
```
> 备选方案 A（零新增净化面）：直接复用 `sanitizeMermaidSvg` 清洗 Pele 输出——代价是 `classDef` 配色被剥掉（`FORBID_ATTR: ["style"]`），很多笔记会掉色。**推荐上面方案 B**。
## 5. 深浅主题 CSS（`style-md.css`）
Pele 图根节点带 `class="pele"`，颜色全部走 CSS 变量——**切换主题即时生效，不用重渲染**：
```CSS
/* ---- Pele 引擎（mermaidEngine = pele）---- */
.md-diagram-src svg.pele { max-width: 100%; height: auto; }
/* 浅色：只用 pele 默认值，背景融入卡片 */
.md-diagram-src svg.pele { --pele-bg: transparent; }
/* 深色：选择器请与 style.css 现有暗色根选择器保持一致（如 .dark / html.dark / [data-theme="dark"]） */
.dark .md-diagram-src svg.pele,
html.dark .md-diagram-src svg.pele {
  --pele-bg: transparent;
  --pele-fg: #e5e7eb;
  --pele-muted: #94a3b8;
  --pele-line: #cbd5e1;
  --pele-surface: #1e293b;
  --pele-surface-alt: #16213a;
  --pele-border: #475569;
  --pele-accent: #60a5fa;
  --pele-critical: #f87171;
}
```
## 6. 设置界面 + i18n
**`SettingsModal.vue`**，放在「阅读」块（`set.defaultView` / `mmMaxLen` 附近），复用分段按钮样式：
```HTML
<div class="set-row">
  <span class="set-label">{{ t('set.mmEngine') }}</span>
  <span class="set-seg" role="radiogroup">
    <button type="button" class="seg-btn"
      :class="{ on: (st?.mermaidEngine ?? 'mermaid') === 'mermaid' }"
      role="radio" :aria-checked="(st?.mermaidEngine ?? 'mermaid') === 'mermaid'"
      data-testid="engine-mermaid" @click="setMmEngine('mermaid')">Mermaid.js</button>
    <button type="button" class="seg-btn"
      :class="{ on: st?.mermaidEngine === 'pele' }"
      role="radio" :aria-checked="st?.mermaidEngine === 'pele'"
      data-testid="engine-pele" @click="setMmEngine('pele')">Pele</button>
  </span>
</div>
<p class="set-hint">{{ t('set.mmEngineHint') }}</p>
```
handler 仿照现有 `setViewModeEvt`/`setFs`：更新 `st.mermaidEngine` → `SaveSettings` → 让 store 的 `applySettings` 触发重绘（若 applySettings 对"需要重绘的键"有白名单，把 `mermaidEngine` 加进去）。
**`frontend/src/i18n.ts`** 四语种：
```TypeScript
// zh-CN
'set.mmEngine': 'Mermaid 渲染引擎',
'set.mmEngineHint': 'Pele 渲染更快、体积更小，深浅主题即时切换；Mermaid.js 为经典渲染器，兼容性最全。',
// en
'set.mmEngine': 'Mermaid engine',
'set.mmEngineHint': 'Pele renders faster with a much smaller bundle and instant theme switching; Mermaid.js is the classic renderer with the broadest compatibility.',
// ja
'set.mmEngine': 'Mermaid 描画エンジン',
'set.mmEngineHint': 'Pele は高速・軽量でテーマ切替が即時反映。Mermaid.js は互換性を重視した従来レンダラー。',
// de
'set.mmEngine': 'Mermaid-Engine',
'set.mmEngineHint': 'Pele rendert schneller, ist deutlich kleiner und passt Farben sofort an; Mermaid.js ist der klassische Renderer mit breiter Kompatibilität.',
```
## 7. `Viewer.vue` 调用点
脚本区（文档中已脱敏）里所有 `renderDiagramsIn(...)` 调用改为传入引擎，并加一个与 `theme` watcher 同模式的监听：
```TypeScript
const mmEngine = (): MermaidEngine => (store.settings?.mermaidEngine ?? 'mermaid')
watch(() => store.settings?.mermaidEngine, () => {
  if (articleEl.value) void renderDiagramsIn(articleEl.value, store.settings?.theme === 'dark', true, mmEngine())
})
```
`renderMarkdown` 返回的 `hasMermaid`（`html.includes('data-mermaid')`）不变——两种引擎共用 `data-mermaid` 卡片，只在渲染期分流。
## 8. 文档
- **README「Rendering Capabilities」**：Mermaid 条目补一句"可在设置中切换 Pele 引擎（更快、CSS 变量主题）"。
- **Known Limitations** 补充：Pele 有独立视觉风格，`themeVariables` 等 Mermaid 主题指令不生效；两者均针对 Mermaid 12.x 语法。
- **FAQ** 补一条"图形渲染异常时试试切换引擎"。
---
# 注意事项与限制
1. **安全管线不放松**：Pele 输出仍过 `stripSvgExternalRefs` + DOMPurify（纵深防御）。同时用 `links: false, images: false` 在源头禁掉远程引用——否则默认放行的 `http(s)` 图片会绕开 `blockRemote` 开关。
2. **引擎切换的状态机**：靠 `dataset.done` + `dataset.engine` 双标记；`force` 只对 Mermaid 块清状态（换主题要重绘），Pele 块永不因主题重绘。
3. **加载失败回退**：`ensurePele()` 失败时逐块提示"Mermaid 库加载失败"文案（复用 `diag.mermaidLoadFailed`）；也可加一级回退：Pele 加载失败自动改走 Mermaid 路径（一行判断的事，建议做）。
4. **体积**：exe 增加约 0.7MB（Pele 全量构建）vs Mermaid 2.7MB，可接受。后续可用 `pele/core` + 按需 `register(flowchart, sequence, …)` 自裁剪构建再压缩，属可选优化。
5. **宽度自适应**：`render()` 不带容器测量；`responsive: true` 默认能让 SVG 收缩适配。若想要"窄屏自动换向/折行"（`maxWidth`、`autoDirection`），可在渲染时传 `holder.clientWidth`（>0 时），并接受不随窗口 resize 重排的 v1 行为。
6. **Mock/浏览器模式**：`/static/pele.global.js` 由 Vite dev server 直接服务，`pnpm dev` 下即可实测。
# 验收清单
- [ ] `pnpm test`、`pnpm run build`（含 sanitize-check 回归）、`go vet ./...`、`go test -race ./internal/mdv/` 全绿
- [ ] demo 文档 `​```mermaid` 块：默认 Mermaid.js 正常；切到 Pele 立即重绘为 Pele 风格；切回 Mermaid.js 正常
- [ ] Pele 下切深浅主题：图形颜色即时变化，无重绘闪烁；Mermaid.js 下切主题仍走 force 重绘
- [ ] Pele 输出内 `classDef` 着色保留；`<script>`/`on*`/远程引用在 sanitize-check 中全部拦截
- [ ] 设置持久化：选 Pele → 重启应用仍为 Pele；旧 settings.json（无此字段）启动后默认 `mermaid` 且保存不丢
- [ ] `data-sl` 同步滚动、图形卡片「源码」切换、复制按钮不受引擎影响
