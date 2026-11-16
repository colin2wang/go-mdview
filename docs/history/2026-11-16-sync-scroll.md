# 同步滚动功能优化方案
## 一、现状梳理（从代码推断）
- **开关**：`Viewer.vue` 中 `syncScroll`（仅 Split 模式显示）；
- **渲染侧**：`.viewer-scroll` 的 `@scroll="onRenderScroll"`；
- **源码侧**：`CodeEditor` 的 `@scroll="onSrcScroll"`，配合 `editor-bridge.ts` 的 `srcHeadingLines()`（正则找标题行）与 `scrollSrcToLine(line)`（`heightAtLine` + `top - 8`）；
- **对齐策略**：README 明确"keeps both panes aligned by **heading anchors**"——即两侧都只按**标题锚点**对齐。
## 二、"不匹配"的根因（按影响排序）
**R1（最关键）：两侧锚点不同源，数量会错位**
源码侧 `srcHeadingLines()` 用裸正则 `/^\s{0,3}#{1,6}(\s|$)/`，而渲染侧 TOC 用 `marked.lexer` 提取。两者必然分歧：
- **误报**：代码块内的 `#` 注释行被当成标题——你的 `DEMO_MD` 里就有现成例子（yaml 块中的 `# ✅ 推荐姿势…`、`# JVM 侧`）；
- **漏报**：setext 标记式标题（`标题` 下一行 `===`）、引用/列表内的 `> # 标题`、`- # 标题`。
  锚点一旦多一个或少一个，**逐对索引对齐从错位点开始全部漂移**——这正是"越往后越不准"的典型表现。
  **R2：标题粒度太粗，段内比例漂移**
  渲染侧一段可能被表格、KaTeX、Mermaid、图片撑到几千像素，源码侧只有几行；只按"最近标题"对齐，段内滚动时另一侧几乎不动或整段跳变。
  **R3：双向同步的回声/震荡**
  两个 scroll handler 互相触发，无"程序化滚动锁"，表现为抖动、追不上。
  **R4：异步布局变化使偏移失效**
  Mermaid/KaTeX 在 HTML 插入后异步渲染、图片 `loading="lazy"` 加载后高度变化，`offsetTop` 全部移动，而同步用的偏移量是旧值。
  **R5：细节偏差**
  源码侧 `behavior:'smooth'` vs 渲染侧直接 `scrollTop`；魔法数 `top - 8` 与 CSS `scroll-margin-top: 24px` 不一致；`heightAtLine(…,'local')` 坐标系与 scroller 的对应关系；文章 `padding-bottom: 55vh/60vh` 造成"滚到底"两侧不齐；无标题文档没有回退策略。
  **R6：预处理改行数**
  `preprocess()` 会摘除脚注定义行——若行号在预处理后的 md 上计算，与编辑器显示的原始行号错位。
