# go-mdview 代码评审与优化建议

> 评审对象：go-mdview（Wails v2 + Go 1.25 / Vue 3 + TS 桌面 Markdown 阅读器）
> 代码规模：前端 TS+VUE 约 4677 行、CSS 约 2014 行、Go 约 1100 行，共 51 个文件
> 说明：源文档中有 133 处函数体以「… N lines …」折叠（集中在 store.ts / mindmap.ts / app.go / markdown.ts），
> 因此结论基于可见代码与接口/注释推断，涉及折叠函数体的条目已标注「待确认」。

---

## 一、总体评价

**这是一个完成度相当高的项目。** 分层干净，工程质量明显高于同类练手项目：

| 维度 | 表现 |
| --- | --- |
| 分层 | `internal/app`（Wails 绑定层，只做转发）与 `internal/mdv`（纯领域逻辑，可单测）分离得当 |
| 写盘可靠性 | settings/history/favorites 与正文保存全部走「临时文件 + rename」原子写，GB18030 原编码回写 |
| 平台细节 | 窗口几何换算（相对坐标 vs 绝对坐标）、单实例锁 + 重启标志、注册表 HKCU 关联回滚、`notifyShell` 刷新图标——都是踩过坑才写得出来的代码 |
| 注释密度 | 关键决策（为什么重建 watcher、为什么关 gitHubSpice、为什么按比例记账滚动）都写清了原因 |
| 交互完成度 | 对照模式锚点映射、思维导图左右平衡布局、外部修改监视防抖、文件消失确认弹窗，都属于"做深了"的部分 |

**主要短板集中在三处**：① 用正则实现的 HTML sanitizer（安全模型不可靠）；② 大文档与滚动/设置路径上的性能无节流、无缓存；③ Viewer.vue 单文件 847 行 + 若干跨组件全局查询与模块级可变状态，复杂度已到该收敛的临界点。

---

## 二、P0：安全（建议优先处理）

### 2.1 正则 sanitizer 可被绕过 —— 这是全项目最严重的问题

`frontend/src/markdown.ts` 的 `sanitizeHtml()` 用 5 条正则过滤 `<script>/<iframe>/<object>/<embed>`、`on*`、`javascript:/vbscript:` 协议。字符串级黑名单天生无法对抗 HTML 解析器，实测可绕过：

```js
// 用项目自带的 sanitize-check.mjs 中的同一份实现跑的实测结果
'<a href="&#106;avascript:alert(1)">click</a>'
→ 原样保留   // HTML 实体在属性解析阶段解码 → 点击执行 JS ✅绕过

'<a href="jav&#x09;ascript:alert(1)">click</a>'
→ 原样保留   // 制表符实体同样绕过 ✅绕过

'<button formaction="javascript:alert(1)">go</button>'
→ 原样保留   // formaction 不在过滤名单 ✅绕过

'<meta http-equiv="refresh" content="0;url=https://evil.tld">'
→ 原样保留   // 自动跳转外站 ✅绕过

'<base href="https://evil.tld/">'
→ 原样保留   // 劫持页面内所有相对路径 ✅绕过

'<style>body{background:url(https://evil.tld/beacon)}</style>'
→ 原样保留   // 外发请求，且与"100% 离线"承诺冲突 ✅绕过

'<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>'
→ 原样保留   // 非 xlink:href/常规属性名 ✅绕过

'<img src="https://evil.tld/track.png">'
→ 原样保留   // 远程图片直接加载 ✅绕过
```

**影响**：打开一份来源不明的 `.md`（这正是阅读器的典型用法），即可在本机 WebView 里执行脚本，进而通过 `window.go.main.App.*` 调用 `ReadMarkdown`/`SaveMarkdown`/`RevealInShell` 等绑定方法 —— 形成「读一个文件 → 任意读写本地文件」的链路。

**建议**（按推荐度排序）：
1. **换用 DOMPurify**（本地 vendor 一份，约 45KB gzip 前，无网络依赖），在 `v-html` 前对最终 HTML 做一次 `DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true } })`；DOMPurify 走真实 DOM 解析，能正确处理实体、mXSS、命名空间问题。
2. 若坚持零依赖：至少把 `marked` 的 HTML 通道关掉（`marked` 默认放行原始 HTML，可改用其 sanitize 选项或在自定义 renderer 里对 `html` token 转义），只允许经过显式白名单的结构。
3. 兜底隔离：把正文渲染进 `sandbox` iframe（`allow-scripts` 关掉），或在 WebView2 层限制。

