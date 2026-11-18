/// <reference types="vite/client" />

// CodeMirror 5 的 mode / addon 是纯副作用的 JS 文件，没有类型声明，
// 这里用通配声明放行（只 import 不取绑定，不影响类型检查）
declare module 'codemirror/mode/*'
declare module 'codemirror/addon/*'

// Wails 桌面端注入的绑定与运行时（浏览器/Mock 模式下不存在）
// 包名已从 main 迁到 internal/app：实际命名空间是 go.app.App，保留 main 兼容旧构建。
type WailsBinding = Record<string, (...args: any[]) => Promise<any>>

interface Window {
  // WebView2/Chromium 私有 API，TS DOM 声明里没有
  find: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean) => boolean
  go?: {
    app?: { App: WailsBinding }
    main?: { App: WailsBinding }
  }
  runtime?: {
    EventsOn: (name: string, cb: (...data: any[]) => void) => () => void
    EventsOff: (name: string, ...additional: string[]) => void
    EventsEmit: (name: string, ...data: any[]) => void
    OnFileDrop: (callback: (x: number, y: number, paths: string[]) => void, useDropTarget: boolean) => void
    OnFileDropOff: () => void
    WindowMinimise: () => void
    WindowToggleMaximise: () => void
    Quit: () => void
    WindowSetTitle: (title: string) => void
    WindowSetAlwaysOnTop: (b: boolean) => void
    WindowFullscreen: () => void
    WindowUnfullscreen: () => void
    BrowserOpenURL: (url: string) => void
    ClipboardSetText: (text: string) => Promise<boolean>
  }
}
