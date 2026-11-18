我把这份文档里的 72 个源码文件全部提取出来通读了一遍，覆盖 Go 后端、Vue/TS 前端、样式、测试与构建配置。总体判断：**这个项目的完成度相当高**——渲染管线、离线安全、窗口几何记忆、源码⇄正文锚点同步都做得很细；但有几条链路存在"自己人打自己人"的问题，会直接让核心功能失效或击穿 README 里"100% 本地、不外发请求"的承诺。

以下按严重程度给出问题定位（文件:行号）和可落地的优化建议。

---

## 一、P0：会直接破坏核心功能或安全承诺

**1. 净化配置把渲染器自己生成的按钮全删了（功能链路断裂）**
`sanitize-config.json:3` 把 `button` 列入 `FORBID_TAGS`，但 `markdown.ts:465` 的代码块复制按钮、`:410` 的图形卡片「源码 / 复制」按钮都是 `<button data-copy>`；`markdown.ts:505` 对整段输出调用 DOMPurify 后按钮节点被剥离、`data-*` 属性一并丢失，而 `Viewer.vue:650,681` 的事件委托只认 `closest('button[data-copy]')`。`style-md.css:151,441` 里精心写的按钮样式因此永远用不上。
→ 结果：**代码复制、图形卡片源码切换全部点不动**。`sanitize-check.mjs` 只测了"恶意 button 被清除"，没有良性用例验证合法 button 保留，所以没拦住。
→ 修法：放开 `button`，改用 `FORBID_ATTR` 精确禁 `formaction` 等危险属性；或渲染器改用 `<span role="button" data-copy>` 并同步改选择器。同时把"合法按钮保留"加入回归用例。

**2. 多处 HTML 绕过净化，远程拦截可被绕过（安全承诺被击穿）**
- `markdown.ts:507` 在 `sanitizeHtml` 之后才拼接脚注区，而 `buildFootnotesHtml:311` 直接 `marked.parse(f.content)` 拼接——脚注内容里的 `<img onerror>`、`<style>url(https://…)`、`<svg onload>` 全部直达 `v-html`（`Viewer.vue:985`）。此时 `blockRemoteNow` 已复位（`:112`），拦截 hook 不生效。
- `store.ts:99` 渲染失败时把 `String(e)` 直接插进 `<pre>`，未转义、未净化。
- `markdown.ts:88-102` 的远程 hook 只检查 `src` 与 SVG `image[href]`，**漏掉 `srcset` / `poster` / `object[data]` / `xlink:href`**；`sanitizeSvg:359` 的正则只清 `http(s)://` 和 `//`，不处理 `data:`；`markdown.ts:624` 的 Mermaid 输出、`ImageLightbox.vue:81` 的 `v-html="svg"` 都未二次净化。
- `export.go:38` 把渲染 DOM 原样写进导出文件，没有净化，且 `/mdimg/{hex}` 本地路径在独立 HTML 里必然失效（`store.ts:440` 导出的还是当前 DOM，编辑草稿状态下导出的是未保存内容）。

→ 修法：**收敛为"一个出口、一次净化"**：脚注/异常/Mermaid/灯箱/导出统一走 `sanitizeHtml`；远程 hook 覆盖所有 URL 承载属性（`src/srcset/poster/data/href/xlink:href`），并对本地图片路由做 `filepath.EvalSymlinks` 后的真实路径校验。

**3. 单独打开图片 / 启动恢复图片时必然 403**
`store.ts:229-243` 的图片分支只设置 `imgUrl`，不调用任何登记目录的 Go 方法；白名单登记只发生在 `PushHistory`（`fsops.go:55`），而它是异步 `.then`（`store.ts:273`），更糟的是启动恢复走 `openFile(lastFile, {pushHistory:false})`（`store.ts:493`），完全不登记 → `imgserver.go:98` 返回 403，图片显示为破图且无错误提示。
→ 修法：新增并 `await` 一个显式的 `AllowImageDir(dir)` 绑定，在 `openFile` 里对所有文件类型统一登记；图片 `<img>` 增加 `onerror` 占位与"重新加载"。