**顺带修掉 `sanitize-check.mjs` 的两个测试缺陷**：
- 第 10 条用例 `['', '', '本地回放图片不受影响']` 输入输出都是空串，名字与内容不符，等于没测；
- 用例集没有覆盖上面任一绕过向量，建议把 8 条 payload 直接补成回归用例。

### 2.2 内联 SVG 走 `v-html`，攻击面比 `<img>` 大

- `ImageLightbox.vue`：`v-html="svg"` 把 Mermaid/SVG 卡片原文插进主文档（SVG 内联时脚本**会**执行，与 `<img src=x.svg>` 上下文不同）。
- `markdown.ts` 的 `sanitizeSvg()` 同样是正则实现。

建议：SVG 卡片一律经 DOMPurify（或用 `img` + data URL 呈现，代价是不能交互）；灯箱里如需交互再走白名单。

### 2.3 本地图片路由允许任意绝对路径

`internal/mdv/imgserver.go` 的 `/mdimg/{hex(绝对路径)}` 只校验「必须是绝对路径」，随后 `os.ReadFile(p)`。hex 编码确实规避了路径穿越，但**不限制范围** —— 恶意 md 里放一张指向 `C:\Users\xxx\.ssh\id_rsa` 或 `%AppData%\mdview\settings.json` 的图，就能把它渲染出来（配合 `<canvas>` + 外发可进一步泄漏）。

建议：把可读范围限制在「当前打开文件所在目录树 / 已打开的根目录」内，越界返回 403。

### 2.4 远程资源与「100% 离线」承诺不一致

README 宣称 `network-100% local`、`no network`，但渲染管线对远程图片、远程字体、`@import` 一律放行。结果：打开一份带追踪像素的笔记就会外发请求（泄漏 IP 与"你在读这个文件"的事实）。

建议：Settings 增加「阻止远程资源」开关（默认开），渲染时把非 `data:`/`/mdimg/` 的 `src` 替换成占位；并把这条如实写进 README。

### 2.5 导出 HTML 的转义不完整

`internal/mdv/export.go`：标题只替换了 `<`（`strings.ReplaceAll(title, "<", "&lt;")`），`&`、`>`、`"` 未处理；正文 `html` 直接拼接（依赖前端已 sanitize，与 2.1 是同一条信任链）。

建议：Go 侧用 `html.EscapeString(title)`，正文在导出前同样过一遍清洗。

---

## 三、P1：正确性与并发

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 3.1 | `internal/mdv/store.go` `base()` | **数据竞争**：`base()` 读写 `s.baseDir` 全程无锁，注释里说"加锁会造成不可重入死锁"——那是因为 `writeJSON` 内部会调 `base()`。Wails 绑定方法由不同 goroutine 并发进入，两个首次调用可能同时写 `baseDir` 并 `MkdirAll` | 用 `sync.Once`（或 `sync.OnceValues`）在 `NewStore()` 里确定 `baseDir`，彻底消除写路径 |
| 3.2 | `internal/app/app.go` `startupFile` | 包级 `var`，`SetStartupFile` 由单实例回调 goroutine 写、`GetStartupFile` 由前端绑定 goroutine 读，无同步 | 改 `atomic.Pointer[string]` 或加 mutex |
| 3.3 | `internal/mdv/readfile.go` `SaveMarkdown` | rename 失败回退 `os.WriteFile` 时，`return FileContent{}, err` 返回的是 **rename** 的错误，把真正失败的写入错误 `werr` 吞掉了 | 返回 `werr` |
| 3.4 | 同上 | `SaveMarkdown`、`ReadMarkdown` 与 watcher 的 `MarkSaved`/`watcherCheck` 之间没有统一锁，用户点保存的同时外部事件到达，可能出现"刚写完又被自己触发的事件重载一遍"（虽有 2s 抑制窗口兜底，但不严谨） | 在 `Store` 上用 `mu` 串行化"读-写-标记保存"三步 |
| 3.5 | `frontend/src/mindmap.ts` | `MAX_CHARS`、`__uid` 是**模块级**全局；`createMindMap` 里 `if (opts.maxLen...) MAX_CHARS = ...` 会永久改写全局默认值，后续未传 `maxLen` 的实例会继承上一次的值（真实 bug） | 把 `MAX_CHARS` 收进 controller 闭包，`__uid` 同理 |
| 3.6 | `Viewer.vue` 切换文件 watch | `draft.value = editing.value ? sourceText.value : ''` —— 切换文件时若仍在编辑态，直接把**新文件**内容当草稿继续渲染，与注释"切换文件即还原"语义相悖 | 切文件应无条件 `editing = false` |
| 3.7 | `Viewer.vue` `watch(() => store.html)` | 渲染是异步的，但 watch 回调没有渲染序号（store.ts 的 `renderDraft` 有 `draftSeq`，这里没有），快速连续切文件会出现"旧渲染晚到 → 覆盖新内容/滚动位置" | 引入 `renderSeq` token，回调内比对后再落地 |
| 3.8 | `CodeEditor.vue` | `applying` 标志用 `try{}` 包裹 `setCursor` 但整体没有 `finally`，异常时 `applying` 永久为 true，编辑器后续输入不再回传 | 改 `try/finally` |
| 3.9 | `MindMap.vue` `exportPng` | `URL.revokeObjectURL(url)` 只在成功路径调用，`drawImage` 抛错时 blob 泄漏 | 放 `finally` |
| 3.10 | `main.go` | 重启靠 `time.Sleep(1200ms)` 等旧进程释放单实例锁——慢机器上仍可能失败 | 改成轮询探测锁/用 --wait 参数由新进程自己重试 |

