# AGENTS.md — mdview 项目指南

轻量级本地 Markdown 阅读器（Windows 桌面应用）：Go 1.25 + Wails v2 + Vue 3 + TypeScript。

## 构建与测试

- 完整构建（Windows）：`.\build.ps1`（图标资源缺失时才执行 generate-icon.ps1，随后前端构建 → wails build）。`-Clean` 清理，`-Package` 打 zip。
- 前端：在 `frontend/` 下用 **pnpm**（`pnpm install` / `pnpm run build`，build = `vue-tsc --noEmit && vite build`，类型检查失败即构建失败）。`wails.json` 里写的 npm 已被 build.ps1 改用 pnpm 取代。
- 后端：`go test ./mdv/`；本地快速编译 `go build -tags "desktop,production" .`（需先构建前端，见下）。
- 图标资源：`.\generate-icon.ps1` 单独生成；`build.ps1` 仅在 `build/appicon.png`、`build/windows/icon.ico`、`build/mdview.markdown.png` 任一缺失时自动调用它，全部存在则跳过。

## 架构

- `main.go`：wails.Run 入口（保持 package main 在仓库根，wails/embed 要求），frameless 窗口、单实例锁（二次启动把 .md 路径转给已有窗口）、`//go:embed all:frontend/dist`（**go build 前必须先构建前端，否则 embed 失败**）、asset handler 挂载本地图片路由 `/mdimg/{hexpath}`；启动时按 `Settings` 的 `winW/winH` 决定初始尺寸，位置与最大化由 `app.Startup` 恢复，`app.BeforeClose` 负责落盘。
- `internal/app/`：暴露给前端的全部绑定方法（App.*），多为对 `mdv` 包的薄封装；`RestartApp`（设置页「重启」）清空窗口几何并把侧栏宽度复位后带 `--mdview-relaunch` 拉起新进程，main 见到该标记先等待旧进程释放单实例锁。
- `internal/mdv/`：核心业务包——文件读取/编码探测（UTF-8/GB18030）、设置/历史/收藏持久化（存 `%AppData%\mdview\`，含窗口几何 winX/winY/winW/winH/winMax）、导出 HTML、图片服务、文件关联。平台差异用构建标签隔离（`assoc_windows.go` / `assoc_other.go`）。
- `frontend/src/`：Vue 3 SPA。`store.ts`（状态）、`api.ts`（调用 App 绑定）、`components/Viewer.vue`（渲染主区）、`mindmap.ts`（Markdown→思维导图零依赖核心：解析/布局/SVG 渲染/交互）、`components/MindMap.vue`（导图视图容器，挂载 `mindmap.ts` 并提供工具条）。
- 思维导图：作为第四种 `ViewMode`（`'mindmap'`，见 `types.ts`），由标题栏模式按钮与设置页「默认视图」切换；导图是渲染面板的独占视图（`Viewer.vue` 的 `isMindmap`，不叠加源码）。解析规则：`#`=根节点、`##`=左右平衡的一级分支、`###`/`####`=子节点、`>` 引用块=节点备注；无 `#` 时把唯一顶层节点提升为根。工具条支持适应/缩放/备注开关/收起(到二级)/展开/导出 SVG/导出 PNG/复制 SVG；主题切换（`store.settings.theme`）经 `MindMap.setDark` 重绘（`mindmap.ts` 按深浅主题取节点文字与淡色底配色）。节点/备注单行最大字符数由 `Settings.mmMaxLen`（默认 20，8–60，Go/前端两端各自校验）控制，超长不可断单词（如 `NEW/RUNNABLE/…`）按它硬折行，设置页滑杆即时生效（`MindMap.setMaxLen`）。设置对话框为两列 grid（`style.css` 的 `@media (min-width: 640px)`，窄窗口回落单列）。导出走后端 `SaveSvgDialog`（SVG 文本）与 `SaveImageDialog`（前端光栅化后的 PNG data URL）。

## 注意事项

- `frontend/wailsjs/` 由 wails build 自动生成，**不要手改**；在 `internal/app/app.go` 新增绑定方法后需重新 `wails build` 再提交生成的绑定文件。
- 窗口几何：位置/大小/是否最大化随 `settings.json` 持久化（`winX/winY/winW/winH/winMax`，由 Go 端维护；前端 `patchSettings` 靠对象展开原样带回，不要在 `defaultSettings` 之外重建 Settings）。最大化/最小化/全屏关闭时不写回普通尺寸；设置页「重启」清空几何、把侧栏宽度恢复到默认 280px 后以默认 1200×800 重启。
- 源码面板：只读态与编辑态共用同一份高亮 DOM（`Viewer.vue` 的 `shownText` / `srcLines`），编辑态只叠一层文字透明的 textarea 接管光标与输入，滚动以 textarea 为准、高亮层跟随；因此高亮样式不得改变行内字宽（例如给 `.src-code` 加横向 padding），否则光标会与底图错位。
- 仓库用 `.gitattributes` 强制 LF（文本）/CRLF（*.ps1 等脚本）；构建工具重写文件后 git 可能出现纯换行符 diff，属正常。
- 无 frame 布局：标题栏为自绘组件 `TitleBar.vue`，窗口操作走 App 绑定（WindowPin/WindowMaxToggle 等），不要引入系统标题栏。
- 离线渲染：KaTeX、Mermaid、highlight.js 均为本地资源，不要引入 CDN。
- 国际化：界面文案一律走 `frontend/src/i18n.ts` 的 `t()`（四语言 zh-CN/en/ja/de），语言存于 Settings.language（`internal/mdv/settings.go` 校验），设置对话框切换后经 `applySettings → setLang` 即时生效；新增 UI 文案须同时在四份词典补 key，不要硬编码中文。

## 维护规则

项目结构、构建/测试命令、架构边界、开发约定或本文件记录的其他事实发生变化时，必须在同一次改动中同步更新本文件。
