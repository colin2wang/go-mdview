// ---------- 与 Go 绑定对齐的数据类型 ----------

export interface MNode {
  name: string
  path: string
  isDir: boolean
  children?: MNode[]
}

export interface FileContent {
  path: string
  name: string
  dir: string
  content: string
  encoding: string
  size: number
  modTime: number
}

export interface Entry {
  path: string
  name: string
  dir: string
  exists: boolean
  openedAt: number
}

export interface Settings {
  theme: string // light | dark
  fontSize: number
  codeWrap: boolean
  sidebarWidth: number
  lastFolder: string
  lastFile: string
  pinned: boolean
}

export const defaultSettings: Settings = {
  theme: 'light',
  fontSize: 16,
  codeWrap: false,
  sidebarWidth: 280,
  lastFolder: '',
  lastFile: '',
  pinned: false
}

export interface TocItem {
  id: string
  text: string
  depth: number
}
