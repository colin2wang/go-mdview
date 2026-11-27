# mdview 前端

Vue 3 + TypeScript + Vite 单页应用，作为 Wails v3 桌面窗口的界面层。浏览器里直接 `pnpm dev` 会进入同形 Mock 模式，便于无桌面环境验证渲染与交互。

## 目录速览

```text
src/
  main.ts, App.vue           应用挂载与主布局
  api.ts                     前端唯一后端接口（按领域拆分）+ 桌面/Mock 切换
  mock.ts                    浏览器模式同形实现
  store.ts                   全局状态、设置落盘、打开/保存/导航流程
  markdown.ts                Markdown → HTML：预处理、marked、DOMPurify、脚注、data-sl
  sanitize-common.js         DOMPurify hook 与 URL 判定的唯一实现（配 .d.ts）
  sanitize-config.json       DOMPurify 配置唯一来源
  sanitize-cases.js          构建期与 Vitest 共享的净化回归用例
  vendor.ts                  marked / highlight.js / KaTeX / Mermaid / Pele 动态加载
  sync.ts, editor-bridge.ts  分栏滚动同步与源码编辑器桥接
  mindmap.ts, components/MindMap.vue  思维导图解析、布局与交互
  components/                标题栏、侧栏、查看器、状态栏等
bindings/                    wails3 生成的绑定，禁止手改
scripts/sanitize-check.mjs   构建期 XSS 回归脚本
```

## 开发与构建

```powershell
cd frontend
pnpm install
pnpm dev            # 浏览器 Mock 模式
pnpm run build      # vue-tsc --noEmit && vite build && sanitize-check
pnpm test           # Vitest（jsdom）
```

Windows 完整产物用仓库根的 `.\build.ps1`：它先执行 `wails3 generate bindings -ts -d frontend/bindings`，再构建前端、生成 syso 并编译 Go，最后校验 exe 图标资源。产物在 `build\bin\`。Go 单测用 `go test -race ./internal/...`，CI 还会跑 `go vet ./...`。

## 渲染与安全

1. `preprocess` 处理脚注 / wikilink / `==mark==`，并用 `lineMap` 把输出行映射回原文行号。
2. `renderMarkdown` 用一次 `marked.lexer` 同时产出 HTML、TOC 与标题锚点。块级 renderer 通过 `withSl` 注入 `data-sl`，供 `sync.ts` 建立源码 ↔ 正文的对齐点表。每次渲染使用独立 `SlContext`，避免交错渲染互相推进游标。
3. 所有 HTML / SVG 出口统一走 `sanitize-common.js` 的 `sanitizeWith`；DOMPurify 配置只来自 `sanitize-config.json`。脚注、Mermaid / Pele 图形、灯箱、导出 HTML 都必须回灌同一出口，禁止在净化后拼接不可信字符串。
4. `index.html` 的 CSP 是纵深防御：允许本地脚本与内联样式（主题 / KaTeX / Mermaid 需要），禁止远程脚本、object 与 form 提交。不能替代 DOMPurify。
5. `Settings.blockRemote` 默认开启，远程 URL 需命中 `remoteAllow` 通配符白名单；通配符按整串锚定匹配，不解析 URL 凭据。

## `/mdimg` 本地图片回放

前端把本地图片绝对路径 hex 编码后写为 `/mdimg/{hex}/{文件名}`。Go 侧 `internal/imgsrv.ImgHandler` 是真正的防线：解码后要求绝对路径、图片扩展名、目录白名单（`AllowImageDir` 登记）以及 `EvalSymlinks` 真实路径校验，越界返回 403。打开文件、图片、历史与目录树时前端都会先 `await App.AllowImageDir(...)`。白名单 LRU 上限 128 条，避免早先目录突然 403。

## API 分层与类型

`api.ts` 把绑定拆成 `FileApi / HistoryApi / SettingsApi / WindowApi / ExportApi / AssocApi`，并用显式对象字面量映射到 `frontend/bindings/...` 的生成函数；绑定缺失或签名漂移会在 `vue-tsc` 阶段报错。浏览器模式加载 `mock.ts`，两者实现同一 `Api`。生成的 `Settings.viewMode` 是 `string`，前端领域类型收窄为 `ViewMode`，仅在返回处做一次显式收窄。

Wails v3 事件回调参数是 `WailsEvent` 对象，载荷在 `ev.data`；桌面检测用 `window._wails`。新增 Go 绑定方法后必须重新生成 bindings，不要手改生成物。

## 依赖策略

- 全部渲染库来自 npm 精确版本或受控范围，动态 `import()` 打包进 `dist/assets`；不使用 CDN 或 `window.*` 全局脚本。
- TypeScript 5.x 配合 `vue-tsc` 2.x；`pnpm-workspace.yaml` 只保留确有必要且带注释的 override（`@types/node` 18.x）。
- KaTeX 统一为 0.16.47；marked 主应用 15.x、mermaid 传递依赖 16.x 并存，升级到 16 前需重查 `renderer.table` 等内联复刻代码。

## 测试

`src/__tests__/` 覆盖核心纯函数、渲染上下文隔离、KaTeX `trust: false`、i18n 四语 key 与占位符转义。`scripts/sanitize-check.mjs` 与 Vitest 共享 `sanitize-cases.js`，构建阶段先跑一遍恶意 / 绕过 / 良性用例。画布相关测试由 `__tests__/setup.ts` stub `getContext`，避免 jsdom 未实现 canvas 的噪音。
