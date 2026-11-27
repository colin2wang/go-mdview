/// <reference types="vite/client" />

// CodeMirror 5 modes/addons are side-effect-only JS files without type
// declarations; wildcard declarations allow the imports (import only, no
// bindings taken, type checking is unaffected)
declare module 'codemirror/mode/*'
declare module 'codemirror/addon/*'

// katex 0.16.47 does not declare a types entry in package.json exports, so
// Node resolution cannot find dist/katex.d.ts; minimal declarations for the
// two ESM entry points used by the project.
declare module 'katex' {
  const katex: any
  export default katex
}
declare module 'katex/contrib/auto-render' {
  const renderMathInElement: (el: Element, options?: Record<string, any>) => void
  export default renderMathInElement
}

// Runtime flag injected by the Wails v3 desktop shell (/wails/runtime.js is
// mounted automatically; absent in browser/mock mode). Bindings are imported
// via frontend/bindings; there is no window.go.
interface Window {
  // WebView2/Chromium private API, missing from the TS DOM declarations
  find: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean) => boolean
  _wails?: Record<string, any>
}