**4. watcher 有并发崩溃与静默漏报，且与编辑态冲突**
- `watcher.go:131` 每轮循环重新求值 `st.w.Events`，而 `watcherStopLocked:96` 会在切换文件时把 `st.w = nil` 并 `Close()` → 旧 goroutine 下一轮解引用空指针 panic；`st.watched`（`:136`）、`st.onChange`（`:119`）也存在无锁读写。
- `watcher.go:174` 的 `2s` 自身保存抑制窗口会吞掉这 2 秒内的**外部**修改，并顺手把 `knownM/knownS` 更新成新值 → 之后永远不再报告这次改动。
- `store.ts:181` 自动重载同一路径时，`Viewer.vue:161` 只监听 `current.path`（不变），`editing/draft` 保留但正文已被替换成文件新内容 → 用户一保存就把外部新内容覆盖掉，或者草稿与预览不一致。
  → 修法：w/events channel 作为局部参数传入 loop，停止后不再触碰共享字段；抑制窗口改用"内容哈希 + 保存标记"而非纯时间；自动重载前检测未保存草稿，弹「保留草稿 / 重载」而不是静默覆盖。

**5. 关闭窗口 / 重启 / 切换文件都会静默丢掉未保存草稿**
`TitleBar.vue:27` 直接 `WindowClose()`，`SettingsModal.vue:113` 直接 `RestartApp()`，`Viewer.vue:161-171` 切换文件只是丢弃后弹一条 toast——而 README 写的是 "warns before discarding"。`editing/draft` 还只存在 Viewer 组件内部，Go 层 `BeforeClose` 根本感知不到。
→ 修法：把编辑态提升到 store，在关闭、重启、切换、外部重载四个出口统一走一个 `confirmDiscard()`，并提供草稿本地暂存（关闭后下次启动可恢复）。

**6. 交付快照与 README 不一致，构建/离线渲染链路是断的**
按这份文件树，缺少 `frontend/public/static/*`（marked / highlight.js / KaTeX / mermaid / 两套 hljs 主题）、`frontend/dist`（`main.go:18` 的 `go:embed` 目标）、`favicon.svg`（`index.html:6`）、`build.ps1`、`generate-icon.ps1`、`README.zh-CN.md` 和 README 引用的 6 张 `docs/images/*.png`；`package.json` 也没有 `marked/hljs/katex/mermaid` 依赖和 `sanitize-check` 脚本。`mock.ts:164` 提供的示例图是 data URI，`markdown.ts:139` 却指向 `/static/mock-sample.svg`。README 内部还自相矛盾：徽章 `Go 1.27+` vs 正文 `Go 1.25+`、`~16MB` vs `~13 MB`。
→ 影响：照此快照直接 `go build` 会因缺 `frontend/dist` 失败；即便跑起来，代码高亮、公式、Mermaid、静态占位图全部 404 静默降级。建议把静态库纳入仓库并锁定校验和、补齐构建脚本与截图、统一版本号。

---

## 二、P1：功能正确性问题

