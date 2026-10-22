# AGENTS.md — mdview 项目指南

轻量级本地 Markdown 阅读器（Windows 桌面应用）：Go 1.25 + Wails v2 + Vue 3 + TypeScript。

## 构建与测试

- 完整构建（Windows）：`.\build.ps1`（依次执行 generate-icon.ps1 → 前端构建 → wails build）。`-Clean` 清理，`-Package` 打 zip。
- 前端：在 `frontend/` 下用 **pnpm**（`pnpm install` / `pnpm run build`，build = `vue-tsc --noEmit && vite build`，类型检查失败即构建失败）。`wails.json` 里写的 npm 已被 build.ps1 改用 pnpm 取代。
- 后端：`go test ./mdv/`；本地快速编译 `go build -tags "desktop,production" .`（需先构建前端，见下）。
- 图标资源单独生成：`.\generate-icon.ps1`。

## 架构

- `main.go`：wails.Run 入口（保持 package main 在仓库根，wails/embed 要求），frameless 窗口、单实例锁（二次启动把 .md 路径转给已有窗口）、`//go:embed all:frontend/dist`（**go build 前必须先构建前端，否则 embed 失败**）、asset handler 挂载本地图片路由 `/mdimg/{hexpath}`。
- `internal/app/`：暴露给前端的全部绑定方法（App.*），多为对 `mdv` 包的薄封装。
- `internal/mdv/`：核心业务包——文件读取/编码探测（UTF-8/GB18030）、设置/历史/收藏持久化（存 `%AppData%\mdview\`）、导出 HTML、图片服务、文件关联。平台差异用构建标签隔离（`assoc_windows.go` / `assoc_other.go`）。
- `frontend/src/`：Vue 3 SPA。`store.ts`（状态）、`api.ts`（调用 App 绑定）、`components/Viewer.vue`（渲染主区）。

## 注意事项

- `frontend/wailsjs/` 由 wails build 自动生成，**不要手改**；在 `internal/app/app.go` 新增绑定方法后需重新 `wails build` 再提交生成的绑定文件。
- 仓库用 `.gitattributes` 强制 LF（文本）/CRLF（*.ps1 等脚本）；构建工具重写文件后 git 可能出现纯换行符 diff，属正常。
- 无 frame 布局：标题栏为自绘组件 `TitleBar.vue`，窗口操作走 App 绑定（WindowPin/WindowMaxToggle 等），不要引入系统标题栏。
- 离线渲染：KaTeX、Mermaid、highlight.js 均为本地资源，不要引入 CDN。
- 国际化：界面文案一律走 `frontend/src/i18n.ts` 的 `t()`（四语言 zh-CN/en/ja/de），语言存于 Settings.language（`internal/mdv/settings.go` 校验），设置对话框切换后经 `applySettings → setLang` 即时生效；新增 UI 文案须同时在四份词典补 key，不要硬编码中文。

## 维护规则

项目结构、构建/测试命令、架构边界、开发约定或本文件记录的其他事实发生变化时，必须在同一次改动中同步更新本文件。
