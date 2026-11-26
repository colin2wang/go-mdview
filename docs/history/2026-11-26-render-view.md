# 同步滚动对齐：完整优化方案（合并版）

> 合并自 `2026-11-26-render-view.md`（v1 原始方案）与 `2026-11-26-render-view-v2.md`（钉底问题修正）。
> 文档以**最终实现状态**为准：v1 的内容坐标建模已被 v2 取代，marked v15 相关接线与 v1 原文不同。
> 实施状态：代码全部完成，待人工验收。

## 一、问题定位（七个根因的全景）

| # | 根因 | 表现 | 修复 |
|---|------|------|------|
| R2 | 只按标题粒度对齐 | 大表格/Mermaid/KaTeX 段内滚动另一侧不动或跳变 | 块级 `data-sl` + 段内线性插值 |
| R3 | 双向滚动回声震荡 | 抖动、追不上 | rAF 节流 + 同步锁 + 回声阈值 |
| R4 | 异步布局使锚点表失效 | Mermaid 渲染完/图片加载后整体漂移 | 失效源接线 + 滚动前重建 |
| R5 | `top-8` 魔法数、无差别 smooth | 细节偏差 | `SCROLL_ALIGN` 统一 + 距离大才 smooth |
| ① | 源码侧几何变化不触发重建 | 切 codeWrap/拖侧栏/缩放后源码刻度漂移 | 补全失效源（v2 核心） |
| ② | CM5 未测量行用估算行高 | `heightAtLine` 刻度整体漂移 | `viewportMargin: Infinity` + 重建前校准 |
| ③ | 个别锚点行号漂移致 s 乱序 | 尾段斜率被拉爆 | 单调性过滤剔除乱序点 |
| ④ | 渲染侧 55vh 底部死区 | 放大①②的刻度误差（放大器非根因） | 收敛到 18vh |

**v2 的关键洞察**：两个方向是同一张 marks 表的互逆映射，只有「映射的源码侧刻度被整体放大」一种解释能同时解释「渲染→源码提前钉底（钳位）」与「源码→渲染看起来正常」。钳位还会把错误**静默化**——不报错、不自愈。

## 二、最终架构：`sync.ts` v2

- **锚点存滚动位置而非内容坐标**，端点固定 `(0,0)`–`(R,S)`：两侧滚到底必然互为镜像，钳位语义与映射语义一致，刻度漂移不再表现为「提前钉底」。
- **重建前校准**：`sourceGeometrySuspicious()` 比对 `heightAtLine` 文档底与 `scroller.scrollHeight`，差值超过 `max(240, 行高×12)` 判定过期，返回 `stale` → Viewer 调 `cm.refresh()` 重测，下一帧重建。
- **单调性过滤**：滚动单调 ⇒ s 必须随 y 递增，乱序点剔除并计入 `dropped`（诊断出口可查）。
- **interpIn** 分段线性插值（段内插值、端点外推、退化段防抖）为纯函数，已单测；`activeHeadingId()` 供标题高亮，替代逐帧 querySelectorAll。
- API：`renderToSource` / `sourceToRender` / `invalidateSync` / `resetSyncState` / `syncDiagnostics`（dev 下挂 `window.__syncDiag()`）。

## 三、各文件改动要点

1. **`markdown.ts`** — `withSl` 注入：heading/code 用自身 renderer 输出包裹；paragraph/blockquote/table **内联复刻 marked v15 默认输出**（见「坑位」）；行号用 `token.raw` 游标法 + `preprocess.lineMap` 回映射，与 TOC 锚点同源 1:1。
2. **`editor-bridge.ts`** — `SCROLL_ALIGN = 24`（对齐 `style-md.css` 的 `scroll-margin-top`）；`scrollSrcToPx(px)` 入参为滚动位置，返回 `{ top, clamped }` 让钳位可感知；距离 >400px 才 smooth。
3. **`Viewer.vue`** — `ensureMarks()` 处理 `stale`；handler v2（rAF 节流 + 80ms 同步锁 `lockUntil` + lastSet 回声阈值 <2px）；**饱和自愈**：`clamped` 且渲染 <85% 高度 → 800ms 节流强制重建；编辑态单向「源码→正文」不变；`rememberRender` 记账与 `mirror()` 兜底保留。
4. **失效源全集**（R4+①）：渲染侧 article 的 ResizeObserver + `load`/`error` 捕获、源码侧 `srcPaneEl` 的 RO、`store.html`/fontSize/**codeWrap/lineNo**/editing/path watch、window resize、isSplit/同步开关切换（清状态后等两帧再建）。
5. **`CodeEditor.vue`** — `viewportMargin: Infinity`（根治②）。
6. **`style-md.css`** — `.md-article.in-split` 底部 `55vh → 18vh`（修复④）。

## 四、实施中发现的坑（重要）

- **marked v15 UMD**：`new marked.Marked()` 在该 UMD 全局上不可用（`Marked is not a constructor`）；`marked.defaults.renderer` 在 `marked.use()` 之前是 `null`（`Cannot read properties of null`）。委托内部对象的路线不通，默认块级输出只能内联复刻。
- **`defaults.renderer` 不能对象展开**：它是 `Renderer` 类实例，方法在原型上，`{ ...instance }` 拷不到（曾导致表格直接消失）。
- **NodeListOf 不能 for-of**：项目 tsconfig 未开 `downlevelIteration`，需 `Array.from()` 包装。
- 文档手稿里的 `store.anchors` 实际是 `store.srcAnchors`；`renderDiagramsIn` 回调未直接接 `invalidateSync`，由渲染侧 RO + load/error 监听等效覆盖。

## 五、30 秒定位（复现状态下 DevTools Console）

```js
const rd = document.querySelector('[data-testid="viewer-scroll"]');
const sr = document.querySelector('.CodeMirror-scroll');
const R = rd.scrollHeight - rd.clientHeight, S = sr.scrollHeight - sr.clientHeight;
rd.scrollTop = R * 0.3;
setTimeout(() => console.log('render%', rd.scrollTop / R, 'source%', sr.scrollTop / S), 120);
// 多测几组：source% 明显大于 render% 且提前到 1 → 源码刻度被放大
// 切 设置→代码块自动换行 后再试 → 行为变化 = 失效盲区实锤
```

打完补丁仍偶发钉底时：`__syncDiag()` 看 `dropped`（非零 = 成因③行号漂移，查 `lineMap`/游标偏移点）与 `sourceContentBottom`/`sourceMax` 差值（>~200px = 几何仍漂移）。

## 六、验收清单

- [ ] 渲染滚到 30% / 60% / 90%，源码位置单调递增且不提前钉底（用第五节脚本复核）
- [ ] 渲染滚到底 ↔ 源码滚到底，双向同步（新端点保证）
- [ ] 切换 codeWrap / 拖侧栏 / 缩放窗口后立即滚动——不出现钉底（失效盲区闭合）
- [ ] 字体加载完成后的首次同步仍准确（校准 + refresh 兜底）
- [ ] 快速来回甩动无震荡（锁 + 回声逻辑）
- [ ] 大 Mermaid 文档渲染后滚到图下方段落，两侧偏差 < 半屏
- [ ] 编辑草稿时预览与源码仍跟手（anchors 随 renderDraft 更新）
- [ ] 纯文字短文/无标题文档：退化为顶底两点线性映射，仍大致跟手
- [ ] `__syncDiag()` 中 `sourceContentBottom` 与 `sourceMax` 差值 < ~200px
