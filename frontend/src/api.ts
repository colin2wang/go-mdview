import type { MNode, FileContent, Entry, Settings, AssocState } from './types'
import * as App from '../bindings/mdview/internal/app/app.js'

/**
 * 前端唯一依赖的后端接口。桌面端由 wails3 生成的 bindings 提供
 * （frontend/bindings/mdview/internal/app），浏览器/无头实测由 mock.ts 提供同形实现。
 * 类型直接从生成物派生，避免手写接口与 Go 侧漂移。
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
  CopyImage(dataURL: string): Promise<void>
  OpenExternalURL(url: string): Promise<void>
  GetAssocState(): Promise<AssocState>
  AssociateMd(): Promise<void>
  UnassociateMd(): Promise<void>
}

export function isDesktop(): boolean {
  // v3 运行时自动注入 /wails/runtime.js 并挂载 window._wails；纯浏览器模式不存在
  return typeof window !== 'undefined' && (window as any)._wails !== undefined
}

function desktopApi(): Api {
  // 生成的绑定即同形函数集，直接转发；方法名与 Go 侧一一对应
  return App as unknown as Api
}

let current: Api | null = null

export async function getApi(): Promise<Api> {
  if (current) return current
  current = isDesktop() ? desktopApi() : (await import('./mock')).mockApi
  return current
}