---

## 四、P2：性能

### 4.1 滚动路径每帧都在做 O(n) DOM 查询（最明显的卡顿源）

`Viewer.vue`：
- `spyHeading()`：每次 scroll 事件 `querySelectorAll('h1[id]..h6[id]')` 重建数组，再逐个读 `offsetTop`（强制同步布局）；
- `rebuildAnchors()`：对每个标题 `getElementById` + `getBoundingClientRect` + `cm.heightAtLine()`，**交替读写** → 布局抖动；
- `onRenderScroll` / `onSrcScroll` 直接挂在原生 scroll 事件上，无 rAF 节流。

建议：
1. 渲染完成后一次性缓存标题元素数组（`afterRender` 里收集），滚动时只读缓存 + 用二分查找定位当前标题；
2. scroll 处理统一走 rAF 节流（一帧最多算一次）；
3. 高亮改用 `IntersectionObserver`（`rootMargin` 控制激活线），几乎零成本；
4. 锚点表在渲染后建一次，只在内容/尺寸变化时失效重建，不要在每次滚动时 `useAnchors()` 兜底重建。

### 4.2 编辑与主题切换触发整篇重渲染

- `onDraftInput` 300ms 防抖后调用 `renderDraft` 全量重解析 + `v-html` 整体替换 → 大文档每次输入都重建整棵 DOM（Mermaid/数学/代码高亮全部重来）。
- 切主题对整个 article 重绘所有图形。

建议：
1. 大文档（>2000 行）把防抖提到 500–800ms，或改为「停止输入后渲染」；
2. 长文档按标题块切片渲染（`IntersectionObserver` 懒挂载），或把 `marked` 解析放进 Web Worker，主线程只做 `v-html` 替换；
3. 主题切换只重绘图形卡片，不要重建正文。

### 4.3 大文件没有降级策略

- Go 侧上限 32MB（`maxReadSize`），整文件读入内存后经 Wails JSON 序列化传到 WebView —— 几十 MB 字符串在 IPC + DOM 里各存一份，实际占用会翻数倍；
- CodeMirror 5 对超大文本的行数计算、`setValue`、gfm 模式解析都会明显卡顿。

建议：把软上限降到 2–5MB，超过时提示"仅渲染，源码/编辑/导图已停用"；必要时对超大文件分段读取（`ReadMarkdownRange`）。

### 4.4 目录扫描与 wiki 链接解析没有缓存

- `ListTree` 每次打开目录/刷新都全量递归；
- `FindByTitle`（`[[wiki link]]`）每次点击都递归 12 层遍历整个 vault。

Obsidian 库动辄几千文件，这两处是肉眼可见的卡顿。建议：在 `mdv` 里维护一份「根目录 → 文件名索引」缓存，用已有的 `fsnotify` watcher 增量更新（`watcher.go` 基础设施已具备，扩展即可）。

### 4.5 图片路由每次全量读文件

`imgserver.go` 用 `os.ReadFile` 把整张图读进内存再 `w.Write`，且只有 `Cache-Control`，没有 `ETag`/`Last-Modified`，大图反复滚动会重复读取。

建议：改用 `http.ServeContent`（自带 Range、条件请求、正确头部）；顺带用手写 `itoa()` 换成 `strconv.Itoa`（现在这个函数是纯粹的重复造轮子）。

