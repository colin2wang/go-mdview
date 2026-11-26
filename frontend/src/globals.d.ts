/// <reference types="vite/client" />

// CodeMirror 5 的 mode / addon 是纯副作用的 JS 文件，没有类型声明，
// 这里用通配声明放行（只 import 不取绑定，不影响类型检查）
declare module 'codemirror/mode/*'
declare module 'codemirror/addon/*'

// Wails v3 桌面端注入的运行时标志（/wails/runtime.js 自动挂载，
// 浏览器/Mock 模式下不存在）。绑定经 frontend/bindings 导入，不再有 window.go。
interface Window {
  // WebView2/Chromium 私有 API，TS DOM 声明里没有
  find: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean) => boolean
  _wails?: Record<string, any>
  // 本地静态脚本注入的 Mermaid 渲染引擎（mermaid.min.js / pele.global.js）
  mermaid?: Record<string, any>
  pele?: Record<string, any>
}
