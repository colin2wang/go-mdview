/// <reference types="vite/client" />

// Wails 桌面端注入的绑定与运行时（浏览器/Mock 模式下不存在）
interface Window {
  go?: {
    main: {
      App: Record<string, (...args: any[]) => Promise<any>>
    }
  }
  runtime?: {
    EventsOn: (name: string, cb: (...data: any[]) => void) => void
    EventsOff: (name: string) => void
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