### 4.6 设置滑块每动一格就落盘一次

`SettingsModal.vue` 的 `fontSize` / `mmMaxLen` 是 `range` + `@input` → 每次拖动都 `patchSettings` → Go 端 `writeJSON`（temp + rename）。一次拖动产生几十次磁盘写。

建议：`@input` 只更新内存与 CSS 变量，`@change`（松手）再落盘；或加 150ms 防抖。

### 4.7 复制按钮把代码全文塞进 HTML 属性

从 `Viewer.vue` 的 `onArtClick` 看，`button[data-copy]` 的 `data-copy` 内嵌了 `encodeURIComponent(代码全文)`，等于每个代码块的内容在 DOM 里存两份（`<pre>` 里一份、属性里一份）。

建议：改为事件委托 + 索引（`data-copy-idx`），点击时从对应 `<pre>` 的 `textContent` 取值，或用 `navigator.clipboard` 配合选中区域。

### 4.8 Mermaid 2.7MB 同步 script 注入

`vendor.ts` 的 `loadScript` 同步阻塞，首次触发时 1–2s 卡顿（README 已承认）。建议：应用启动后空闲时 `requestIdleCallback` 预加载；或把 mermaid 换成 ESM 动态 `import()`，保证失败可重试、可取消。

---

## 五、P3：架构与可维护性

### 5.1 Viewer.vue 847 行，已经该拆了

它同时承担：视图模式状态机、分栏拖拽、锚点映射、编辑草稿生命周期、滚动记忆、图形/公式补充渲染、灯箱、右键菜单、导出、统计。建议拆成 composables：

```
composables/
  useSplitPane.ts      // 分栏比例 + 拖拽
  useScrollSync.ts     // 锚点表、镜像、justMirrored
  useSourceDraft.ts    // editing / draft / 防抖重渲染 / 保存
  usePostRender.ts     // mermaid / katex / 图形卡片
  useArticleActions.ts // 点击、右键菜单、灯箱
```

### 5.2 跨组件用全局选择器取 DOM，耦合脆弱

`TocPanel.vue` 里 `document.querySelector('[data-testid="viewer-scroll"]')` 直接找 Viewer 的滚动容器。`data-testid` 本是测试钩子，被当成运行时契约用。

建议：把渲染滚动容器与源码 scroller 通过 `provide/inject` 或一个 `scrollBus` 模块共享（Viewer 已经有 `renderScrollEl` ref）。

### 5.3 模块级可变单例过多

`srcEditor`（editor-bridge）、`menuState`（ContextMenu）、`status`、`store`、`mindmap` 的 `MAX_CHARS/__uid`、`api.ts` 的 `current`。当前"同时只有一个窗口/一个编辑器"的假设成立，但任一处想做多标签页/多窗口就会全线崩塌。

建议：至少把 `mindmap` 的全局（5.5 的 bug 源头）和 `status` 收敛到组件/组合式作用域；其余保留但写清"单实例假设"。

### 5.4 重复实现（同一件事两套代码）

| 能力 | 位置 A | 位置 B |
| --- | --- | --- |
| 标题行扫描 | `editor-bridge.ts` `srcHeadingLines()`（按序号取行） | `Viewer.vue` `matchHeadingLines()`（按标题文本匹配） |
| HTML 转义 | `markdown.ts` `escapeHtml` | `vendor.ts` `highlightCode` 内的 `esc` |
| 路径拼接/取基名 | `markdown.ts` `joinPath` | `demo.ts` `fileBase/fileToDir` |
| 图片扩展名表 | `fsops.go` `imgExts` | `imgserver.go` `contentTypeByExt`（两张表各自维护，新增格式必漏一处） |

建议：标题定位统一到一处（推荐 `editor-bridge`，按文本匹配更稳），扩展名表收敛为「ext → mime」单表，前端 escape 提一个 `html.ts`。

### 5.5 死代码 / 未使用导出

`fileKind`、`isFav`（store.ts）、`resolveMdHref`（markdown.ts）、`mockState`、`dispatchMockOpenFile`（mock.ts）在可见代码中均无调用点（若折叠区有引用请忽略本条）。确认真未使用后删除，或补上对应测试。

### 5.6 Api 接口靠手写同步，会漂移

`api.ts` 的 `Api` 接口 + `desktopApi()` 30 多个方法是手工对照 Go 绑定维护的，改一个签名两端都要改且不会报错。

