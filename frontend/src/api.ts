import type { MNode, FileContent, Entry, Settings, AssocState } from './types'
import * as App from '../bindings/mdview/internal/app/app.js'

/**
 * 前端唯一依赖的后端接口，按领域分组。桌面端由 wails3 生成的 bindings 提供
 * （frontend/bindings/mdview/internal/app），浏览器/无头实测由 mock.ts 提供同形实现。
 */

export interface FileApi {
  GetStartupFile(): Promise<string>
  BuildInfo(): Promise<string>
  OpenFolderDialog(): Promise<string>
  OpenFileDialog(): Promise<string>
  ListTree(dir: string): Promise<MNode[]>
  RefreshTree(dir: string): Promise<MNode[]>
  ReadMarkdown(path: string): Promise<FileContent>
  SaveMarkdown(path: string, content: string, encoding: string): Promise<FileContent>
  AllowImageDir(dir: string): Promise<void>
  SetDraftDirty(dirty: boolean): Promise<void>
  FindByTitle(root: string, title: string): Promise<string>
  FindByTitles(root: string, title: string): Promise<string[]>
  StatFile(path: string): Promise<boolean>
  RevealInShell(path: string): Promise<void>
}

export interface HistoryApi {
  GetHistory(): Promise<Entry[]>
  PushHistory(path: string): Promise<void>
  ClearHistory(): Promise<void>
  RemoveHistory(path: string): Promise<void>
  GetFavorites(): Promise<Entry[]>
  ToggleFavorite(path: string): Promise<boolean>
}

export interface SettingsApi {
  GetSettings(): Promise<Settings>
  SaveSettings(s: Settings): Promise<Settings>
  GetLastError(): Promise<string>
  SetTheme(theme: string): Promise<void>
}

export interface WindowApi {
  WindowPin(pin: boolean): Promise<void>
  WindowMin(): Promise<void>
  WindowMaxToggle(): Promise<void>
  WindowClose(): Promise<void>
  RestartApp(): Promise<void>
  WindowFullscreenToggle(): Promise<void>
  SetWindowTitle(title: string): Promise<void>
}

export interface ExportApi {
  SaveHtmlDialog(title: string, html: string, defaultName: string): Promise<string>
  SaveSvgDialog(title: string, content: string, defaultName: string): Promise<string>
  SaveImageDialog(defaultName: string, dataURL: string): Promise<string>
  CopyText(text: string): Promise<void>
  CopyImage(dataURL: string): Promise<void>
  OpenExternalURL(url: string): Promise<void>
}

export interface AssocApi {
  GetAssocState(): Promise<AssocState>
  AssociateMd(): Promise<void>
  UnassociateMd(): Promise<void>
}

export interface Api extends FileApi, HistoryApi, SettingsApi, WindowApi, ExportApi, AssocApi {}

export function isDesktop(): boolean {
  // v3 运行时自动注入 /wails/runtime.js 并挂载 window._wails；纯浏览器模式不存在
  return typeof window !== 'undefined' && (window as any)._wails !== undefined
}

function desktopApi(): Api {
  // 显式逐项映射：生成的绑定缺失或签名漂移时，vue-tsc 会在编译期报错。
  const api: Api = {
    GetStartupFile: App.GetStartupFile,
    BuildInfo: App.BuildInfo,
    OpenFolderDialog: App.OpenFolderDialog,
    OpenFileDialog: App.OpenFileDialog,
    ListTree: App.ListTree,
    RefreshTree: App.RefreshTree,
    ReadMarkdown: App.ReadMarkdown,
    SaveMarkdown: App.SaveMarkdown,
    AllowImageDir: App.AllowImageDir,
    SetDraftDirty: App.SetDraftDirty,
    FindByTitle: App.FindByTitle,
    FindByTitles: App.FindByTitles,
    StatFile: App.StatFile,
    RevealInShell: App.RevealInShell,
    GetHistory: App.GetHistory,
    PushHistory: App.PushHistory,
    ClearHistory: App.ClearHistory,
    RemoveHistory: App.RemoveHistory,
    GetFavorites: App.GetFavorites,
    ToggleFavorite: App.ToggleFavorite,
    // 生成的 Settings.viewMode 是 string，前端领域类型收窄为 ViewMode；
    // 仅在返回处做一次显式收窄，方法缺失/参数漂移仍由编译期检查。
    GetSettings: async () => (await App.GetSettings()) as unknown as Settings,
    SaveSettings: async (s) => (await App.SaveSettings(s)) as unknown as Settings,
    GetLastError: App.GetLastError,
    SetTheme: App.SetTheme,
    WindowPin: App.WindowPin,
    WindowMin: App.WindowMin,
    WindowMaxToggle: App.WindowMaxToggle,
    WindowClose: App.WindowClose,
    RestartApp: App.RestartApp,
    WindowFullscreenToggle: App.WindowFullscreenToggle,
    SetWindowTitle: App.SetWindowTitle,
    SaveHtmlDialog: App.SaveHtmlDialog,
    SaveSvgDialog: App.SaveSvgDialog,
    SaveImageDialog: App.SaveImageDialog,
    CopyText: App.CopyText,
    CopyImage: App.CopyImage,
    OpenExternalURL: App.OpenExternalURL,
    GetAssocState: App.GetAssocState,
    AssociateMd: App.AssociateMd,
    UnassociateMd: App.UnassociateMd
  }
  if (import.meta.env.DEV) {
    const binding = App as unknown as Record<string, unknown>
    for (const name of Object.keys(api) as (keyof Api)[]) {
      if (typeof binding[name] !== 'function') console.error(`[api] 缺失 Wails 绑定: ${String(name)}`)
    }
  }
  return api
}

let current: Api | null = null

export async function getApi(): Promise<Api> {
  if (current) return current
  current = isDesktop() ? desktopApi() : (await import('./mock')).mockApi
  return current
}