| # | 问题 | 定位 |
|---|---|---|
| 1 | `validViewMode` 只认 `source/split`，把 `mindmap` 回落成 `render`（注释却写明支持 4 种）→ 导图模式退出后重启必回渲染视图，且前端忽略 `SaveSettings` 返回值造成前后端设置漂移 | `settings.go:42,71-79`、`store.ts:380,465` |
| 2 | Wiki 链接 `[[note\|alias]]` 没拆别名、`[[folder/note]]` / `[[note#heading]]` 不支持；`FindByTitle` 每次全目录递归、同名只返第一个、无索引 | `markdown.ts:252-265`、`readfile.go:129` |
| 3 | 脚注 / `==mark==` / wikilink 的正则不感知行内代码与 HTML 注释，代码片段会被改写；TOC 锚点用 `src.indexOf(t.raw)` 匹配预处理后的标题，含脚注/wikilink 的标题锚点丢失 | `markdown.ts:246-265,523` |
| 4 | 思维导图解析和 TOC 行扫描都把代码块里的 `# 注释` 当标题 → 导图/目录被代码内容污染 | `mindmap.ts:190`、`editor-bridge.ts:18` |
| 5 | 编码检测只有 UTF-8 / GB18030，缺 UTF-16 BOM、Big5、Shift-JIS（UI 却支持日/德）；原子替换保存丢失 CRLF、创建时间、ACL/ADS，只读文件保存失败只有英文 toast | `readfile.go:45-54,97-117` |
| 6 | 文件关联只管 `.md/.markdown`，前端与文件树支持 `.mdown/.mkd`；Windows 的 `UserChoice` 优先级高于 `Software\Classes`，导致"已关联"状态误报、取消关联后默认程序并未真正还原 | `assoc_windows.go:26,51,148`、`fsops.go:155`、`main.go:68` |
| 7 | 站内链接用 `javascript:void(0)`（注释自己承认 DOMPurify 会删 href）→ 不可 Tab 聚焦、不可复制链接地址；文件树/历史/收藏条目全是无 `href` 的 `<a>`，键盘完全不可用 | `markdown.ts:496,498`、`TreeItem.vue:47,53`、`HistoryPanel.vue:63` |
| 8 | 目录节点没有右键菜单；清除历史一键清空 100 条无确认；`relTime` 超过 7 天只显示 `M-D`，跨年无法分辨 | `TreeItem.vue:47`、`HistoryPanel.vue:23,50`、`FilesPanel` 对照 |
| 9 | 图片/文本/导图模式下右键「导出 HTML」会生成空文件；状态栏 `previewChars` 在这些模式下保留上一篇文档的旧值 | `Viewer.vue:709`、`store.ts:439`、`Viewer.vue:499` |
| 10 | `countMd` 把图片/文本也算成"笔记数"；`openFile` 无条件把 `lastFolder` 写成当前文件目录，但树根可能没跟着切 → Files 面板标题与实际内容不符；拖拽只认 md，`App.vue:35` 的浏览器兜底 `(f as any).path` 恒为空 | `store.ts:275,326,510`、`FilesPanel.vue:10` |
| 11 | `readJSON/writeJSON` 静默吞掉所有错误（文件损坏→悄悄回默认、写失败无提示）；YAML 非原子写，且 exe 在只读目录时 `removeYaml` 失败会让"关闭 yml 开关"下次启动又被顶回开 | `store.go:47-66`、`yamlfile.go:84`、`settings.go:161` |
| 12 | `SetTheme` 与 `SaveSettings` 两个未 await 的并发调用可能乱序覆盖；`processAlive` 用 `OpenProcess` 成功即判存活，退出进程句柄未销毁时会误判，重启退化成固定 5s 等待 | `store.ts:408-409`、`procpid_windows.go:11` |

---

## 三、P2：性能、稳定性与工程化

- **大文档卡顿**：`ListTree` 全量递归、无数量上限、无缓存、无虚拟化（`fsops.go:250-282`）；32MB 上限的文件会同步走 marked + DOMPurify + Mermaid 全量渲染（`readfile.go:24`）；编辑时每次输入 300ms 后全量重渲染（`Viewer.vue:143`）；主题切换重绘所有 Mermaid（`Viewer.vue:572`，且 SVG 卡片不跟随主题）。
- **图片缓存反直觉**：`Cache-Control: max-age=86400`（`imgserver.go:120`）让本地图片改了一天内不刷新；`maxImgRoots=32` 淘汰后，早先打开目录的图片突然 403。
- **资源加载一次失败永久降级**：`loadScript/loadCss` 把 rejected Promise 也缓存了（`vendor.ts:8-39`）；`ensureMermaid` 用 `neutral`、`renderDiagramsIn` 用 `dark/default`，主题口径不一致。
- **写盘过于频繁**：每次 `openFile` 都 `SaveSettings`（`store.ts:277`），`GetSettings` 每次读盘并叠加 YAML 解析。
- **测试覆盖不足**：`mdv_test.go` 未覆盖 watcher 并发/抑制、YAML 往返、`SaveMarkdown` 原子写与编码回写、图片路径穿越与 symlink；`TestNaturalLess:178-183` 先写错用例再用一行赋值打补丁，测试卫生欠佳。前端没有单测，`sanitize-check.mjs` 也没进 `package.json` scripts / CI。
- **i18n 边缘漏网**：4 份词典各 188 键、完全对齐，做得很好；但 `mindmap.ts:184,356` 的"未命名导图 / 点击展开折叠"、`store.ts:99` 的"渲染失败"、`markdown.ts:639` 的"Mermaid 库加载失败"、Go 侧对话框标题与 `tooLargeError` 都是硬编码中文，切到英/日/德会露馅。`demo.ts:135` 还写死了真实个人路径 `C:\Users\wangb\OneDrive\…`，建议换成占位串。
- **类型漂移**：`globals.d.ts:9-14` 只声明 `go.main.App`，实际绑定是 `go.app.App`，`runtime` 也缺 `OnFileDrop`；全靠 `as any` 绕过。依赖偏旧（TS 4.6 / Vite 3 / Vue 3.2 / CodeMirror 5 / vue-tsc 1.8），且无 lint/test 脚本。
- **可访问性**：CSS 里 `:focus-visible` 0 处、唯一焦点样式是搜索框（`style.css:614`）、`prefers-reduced-motion` 0 处、`@media` 仅 1 处、`role="radiogroup"` 内的按钮没有 `role="radio"`/`aria-checked`（`TitleBar.vue:55`、`SettingsModal.vue:183`）。