建议：用 `wails generate module` 生成 TS 绑定与模型，前端只做「薄封装 + mock 注入」，类型漂移在编译期就暴露。

### 5.7 CodeMirror 5 已停止维护

CM5（+ gfm/xml/markdown/javascript/css/clike/python/go/shell 模式 + active-line addon）是不小的包体，且不再有安全更新。中长期建议迁移 CodeMirror 6（tree-shaking 更彻底、大文档性能显著更好、原生 TS）。短期至少确认：只 import 用到的 mode，避免 `codemirror/mode/meta` 之类全量引入。

### 5.8 其他

- **mock.ts 硬编码了真实用户路径** `C:\Users\wangb\OneDrive\Obsidian\...`（开发者机器目录 + 真实用户名），建议改成 `C:\\demo\\vault` 之类占位，避免个人信息进仓库。
- **构建工具不一致**：README 说用 `pnpm`，`wails.json` 的 `frontend:install` 却是 `npm install`，容易装出两套 lockfile。统一为 pnpm。
- **i18n.ts 777 行**堆在一个文件里，4 语言 × 数百 key；建议拆成 `locales/*.json` + 类型化 key（`t()` 目前接受裸字符串，拼错不报错）。
- **测试覆盖**：前端只有一个 `sanitize-check.mjs`（11 个用例，其中一个还是空用例）；Go 侧 README 提到 `internal/mdv/*_test.go` 但本次文档未包含。至少应为 `preprocess`、`naturalLess`、`encode/decode 往返`、`resolveImgHref`、锚点插值这些纯函数补单测——它们正是重构安全网。

---

## 六、执行清单（按投入产出排序）

| 优先级 | 事项 | 预估工作量 | 收益 |
| --- | --- | --- | --- |
| P0 | 引入 DOMPurify 替换正则 sanitizer + 补齐绕过用例 | 0.5–1 天 | 堵住任意文件读写的攻击链 |
| P0 | 图片路由限制在已打开目录树内 | 2 小时 | 堵住任意文件读取 |
| P0 | 远程资源开关（默认拦截） | 0.5 天 | 兑现"100% 离线"承诺 |
| P1 | `Store.base()` 改 `sync.Once`；`startupFile` 加同步 | 1 小时 | 消除数据竞争 |
| P1 | 滚动路径 rAF 节流 + 标题缓存 + IntersectionObserver | 1 天 | 长文档滚动明显更顺 |
| P1 | mindmap 全局状态收敛 + 3.3/3.6/3.7/3.8/3.9 五个小修 | 0.5 天 | 修掉 5 个真实缺陷 |
| P2 | 目录索引缓存（ListTree / FindByTitle 复用） | 1 天 | 大 vault 打开/跳转不再卡顿 |
| P2 | 大文件降级策略 + 编辑防抖加长 | 0.5 天 | 避免大文件假死 |
| P2 | 设置落盘防抖、图片 ServeContent、复制按钮去属性化 | 0.5 天 | 减少无谓 IO 与内存 |
| P3 | Viewer.vue 拆分 composables | 1–2 天 | 后续所有改动变容易 |
| P3 | wails generate module + 清死代码 + i18n 拆分 + pnpm 统一 | 1 天 | 长期维护成本 |

---

## 七、两个可直接套用的补丁

### 7.1 `Store.base()` 消除竞争

```go
type Store struct {
    mu      sync.Mutex
    once    sync.Once
    baseDir string
    watcher watcherState
}

func (s *Store) base() string {
    s.once.Do(func() {
        if d := os.Getenv("MDVIEW_HOME"); d != "" {
            s.baseDir = d
        } else if cfg, err := os.UserConfigDir(); err == nil {
            s.baseDir = filepath.Join(cfg, "mdview")
        } else if home, err := os.UserHomeDir(); err == nil {
            s.baseDir = filepath.Join(home, ".mdview")
        }
        _ = os.MkdirAll(s.baseDir, 0o755)
    })
    return s.baseDir
}
```

### 7.2 滚动处理统一 rAF 节流 + 标题缓存

```ts
// 渲染后收集一次，滚动时只读缓存
let heads: HTMLElement[] = []
function cacheHeads(art: HTMLElement) {
  heads = Array.from(art.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'))
}

let rafId = 0
function onRenderScroll() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const sc = renderScrollEl.value
    if (!sc) return
    rememberRender(sc)
    if (justMirrored()) return
    spyHeading(sc)        // 现在只读 heads 缓存，可用二分查找
    syncPreviewToSource()
  })
}
```
