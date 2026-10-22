// ---------- 与 Go 绑定对齐的数据类型 ----------

export interface MNode {
  name: string
  path: string
  isDir: boolean
  supported?: boolean
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
  /** 文件类别：markdown 渲染 / image 图片预览 / text 纯文本预览（缺省按 markdown） */
  kind?: 'markdown' | 'image' | 'text'
}

export interface Entry {
  path: string
  name: string
  dir: string
  exists: boolean
  openedAt: number
}

/** 正文显示模式：仅渲染 / 仅源码 / 左右对照。 */
export type ViewMode = 'render' | 'source' | 'split'

export interface Settings {
  theme: string // light | dark
  fontSize: number
  codeWrap: boolean
  sidebarWidth: number
  lastFolder: string
  lastFile: string
  pinned: boolean
  viewMode: ViewMode
}

export const defaultSettings: Settings = {
  theme: 'light',
  fontSize: 16,
  codeWrap: false,
  sidebarWidth: 280,
  lastFolder: '',
  lastFile: '',
  pinned: false,
  viewMode: 'render'
}

export interface TocItem {
  id: string
  text: string
  depth: number
}

/** 文件关联状态（Go: mdv.AssocState）。 */
export interface AssocState {
  supported: boolean
  exePath: string
  associated: boolean
  owner: string
  message: string
}

export const defaultAssocState: AssocState = {
  supported: false,
  exePath: '',
  associated: false,
  owner: '（未设置）',
  message: ''
}