---

## 四、功能与体验优化建议

**A. 编辑与数据安全（最高价值）**
1. 建立统一的「未保存改动」状态与确认弹窗，覆盖关闭 / 重启 / 切换文件 / 外部重载 / 退出编辑五个出口；按钮加醒目的未保存圆点标记。
2. 草稿自动暂存（按文件路径存到配置目录），崩溃或误关后下次打开提示恢复；保存前给一次 `.bak` 或回收站式备份，支持"查看与文件的差异"。
3. 保存时保留原换行风格（CRLF/LF）、原编码与 BOM；对只读文件、编码转换失败给出本地化原因和"另存为"出口。
4. 外部改动与本地草稿冲突时，提供三选一：重载 / 保留我的 / 对比合并，而不是静默二选一。

**B. 阅读效率**
1. 补 `Ctrl+O` 打开、`Ctrl+F` 全文搜索（含渲染结果高亮与下一个/上一个）、`Ctrl+P` 最近文件快速切换；目前打开文件后应用内**没有"打开文件"入口**，只能靠空状态按钮或侧栏。
2. 多标签/最近文档条：阅读器定位下，"双击第二个 md 只切内容"比多窗口更贴合单实例设计。
3. 图片查看器增强：加载失败占位与重试、"实际大小 / 适应窗口"切换、滚轮以光标为中心缩放（`ImageLightbox.vue:24`）、GIF/WebP 与超大图提示；外链点击前给"将离开本机打开浏览器"的确认。
4. 记住每个文件的阅读进度与折叠状态，而不只是全局窗口几何。

**C. 文件与知识管理**
1. 文件树加搜索框、类型过滤、虚拟滚动；大 vault 首次扫描给进度与"仅展开当前目录"选项。
2. Wiki 链接补齐 Obsidian 常见语法（别名、路径、`#锚点`、嵌入笔记），并为打开的目录建一次文件名索引，支持同名消歧列表。
3. 历史按「今天 / 本周 / 更早」分组、显示完整年份、支持单条删除与"从列表移除"；清空加确认；收藏支持置顶/分组。
4. 拖放支持全部可预览类型（图片/文本），多文件时给"打开第一个 / 全部加入队列"的选择。

**D. 设置与可访问性**
1. 设置页加「恢复默认」「打开配置目录」，YAML 开关明确写出文件路径与便携模式含义；白名单加"测试 URL 是否命中"的实时反馈；重启前确认并提示会丢失草稿。
2. 全面补 `:focus-visible`、`aria-label`、`role="tab"/"radio"`、`aria-checked`、`prefers-reduced-motion`；把无 `href` 的 `<a>` 换成带真实 `href` 的链接或 `<button>`，让键盘用户能走通文件树/历史/收藏。
3. 深色主题检查对比度与内联 SVG 卡片配色；提供快捷键说明面板。

**E. 导出与分享**
1. 导出 HTML 时把本地图片转成 base64 内嵌、二次净化、可选"导出后立即打开/打印"；明确标注导出的是已保存文件还是当前草稿。
2. 图形/导图导出 SVG 时内嵌字体与样式，避免外部软件打开后样式丢失；PNG 导出给倍率与尺寸选择。
3. 补 PDF / 打印样式（README 已把 PDF 列为范围外，但打印是最低成本的高频替代）。

