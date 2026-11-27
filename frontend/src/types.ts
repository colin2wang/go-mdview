// ---------- Data types aligned with the Go bindings ----------

/** CSS variables the code max-line limit is written to (order: code block / error source / diagram source). */
export const CODE_MAX_CSS_VARS = ['--code-max-h', '--code-max-h-dia', '--code-max-h-diagram'] as const

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
  /** File kind: markdown renders, image previews, text shows as plain text (defaults to markdown) */
  kind?: 'markdown' | 'image' | 'text'
}

export interface Entry {
  path: string
  name: string
  dir: string
  exists: boolean
  openedAt: number
}

/** Body display mode: render only / source only / side-by-side / mind map. */
export type ViewMode = 'render' | 'source' | 'split' | 'mindmap'

/** Mermaid diagram engine: classic mermaid.js or lightweight pele. */
export type MermaidEngine = 'mermaid' | 'pele'

export interface Settings {
  theme: string // light | dark
  fontSize: number
  codeWrap: boolean
  lineNo: boolean // show line numbers in the source pane (edit and read-only)
  codeBlockLineNo: boolean // show line numbers in rendered code blocks and diagram source, default on
  sidebarWidth: number
  lastFolder: string
  lastFile: string
  pinned: boolean
  viewMode: ViewMode
  language: string // UI language: zh-CN | en | ja | de
  autoReload: boolean // reload on external modification, default on
  blockRemote: boolean // block remote http(s) resources (images etc.), default on
  remoteAllow: string // remote whitelist: URL wildcards (* ?), one per line, a match allows access
  useYaml: boolean // use exe-adjacent mdview.yml as config source (preferred over settings.json when present)
  mmMaxLen: number // mind map node/note single-line max characters (wraps beyond), default 20
  codeMaxLines: number // max visible lines in rendered code blocks (0 = unlimited), default 20
  mermaidEngine: MermaidEngine // Mermaid diagram engine, default pele
  // Window geometry on last close (0 = not recorded) and maximized flag, maintained by the Go side
  winW: number
  winH: number
  winX: number
  winY: number
  winMax: boolean
}

export const defaultSettings: Settings = {
  theme: 'light',
  fontSize: 16,
  codeWrap: false,
  lineNo: true,
  codeBlockLineNo: true,
  sidebarWidth: 280,
  lastFolder: '',
  lastFile: '',
  pinned: false,
  viewMode: 'render',
  language: 'zh-CN',
  autoReload: true,
  blockRemote: true,
  remoteAllow: '',
  useYaml: false,
  mmMaxLen: 20,
  codeMaxLines: 20,
  mermaidEngine: 'pele',
  winW: 0,
  winH: 0,
  winX: 0,
  winY: 0,
  winMax: false
}

export interface TocItem {
  id: string
  text: string
  depth: number
}

/** TOC tree node: TocItem plus children */
export interface TocEntry extends TocItem {
  children: TocEntry[]
}

/** File association state (Go: mdv.AssocState). */
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
  owner: '',
  message: ''
}
