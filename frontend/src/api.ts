import type { MNode, FileContent, Entry, Settings, AssocState } from './types'

/**
 * 前端唯一依赖的后端接口。桌面端由 window.go.main.App 提供，
 * 浏览器/无头实测由 mock.ts 提供同形实现。
 */
export interface Api {
  GetStartupFile(): Promise<string>
  BuildInfo(): Promise<string>
  OpenFolderDialog(): Promise<string>
  OpenFileDialog(): Promise<string>
  ListTree(dir: string): Promise<MNode[]>
  RefreshTree(dir: string): Promise<MNode[]>
  ReadMarkdown(path: string): Promise<FileContent>
  SaveMarkdown(path: string, content: string, encoding: string): Promise<FileContent>
  StopWatch(): Promise<void>
  AllowImageDir(dir: string): Promise<void>
  SetDraftDirty(dirty: boolean): Promise<void>
  FindByTitle(root: string, title: string): Promise<string>
  FindByTitles(root: string, title: string): Promise<string[]>
  StatFile(path: string): Promise<boolean>
  GetHistory(): Promise<Entry[]>
  PushHistory(path: string): Promise<void>
  ClearHistory(): Promise<void>
  RemoveHistory(path: string): Promise<void>
  GetFavorites(): Promise<Entry[]>
  ToggleFavorite(path: string): Promise<boolean>
  GetSettings(): Promise<Settings>
  SaveSettings(s: Settings): Promise<Settings>
  GetLastError(): Promise<string>
  SetTheme(theme: string): Promise<void>
  WindowPin(pin: boolean): Promise<void>
  WindowMin(): Promise<void>
  WindowMaxToggle(): Promise<void>
  WindowClose(): Promise<void>
  RestartApp(): Promise<void>
  WindowFullscreenToggle(): Promise<void>
  SetWindowTitle(title: string): Promise<void>
  RevealInShell(path: string): Promise<void>
  SaveHtmlDialog(title: string, html: string, defaultName: string): Promise<string>
  SaveSvgDialog(title: string, content: string, defaultName: string): Promise<string>
  SaveImageDialog(defaultName: string, dataURL: string): Promise<string>
  CopyText(text: string): Promise<void>
  GetAssocState(): Promise<AssocState>
  AssociateMd(): Promise<void>
  UnassociateMd(): Promise<void>
}

export function isDesktop(): boolean {
  // Wails 绑定命名空间随包名变化：main.App（迁移前）/ app.App（迁移后）
  const g: any = typeof window !== 'undefined' ? (window as any).go : undefined
  return g !== undefined && (g?.main?.App !== undefined || g?.app?.App !== undefined)
}

function desktopApi(): Api {
  const g: any = (window as any).go
  const a: any = g.app?.App ?? g.main?.App
  return {
    GetStartupFile: () => a.GetStartupFile(),
    BuildInfo: () => a.BuildInfo(),
    OpenFolderDialog: () => a.OpenFolderDialog(),
    OpenFileDialog: () => a.OpenFileDialog(),
    ListTree: (d) => a.ListTree(d),
    RefreshTree: (d) => (a.RefreshTree ? a.RefreshTree(d) : a.ListTree(d)),
    ReadMarkdown: (p) => a.ReadMarkdown(p),
    SaveMarkdown: (p, c, e) => a.SaveMarkdown(p, c, e),
    StopWatch: () => a.StopWatch(),
    // 新增绑定需重新 wails build 才会生成到 window.go；生成前用可选调用兜底，避免早期版本报错。
    AllowImageDir: (d) => (a.AllowImageDir ? a.AllowImageDir(d) : Promise.resolve()),
    SetDraftDirty: (d) => (a.SetDraftDirty ? a.SetDraftDirty(d) : Promise.resolve()),
    FindByTitle: (r, t) => a.FindByTitle(r, t),
    FindByTitles: (r, t) => (a.FindByTitles ? a.FindByTitles(r, t) : a.FindByTitle(r, t).then((p: string) => (p ? [p] : []))),
    StatFile: (p) => a.StatFile(p),
    GetHistory: () => a.GetHistory(),
    PushHistory: (p) => a.PushHistory(p),
    ClearHistory: () => a.ClearHistory(),
    RemoveHistory: (p) => (a.RemoveHistory ? a.RemoveHistory(p) : Promise.resolve()),
    GetFavorites: () => a.GetFavorites(),
    ToggleFavorite: (p) => a.ToggleFavorite(p),
    GetSettings: () => a.GetSettings(),
    SaveSettings: (s) => a.SaveSettings(s),
    GetLastError: () => (a.GetLastError ? a.GetLastError() : Promise.resolve('')),
    SetTheme: (t) => a.SetTheme(t),
    WindowPin: (b) => a.WindowPin(b),
    WindowMin: () => a.WindowMin(),
    WindowMaxToggle: () => a.WindowMaxToggle(),
    WindowClose: () => a.WindowClose(),
    RestartApp: () => a.RestartApp(),
    WindowFullscreenToggle: () => a.WindowFullscreenToggle(),
    SetWindowTitle: (t) => a.SetWindowTitle(t),
    RevealInShell: (p) => a.RevealInShell(p),
    SaveHtmlDialog: (t, h, d) => a.SaveHtmlDialog(t, h, d),
    SaveSvgDialog: (t, c, d) => a.SaveSvgDialog(t, c, d),
    SaveImageDialog: (d, u) => a.SaveImageDialog(d, u),
    CopyText: (t) => a.CopyText(t),
    GetAssocState: () => a.GetAssocState(),
    AssociateMd: () => a.AssociateMd(),
    UnassociateMd: () => a.UnassociateMd()
  }
}

let current: Api | null = null

export async function getApi(): Promise<Api> {
  if (current) return current
  current = isDesktop() ? desktopApi() : (await import('./mock')).mockApi
  return current
}