**F. 工程化**
1. 把 `sanitize-check.mjs` 接进 `pnpm build` 与 CI，并补上"合法 button / 代码块 / 图表保留""脚注区净化""srcset/poster 拦截""导出净化"用例。
2. 补 watcher 并发的 `go test -race`、YAML 往返、编码回写、路径穿越与 symlink 测试；前端引入 Vitest 覆盖 `preprocess` / `remoteAllowed` / `resolveImgHref` / `mindmap.parseMarkdown`。
3. 统一错误提示文案并落本地日志；升级 TS/Vite/Vue/CodeMirror，静态库版本进 lock 并校验完整性；README、徽章、构建脚本、截图与仓库内容对齐。

---

## 五、建议的修复顺序

| 批次 | 内容 | 验收标准 |
|---|---|---|
| 第 1 批 | P0-1 ~ P0-6 | 复制/源码切换可点；构造含恶意脚注与 `srcset` 的 md 无任何外发请求；单独打开图片与重启恢复均正常显示；切换文件不 panic；有草稿时关闭/重启/重载均有确认；`go build` 能产出且高亮/公式/Mermaid 生效 |
| 第 2 批 | P1 全部 | mindmap 模式可持久化；wiki 链接常见语法可用；`mdown/mkd` 全链路打通；键盘可走通树与列表；设置/历史/YAML 失败可见 |
| 第 3 批 | P2 + 建议 A~F | 大目录/大文档不卡；`pnpm build` 跑安全回归；四语言无硬编码中文；可访问性与导出达到可分享质量 |

需要的话，我可以针对其中任一块（比如渲染管线的净化重构、watcher 并发修正、或编辑态草稿保护）直接给出补丁级的代码修改方案。


# go-mdview 代码问题分析与优化建议
基于提供的代码，我按「严重度 → 影响面」梳理了以下问题与建议。
---
## 一、高优先级：安全 / 正确性缺陷
### 1. 脚注内容未经过 DOMPurify 清洗（XSS 漏洞）⚠️
`markdown.ts` 中，主 HTML 的清洗顺序是：
```ts
let html = String(marked.parse(md))
html = sanitizeHtml(html, blockRemote, remoteAllow)   // 已清洗
html = postprocessAlerts(html)
html += await buildFootnotesHtml(footnotes)           // ⚠️ 清洗之后追加
```
而 `buildFootnotesHtml` 内部对脚注定义 `f.content` 做了 `marked.parse(f.content)` 后**直接拼接**，未再走 `sanitizeHtml`。攻击者只需在一个不可信 md 文件里写：
```markdown
正文[^1]
[^1]: <img src=x onerror=alert(1)>
```
即可执行脚本，完全绕过整套 sanitizer（`frontend/scripts/sanitize-check.mjs` 的回归用例也没覆盖脚注注入路径）。
**修复**：脚注 HTML 追加前再过一次 `sanitizeHtml(html, blockRemote, remoteAllow)`；同时在 sanitize-check 中补上 `[^1]: <script>…` 类用例。
### 2. sanitizer 配置与渲染器自产 HTML 冲突，误杀自身功能
`sanitize-config.json`：
```json
"FORBID_TAGS": ["style", "base", "meta", "form", "input", "button"]
```
- 禁 `button` → 代码块的 **复制按钮**（`code-copy`）、图形卡片的 **「源码」切换按钮**（`md-diagram-btn`）都会被清洗掉，README 宣称的核心交互实际失效；
- 禁 `input` → GFM **任务列表的 checkbox**（`li:has(> input[type='checkbox'])`）被移除，配套样式也失去作用。
  **修复**：把「拦截不可信 HTML 中的 button/input」与「保留渲染器自产控件」解耦——要么用 `ADD_TAGS` 精细放行自产组件（并在其后处理中剥掉 `formaction` 等危险属性），要么改变流水线顺序：先 sanitize 用户 HTML，再由渲染器注入按钮。当前"一处配置两处用途"是设计缺陷。
