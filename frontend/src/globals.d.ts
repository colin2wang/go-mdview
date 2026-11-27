/// <reference types="vite/client" />

// CodeMirror 5 的 mode / addon 是纯副作用的 JS 文件，没有类型声明，
// 这里用通配声明放行（只 import 不取绑定，不影响类型检查）
declare module 'codemirror/mode/*'
declare module 'codemirror/addon/*'

// katex 0.16.47 的 package.json 仍未在 exports 中声明类型入口，项目的 Node
// 解析模式找不到 dist/katex.d.ts；这里给实际用到的两个 ESM 入口补最小声明。
declare module 'katex' {
  const katex: any
  export default katex
}
declare module 'katex/contrib/auto-render' {
  const renderMathInElement: (el: Element, options?: Record<string, any>) => void
  export default renderMathInElement
}

// Wails v3 桌面端注入的运行时标志（/wails/runtime.js 自动挂载，
// 浏览器/Mock 模式下不存在）。绑定经 frontend/bindings 导入，不再有 window.go。
interface Window {
  // WebView2/Chromium 私有 API，TS DOM 声明里没有
  find: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean) => boolean
  _wails?: Record<string, any>
}
