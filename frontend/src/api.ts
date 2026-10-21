import type { MNode, FileContent, Entry, Settings, AssocState } from './types'

/**
 * 前端唯一依赖的后端接口。桌面端由 window.go.main.App 提供，
 * 浏览器/无头实测由 mock.ts 提供同形实现。
 */
export interface Api {
  GetStartupFile(): Promise<string>
  OpenFolderDialog(): Promise<string>
  OpenFileDialog(): Promise<string>
  ListTree(dir: string): Promise<MNode[]>
  ReadMarkdown(path: string): Promise<FileContent>
  FindByTitle(root: string, title: string): Promise<string>
  StatFile(path: string): Promise<boolean>
  GetHistory(): Promise<Entry[]>
  PushHistory(path: string): Promise<void>
  ClearHistory(): Promise<void>
  GetFavorites(): Promise<Entry[]>
  ToggleFavorite(path: string): Promise<boolean>
  GetSettings(): Promise<Settings>
  SaveSettings(s: Settings): Promise<Settings>
  SetTheme(theme: string): Promise<void>
  WindowPin(pin: boolean): Promise<void>
  WindowMin(): Promise<void>
  WindowMaxToggle(): Promise<void>
  WindowClose(): Promise<void>
  WindowFullscreenToggle(): Promise<void>
  SetWindowTitle(title: string): Promise<void>
  RevealInShell(path: string): Promise<void>
  SaveHtmlDialog(title: string, html: string, defaultName: string): Promise<string>
  CopyText(text: string): Promise<void>
  GetAssocState(): Promise<AssocState>
  AssociateMd(): Promise<void>
  UnassociateMd(): Promise<void>
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && (window as any).go !== undefined && (window as any).go?.main?.App !== undefined
}

function desktopApi(): Api {
  const a: any = (window as any).go.main.App
  return {
    GetStartupFile: () => a.GetStartupFile(),
    OpenFolderDialog: () => a.OpenFolderDialog(),
    OpenFileDialog: () => a.OpenFileDialog(),
    ListTree: (d) => a.ListTree(d),
    ReadMarkdown: (p) => a.ReadMarkdown(p),
    FindByTitle: (r, t) => a.FindByTitle(r, t),
    StatFile: (p) => a.StatFile(p),
    GetHistory: () => a.GetHistory(),
    PushHistory: (p) => a.PushHistory(p),
    ClearHistory: () => a.ClearHistory(),
    GetFavorites: () => a.GetFavorites(),
    ToggleFavorite: (p) => a.ToggleFavorite(p),
    GetSettings: () => a.GetSettings(),
    SaveSettings: (s) => a.SaveSettings(s),
    SetTheme: (t) => a.SetTheme(t),
    WindowPin: (b) => a.WindowPin(b),
    WindowMin: () => a.WindowMin(),
    WindowMaxToggle: () => a.WindowMaxToggle(),
    WindowClose: () => a.WindowClose(),
    WindowFullscreenToggle: () => a.WindowFullscreenToggle(),
    SetWindowTitle: (t) => a.SetWindowTitle(t),
    RevealInShell: (p) => a.RevealInShell(p),
    SaveHtmlDialog: (t, h, d) => a.SaveHtmlDialog(t, h, d),
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