### 3. `javascript:void(0)` 会被 DOMPurify 剥掉 href（注释里自己指出了却没改）
`markdown.ts` link 渲染器：
```ts
if (href.startsWith('#')) {
  // 注释：不要用 javascript:void(0)：DOMPurify 会删掉该 href……
  return `<a href="${escapeHtml(href)}" ...>`   // 锚点：已修正 ✓
}
...
return `<a href="[javascript]:void(0)" class="md-link" data-mdlink="...">`  // ⚠️ md 链接仍用
```
结果 `.md-link` / `.md-link-dead` 退化为无 `href` 的 `<a>`：失去手型光标、不可聚焦、语义破坏。
**修复**：统一改为 `href="#"`（事件委托里 preventDefault），或干脆输出无 href 的 `<span role="link" tabindex="0">`。
### 4. 本地图片回放未做目录边界校验（与 README 承诺不符）
`resolveImgHref` 对**任意绝对路径**直接放行：
```ts
const abs = isWinAbs(p) ? p : ...
return '/mdimg/' + hexEncode(abs) + '/'
```
README 承诺 "PNG/JPG… in the md file's directory and subdirectories"，但一个恶意 md 写 `![x](C:\Users\xxx\私密截图.png)` 就能把任意本地图片渲染出来。前端已放行，最后防线只剩后端 `imgserver.go`——若它也未校验，就是明确的越权读文件面。
**修复**：前端/后端双侧校验：解析后的绝对路径必须位于当前 md 的目录（或用户显式打开的目录树）之内，否则替换为占位图。
### 5. mermaid 渲染产物未二次清洗
`renderDiagramsIn` 中 `res.svg` 直接 `innerHTML`。虽然 `securityLevel: 'strict'` 缓解了大部分风险，但 mermaid 历史上多次爆过 SVG 注入绕过，作为「打开不可信文件」的阅读器建议对输出再做一次 `sanitizeSvg` 同等强度的清洗，纵深防御。
---
## 二、功能问题
| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 1 | **导出 HTML 图片全部失效**：`.md-article` 的 innerHTML 中 img src 是 `/mdimg/{hex}/...`，脱离应用无法解析 | `store.ts exportHtml` | 导出时将本地图片读取后转 base64 内嵌（或复制到导出文件旁并重写相对路径） |
| 2 | **拖拽入口与文件树能力不一致**：`OnFileDrop` 回调只认 `/\.(md|markdown|mdown|mkd)$/`，图片/文本文件拖不进来，但 `fileKind` 明明支持 | `store.ts initApp` | 放开过滤，交给 `openFile` 按 kind 分发 |
| 3 | **外部删除后 watch 被永久停止**：`resolveGoneFile` 无论「保留」还是「关闭」都 `StopWatch()`，用户保留内容后若外部重建文件，再也不会自动恢复，也没有"重新关联"入口 | `store.ts` | 「保留」时对同路径重建 watch（或延迟重挂）；给保留态的标题栏加"文件已失效，点击重新加载" |
| 4 | **切换文件丢编辑只做事后 toast**：i18n 文案是"已切换文件，未保存的修改已丢弃"，README 却承诺 "warns before discarding" | `openFile` | 改为切换前弹确认（沿用 gone modal 风格），并支持 Ctrl+S 后自动关闭编辑态 |
| 5 | **wiki 链接歧义与性能**：`FindByTitle` 每次点击都递归扫描全目录树，无缓存；同名文件静默取第一个 | `openWikiLink` | 结果缓存 + 目录变更失效；多命中时弹列表让用户选 |
| 6 | **`lastFolder` 与文件树不同步**：非 reRoot 打开文件时 `settings.lastFolder` 被更新为新目录，但左侧树仍是旧目录；下次启动恢复的是另一个目录 | `openFile` 尾部 | `lastFolder` 仅在真正切换树根时更新 |
| 7 | **`mockTree` 硬编码真实用户路径**：`C:\Users\wangb\OneDrive\Obsidian\迷你狐的知识库\...`，与 `demo.ts` 自己的注释"不要写真实用户目录进仓库"自相矛盾 | `mockTree` | 改为 `C:\demo\vault\...` 同款占位 |
| 8 | **i18n 破功的硬编码中文**：`mindmap.ts` 的 `未命名导图`、`点击展开/折叠`，`markdown.ts` 的 `Mermaid 库加载失败` | mindmap/markdown.ts | 全部走 `t()`；德/日用户会看到中英混排 |
---
## 三、用户体验
1. **键盘可访问性缺失**：目录/历史/收藏/文件树的条目都是无 `href` 的 `<a>`，无 `tabindex`、无 Enter/Space 触发；弹窗无焦点圈定与 Esc 一致处理。纯键盘用户基本无法导航。建议统一封装 `role="button"` + `tabindex="0"` + keydown 处理的可点击组件。
2. **编辑实时预览疑似无防抖**：`renderDraft` 每次输入触发全量 `marked.parse + DOMPurify + TOC lexer`。大文档（几千行）会明显卡顿。建议 200~300ms 防抖 + `requestIdleCallback` 兜底；`marked.lexer` 在 `parse` 和 TOC 提取中跑了两遍，可解析一次复用 tokens。
3. **`previewChars` 统计不准**：`countPreviewText` 只检查 `el.style.display`（内联样式），而 `.md-diagram-code` 的隐藏是 CSS 类控制的——源码文字被计入预览字数；任务列表 checkbox 等也被算。另外 `countStats` 的 `words` 对中文（无空格）恒等于 1，建议按 CJK 逐字计数或直接移除该字段。
4. **窗口关闭无未保存编辑拦截**：编辑态下点 `✕` 直接退出（Wails 窗口关闭无 `beforeunload` 拦截时）。建议在 Go 端拦截 close 事件 → 前端确认，或至少在状态栏/标题给出未保存圆点标记。
5. **思维导图信息量偏窄**：仅标题 + 引用，列表/段落内容直接丢弃。可以把一级列表项并入对应章节节点的子节点或备注，选项化（默认关闭避免噪音）。
6. **图片阅读体验**：灯箱支持缩放/拖拽很好，但缺少旋转、100% 复位按钮、双图对比；目录里的图片无法"上一张/下一张"连览。
7. **WebView2 兼容性风险**：大量使用 `color-mix()` 和 `:has()`（需 Chromium 111+/105+）。Win10 上未更新 WebView2 Runtime 的旧机器会整片样式失效且无提示。建议构建时检测并降级（或用预计算颜色变量替代部分 color-mix）。
8. **文件树不感知磁盘变化**：目录里新增/删除笔记需手动点刷新。可对当前根目录做轻量 fsnotify 监听（防抖后只更新树），或至少在窗口重新获得焦点时自动刷新一次。
---
## 四、性能与工程质量
- **`SaveSettings` 写放大**：每次 `openFile` 都落盘 settings（含 lastFile/lastFolder），快速连续打开文件会频繁写盘。建议合并写（800ms 防抖）。
- **`t()` 每次调用重建正则**：`new RegExp(\`\\{(${Object.keys(params)...})\`, 'g')`，热路径（每帧多次）可缓存模板编译结果。
- **依赖偏老**：`vite 3`（已 EOL）、`typescript 4.9`、`codemirror 5`。建议升 vite 5+/TS 5，CodeMirror 5→6 可排期（5.x 中文输入与 IME 已够用，非紧急）。README 徽章写 `Go 1.27+`，构建说明写 `Go 1.25+`，统一一下。
- **前端测试缺口**：目前只有 Go 侧 `mdv_test.go` 和 sanitize-check 脚本。`preprocess`（脚注/alert/setext 补空行）、`renderMarkdown` 的 link/image 渲染、`mindmap.parseMarkdown`、`countStats` 都是纯函数，非常适合 vitest 快速补齐；本文第 1、2 条 bug 正是缺测试的直接后果。
- **TOC/锚点行号依赖 `src.indexOf(t.raw)`**：重复标题+指针游标方案对大多数情况成立，但若 preprocess 改动过大或 raw 含变量展开，会静默错位。可考虑让 renderer 直接携带 lexer 给出的行号（marked 插件层），去掉 indexOf 依赖。
---
## 五、优先级建议（Top 5）
1. 🔴 修复脚注 XSS（一行 sanitize 调用 + 补测试）
2. 🔴 解决 FORBID_TAGS 误杀 button/input 的配置冲突（复制按钮/任务列表恢复）
3. 🟠 本地图片读取加目录边界校验
4. 🟠 md 链接去掉 `javascript:void(0)`；外部删除"保留"后恢复 watch
5. 🟡 编辑防抖 + TOC lexer 复用；键盘可访问性；导出 HTML 图片内嵌
   整体而言，这个项目的架构清晰（mock/desktop 同形 API、纯函数渲染管线、sanitizer 单一来源都值得肯定），上述问题集中在"渲染产物与安全配置的两张皮"以及"README 承诺与实现的偏差"上，修复成本都不高，收益却很直接。
