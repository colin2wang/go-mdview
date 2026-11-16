# go-mdview 项目分析与优化建议
## 一、总体评价
项目整体质量较高：架构分层清晰（`internal/app` 绑定层 / `internal/mdv` 领域层 / Vue SPA），安全意识突出（DOMPurify + XSS 回归脚本 + 默认拦截远程资源 + Mermaid `securityLevel:'strict'`），功能完整度高（双实例去重、编码自适应、四语言 i18n、零依赖思维导图、注册表关联含"接管前备份"）。以下建议按优先级分级。
---
## 二、高优先级：正确性与接口契约
### 1. 前后端 API 返回值不一致（最值得立即修）
`internal/app/app.go` 中 `ToggleFavorite` 返回 `(bool, []mdv.Entry)`，导致 Wails 生成 `App.d.ts` 里是：
```ts
export function ToggleFavorite(arg1:string):Promise<boolean|Array<mdv.Entry>>;
```
而手写的 `frontend/src/api.ts` 声明 `Promise<boolean>`，`PushHistory` 更是从 `Promise<Array<Entry>>` 被改成了 `Promise<void>`。运行时 Wails 对多返回值的序列化行为不确定（可能返回数组），`store` 里若直接把返回值当 boolean 用会产生隐蔽 bug。建议改为显式结构体：
```go
type FavResult struct {
    Added     bool    `json:"added"`
    Favorites []Entry `json:"favorites"`
}
func (a *App) ToggleFavorite(path string) (FavResult, error) { ... }
```
同时让 `api.ts` 的 `Api` 接口**从 `wailsjs/go/app/App.d.ts` 派生**（`type Api = Pick<typeof App, keyof typeof App>` 的适配版），mock.ts 与真实端才不会漂移。
### 2. sanitize 配置双份维护
`frontend/scripts/sanitize-check.mjs` 手工复制了 `markdown.ts` 里的 DOMPurify 配置——两份配置迟早漂移。建议：
- 把配置抽为独立模块（如 `src/sanitize-config.ts`，纯常量无 DOM 依赖）；
- 将 sanitize-check 的用例迁移到 vitest，直接 `import { sanitizeHtml } from '../src/markdown'`，jsdom 环境下测试，删除手抄副本；
- 接入 `pnpm test` / CI。
### 3. 远程资源拦截逻辑重复 + 模块级可变状态
`markdown.ts` 中存在两套判断：`renderer.image` 里内联判断 `blockRemote && isRemoteSrc(href) && !remoteAllowed(...)`，以及 `sanitizeHtml` hook 里的 `remotePasses()`。另外 `blockRemoteNow` / `remoteAllowNow` 是模块级可变全局 + `hookInstalled` 一次性安装——切换设置后依赖时序。建议收敛为单一纯函数、参数显式传递，hook 改为每次渲染按参数调用。
### 4. `BLOCKED_IMG_DATA_URI` 在模块加载时求值
```ts
const BLOCKED_IMG_DATA_URI = 'data:image/svg+xml,' + encodeURIComponent(`...${t('img.blocked')}...`)
```
此时 i18n 尚未初始化且语言切换后不会更新（拦截图片文案永远停留在启动语言）。改为渲染时生成即可。
### 5. `/mdimg` 本地图片服务的路径遍历防护（需确认）
`imgserver.go` 用 `hexEncode` 编码路径回放本地图片，文档中未见防护描述。还原路径时务必校验：
```go
p := filepath.Clean(filepath.Join(root, rel))
if p != root && !strings.HasPrefix(p, root+string(os.PathSeparator)) {
    return "", errForbidden // 拒绝 ../ 逃逸
}
// + 扩展名白名单 png/jpg/jpeg/gif/webp/svg/bmp/avif
```
### 6. Wails CSP 未配置
文档未提及 CSP。建议在 `wails.json` 设置 `CSP`（如 `script-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`），与 DOMPurify 形成双保险。
---
## 三、中优先级：健壮性与兼容性
| # | 问题 | 建议 |
|---|------|------|
| 1 | **Win11 文件关联可能无效**：Windows 11 的 UserChoice（带 hash 保护）优先于 `HKCU\Software\Classes\.md` 默认值，直接写注册表常被系统忽略 | 关联后主动反查生效状态并在 UI 提示"如未生效请在 设置→默认应用 中确认"；README 的手动指引已具备，保留 |
| 2 | **窗口位置恢复越界**：`winX/winY` 在拔掉显示器/改分辨率后可能落在屏幕外 | `restoreWindowPosition` 前用 `GetMonitorInfo` 校验可见性，越界则居中 |
| 3 | **Windows 上原子替换保存**：`os.Rename` 覆盖已存在文件并非原子且可能失败 | 临时文件 → fsync → `windows.MoveFileEx(MOVEFILE_REPLACE_EXISTING)`；同时注意 GB18030 回写时 BOM 一致性 |
| 4 | **编码检测误判**：UTF-8/GB18030 启发式对短文档有误判率 | BOM 优先 + 检测结果在状态栏显示并允许用户手动指定 |
| 5 | **`t()` 占位符只替换首个**：`String.replace` 无 `g` 标志，同一 key 出现两次 `{n}` 会漏 | `s.replace(/\{(\w+)\}/g, (m,k) => params?.[k] ?? m)` |
| 6 | **`index.html` 固定 `lang="zh-CN"`**：切换语言后不同步 | `setLang` 时同步 `document.documentElement.lang`（影响无障碍/拼写检查/字体回退） |
| 7 | **`color-mix()` 兼容性**：需要 Chromium 111+，旧 WebView2 下颜色会静默失效 | 关键 UI 颜色在 `color-mix` 前给静态 fallback 声明，或启动检测降级 |
| 8 | **go.mod/go.sum 卫生**：go.sum 里残留 `golang.org/x/sys v0.0.0-20200810…`、`v0.1.0` 远古条目；go.mod 中注释掉的 `// replace … /home/z/go/pkg/mod` 泄露本机路径 | `go mod tidy` + 删除注释；版本号三处统一（README badge `Go 1.27+` vs 构建说明 `Go 1.25+` vs go.mod `go 1.27`） |
| 9 | **`AssocState.owner` 默认值 `'（未设置）'` 中文硬编码**在 Go 与 `types.ts` 两处 | 改为空串 + i18n key（`assoc.ownerNone` 已存在，可直接用） |
---
## 四、性能与体验
1. **实时预览**：`renderDraft` 全量 marked 解析 + `v-html` 整体替换，大文档会卡顿/闪动。建议输入防抖 150–300ms（`draftSeq` 已有序号机制，补时间防抖即可）；Mermaid/KaTeX 只对新增块增量渲染。
2. **`countPreviewText`** 每次渲染 DOM 全遍历，节流或仅在保存/切文件时统计。
3. **`/static/` 资源缺失于文件树**：`vendor.ts` 依赖 `frontend/public/static/`（highlight/kaTeX/mermaid），但项目文件树未列出——确认构建产物包含且 `build.ps1` 不遗漏。
4. **Mermaid 首渲染 1–2 秒**（README 已诚实标注）：可选方案是把 parse 放入 Web Worker，卡片上已有"渲染中…"提示，体验可再进一步。
5. **i18n 单文件约 4×200 键内联**：体积可控但可拆为 `locales/*.json` 动态 import 懒加载；顺带支持 `navigator.language` 自动初始语言（当前固定回退 zh-CN）。
---
## 五、工程化建议
- **前端零单测**：为 `preprocess`（脚注/alert 提取，77 行复杂逻辑）、`diagramKindOf`/`sanitizeSvg`、`remoteAllowed` 通配符、`parseMarkdown`、`countStats` 加 vitest 用例；`data-testid` 已全面铺好，**Playwright e2e 成本很低，建议补上**（拖拽打开、split 编辑保存、主题切换）。
- **通配符白名单匹配**：`remoteAllowed` 建议先 `new URL()` 解析、分离 host/path 后再匹配，并统一大小写与端口，防止 `https://evil.com/?next=https://cdn.example.com/*` 这类把域名藏进 query 的绕过。
- **mock 行为对齐真实端**：`mock.ts` 的 `ToggleFavorite` 只返回 boolean 不更新列表，与真实行为不一致；`mockTree` 返回 `any[]` 应为 `MNode[]`。浏览器演示模式才更接近真实。
- **超长函数拆分**：`store.ts initApp`（62 行）、`openFile`（55 行）、`markdown.ts preprocess`（77 行）、`app.go` 多个方法。
- **工具链**：文档未提及 eslint/prettier/golangci-lint，建议入 CI；`go vet` + `gofmt` 至少保证。
- **README 与文件树一致性**：`docs/images/*`、`build.ps1`、`generate-icon.ps1` 被引用但不在树中；exe 体积 badge 写 ~13MB、正文写 ~16MB——统一口径。
- **升级路径**（低优）：TS 4.9→5.x、Vite 3→5/6、plugin-vue 3→5；Wails v3 已发布（新绑定系统类型更强、架构更清晰），可列入中期迁移评估，不急于当下。
---
## 六、保留的亮点
最后强调几个**不要动**的好设计：关联前默认程序备份还原（`FileAssoc` 键）、单实例 + wait-pid 重启机制、Split 编辑"仅预览不写回 + Ctrl+S 才落盘"的安全模型、文件删除后的"保留内容"弹窗、远程拦截默认开启并配白名单、Mind Map 零依赖手写 SVG。这些是同类工具中少见的细节完成度。
**建议的落地顺序**：① 修 API 契约（半日内）→ ② sanitize 单一来源 + vitest 接管回归用例（半日）→ ③ /mdimg 路径校验与 CSP（半日）→ ④ Win11 关联提示 + 窗口越界恢复（一日）→ ⑤ 渲染防抖与测试补齐（持续迭代）。