## 三、方案总览
| # | 方案 | 修复 | 成本 |
|---|------|------|------|
| 1 | 锚点同源化：一次 lexer 同时产出 TOC + 源码行号 | R1/R6 | 低 |
| 2 | 标题级 → **段内线性插值** | R2 | 低 |
| 3 | （推荐）块级 `data-sl` 锚点 | R2 彻底 | 中 |
| 4 | 同步锁 + 回声抑制 + rAF 节流 | R3 | 低 |
| 5 | 偏移失效与重建机制 | R4 | 低 |
| 6 | 体验细节统一 | R5 | 低 |
## 四、落地代码
**① 锚点同源化（`markdown.ts`）**——让 TOC 与行号出自同一次遍历，天然 1:1 配对：
```ts
interface SrcAnchor { line: number; id: string }
// 与现有 TOC walk 合并为一个函数，同时产出 toc 和 anchors
function walkTokens(tokens: any[], md: string, cursor: { i: number },
                    slugFn: (s: string) => string,
                    out: { toc: TocItem[]; anchors: SrcAnchor[] }) {
  for (const tk of tokens) {
    if (tk.type === 'heading') {
      const idx = md.indexOf(tk.raw, cursor.i)
      if (idx >= 0) {
        cursor.i = idx + tk.raw.length
        const line = md.slice(0, idx).split('\n').length - 1   // 0 基行号
        const id = slugFn(plainText(tk.tokens))
        out.toc.push({ id, text: plainText(tk.tokens), depth: tk.depth })
        out.anchors.push({ line, id })
      }
    }
    if (tk.tokens?.length) walkTokens(tk.tokens, md, cursor, slugFn, out)  // 覆盖引用/列表内标题
  }
}
```
配套两件事：
- `preprocess()` 摘除脚注定义行时**置空该行而不是删除**，保住行数（修 R6）；
- `RenderResult` 增加 `anchors`，经 store 传给 Viewer。
> 若暂不想动 lexer，至少给 `srcHeadingLines()` 加 fence 跟踪作为止血：
> ```ts
> let fence: string | null = null
> for (let i = 0; i < cm.lineCount(); i++) {
>   const l = cm.getLine(i) ?? ''
>   const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l)
>   if (f) { fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]; continue }
>   if (fence) continue
>   if (/^\s{0,3}#{1,6}(\s|$)/.test(l)) out.push(i)
> }
> ```
**② 比例插值 + 双向同步（新文件 `sync.ts`）**——段内连续跟手（修 R2/R3）：
```ts
let marks: { y: number; s: number }[] = []   // y=渲染侧offsetTop, s=源码侧px
let dirty = true
export const invalidate = () => (dirty = true)
function rebuild(cont: HTMLElement, baseTop: number, cm: CodeMirror.Editor, anchors: SrcAnchor[]) {
  marks = anchors.map(a => {
    const el = cont.querySelector(`[id="${CSS.escape(a.id)}"]`)
    return el ? { y: el.getBoundingClientRect().top - baseTop + cont.scrollTop,
                  s: cm.heightAtLine(a.line, 'local') } : null
  }).filter(Boolean).sort((a, b) => a.y - b.y)
  dirty = false
}
function interp(pos: number, key: 'y' | 's'): number | null {
  if (!marks.length) return null
  const o = key === 'y' ? 's' : 'y', n = marks.length
  const seg = (i: number, j: number) => {
    const d = marks[j][key] - marks[i][key]
    return d <= 0.5 ? marks[i][o] : marks[i][o] + (pos - marks[i][key]) / d * (marks[j][o] - marks[i][o])
  }
  if (pos <= marks[0][key]) return seg(0, Math.min(1, n - 1))          // 首段外推
  if (pos >= marks[n - 1][key]) return seg(Math.max(0, n - 2), n - 1)  // 尾段外推
  for (let i = 0; i < n - 1; i++) if (pos <= marks[i + 1][key]) return seg(i, i + 1)
  return marks[n - 1][o]
}
```
双向 handler（两侧对称），带锁与回声抑制：
```ts
const ALIGN = 24            // 与 CSS scroll-margin-top 统一，替换 top-8 魔法数
let lockUntil = 0
const lastTarget = { src: -1, rd: -1 }
function onRenderScroll() {                     // rAF 节流
  if (raf.rd) return
  raf.rd = requestAnimationFrame(() => {
    raf.rd = 0
    if (!syncScroll.value || !isSplit.value) return
    if (dirty) rebuild(...)
    const st = renderScrollEl.value!.scrollTop
    if (Date.now() < lockUntil) return
    if (Math.abs(st - lastTarget.rd) < 2) return    // 编程滚动回声
    const t = interp(st + ALIGN, 'y'); if (t == null) return
    lockUntil = Date.now() + 80
    lastTarget.src = t
    scrollSrcToPx(t)
  })
}
```
```ts
// editor-bridge.ts：像素级滚动，距离大才 smooth，避免平滑叠加"追不上"
export function scrollSrcToPx(px: number, smooth = false): void {
  const cm = srcEditor.cm; if (!cm) return
  const sc = cm.getScrollerElement()
  const top = Math.max(0, Math.min(px - ALIGN, sc.scrollHeight - sc.clientHeight))
  if (smooth && Math.abs(sc.scrollTop - top) > 400) sc.scrollTo({ top, behavior: 'smooth' })
  else sc.scrollTo(0, top)
}
```
**③（推荐）块级锚点：精度到段落**——在 renderer 的块级方法里注入源码行号：
```ts
const withSl = (tk: any, html: string): string => {
  const i = md.indexOf(tk.raw, cursor.i)
  if (i < 0) return html
  cursor.i = i + tk.raw.length
  const line = md.slice(0, i).split('\n').length - 1
  return html.replace(/^<([a-zA-Z]+)/, `<$1 data-sl="${line}"`)
}
// 应用到 heading/paragraph/blockquote/code/table/list 渲染器
```
marks 改为 `article.querySelectorAll('[data-sl]')` 全量块级对齐点，段内映射精确到块。注意 DOMPurify 默认 `ALLOW_DATA_ATTR: true` 会放行 `data-*`；若 `sanitize-config.json` 显式关过需加回。
**④ 失效与重建（修 R4）**：
```ts
const ro = new ResizeObserver(() => invalidate()); ro.observe(articleEl.value!)
article.addEventListener('load', () => invalidate(), true)   // 捕获阶段接 img load
// renderDiagramsIn(...) 完成后 invalidate()
```
**⑤ 体验细节（修 R5）**：
- 无标题文档：退化为全局线性比例，或禁用按钮并提示；
- 只在 split 且两侧可见时同步，退出 split 清 pending rAF 与锁；
- TOC 高亮（`store.activeHeading`）与同步滚动**共用同一套"当前标题"检测**，避免两个实现各自漂移、互相矛盾；
- 跳变 < 4px 不动作，减少抖动。
## 五、验证
- **单测（vitest）**：`anchors.length === toc.length` 恒等；用例覆盖 yaml 块内 `# 注释`（DEMO_MD 现成）、setext 标题、`> # 标题`、`- # 标题`、同名标题 ×3；
- **e2e（Playwright）**：split + sync 开启 → 滚轮渲染侧至第 3 个标题，断言源码 `scrollTop` 距 `heightAtLine(line3)` < 40px；反向同理；
- **手测清单**：纯文本短文（回退路径）/ 大表格 / Mermaid / 含脚注文档（验证保行数）。
## 六、预期
①+②+④ 三项做完即可解决九成"不匹配"：锚点永不错位、段内连续跟手、无抖动；③ 上线后达到 Typora 级逐段对齐精度。
