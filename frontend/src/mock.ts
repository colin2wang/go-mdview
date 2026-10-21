import type { Api, } from './api'
import type { AssocState, Entry, FileContent, MNode, Settings } from './types'
import { DEMO_MD, DEMO_IMAGE_SVG, fileBase, fileToDir, mockTree } from './demo'

/**
 * 浏览器 / 无头实测用 Mock 实现：内存态 + 与桌面端同形返回。
 * window.go 不存在时由 api.ts 自动切换到本实现。
 */

const state = {
  settings: {
    theme: 'light',
    fontSize: 16,
    codeWrap: false,
    sidebarWidth: 280,
    lastFolder: 'C:\\Users\\wangb\\OneDrive\\Obsidian\\迷你狐的知识库\\01-计算机技术\\编程语言\\Java',
    lastFile: '',
    pinned: false,
    viewMode: 'render'
  } as Settings,
  history: [] as Entry[],
  favorites: [] as Entry[],
  openEvents: [] as string[]
}

// 浏览器/Mock 模式下没有注册表，关联状态只做内存态模拟
export const mockAssoc: AssocState = {
  supported: false,
  exePath: '',
  associated: false,
  owner: '（未设置）',
  message: '浏览器模式不支持文件关联'
}

function mdPath(title: string): string {
  const d = 'C:\\Users\\wangb\\OneDrive\\Obsidian\\迷你狐的知识库\\01-计算机技术\\编程语言\\Java'
  return `${d}\\${title}`
}

function fakeContent(path: string): FileContent {
  const name = fileBase(path)
  const body = name.startsWith('16-') || name.includes('JVM 与性能调优')
    ? DEMO_MD
    : `# ${name.replace(/\.md$/i, '')}\n\n> [!TIP]\n> 这是 Mock 模式下的占位笔记。\n\n## 要点\n\n- 列表项一\n- 列表项二 \`code\`\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n`
  return {
    path,
    name,
    dir: fileToDir(path),
    content: body,
    encoding: 'utf-8',
    size: body.length,
    modTime: Date.now() - 86400000
  }
}

export const mockApi: Api = {
  GetStartupFile: async () => '',
  OpenFolderDialog: async () => state.settings.lastFolder,
  OpenFileDialog: async () => mdPath('16-JVM 与性能调优.md'),
  ListTree: async (_dir) => mockTree() as unknown as MNode[],
  ReadMarkdown: async (path) => fakeContent(path),
  FindByTitle: async (_root, title) => mdPath(title.endsWith('.md') ? title : title + '.md'),
  StatFile: async () => true,
  GetHistory: async () => [...state.history],
  PushHistory: async (path) => {
    state.history = state.history.filter((e) => e.path !== path)
    state.history.unshift({
      path,
      name: fileBase(path),
      dir: fileToDir(path),
      exists: true,
      openedAt: Math.floor(Date.now() / 1000)
    })
  },
  ClearHistory: async () => {
    state.history = []
  },
  GetFavorites: async () => [...state.favorites],
  ToggleFavorite: async (path) => {
    const i = state.favorites.findIndex((e) => e.path === path)
    if (i >= 0) {
      state.favorites.splice(i, 1)
      return false
    }
    state.favorites.push({
      path,
      name: fileBase(path),
      dir: fileToDir(path),
      exists: true,
      openedAt: Math.floor(Date.now() / 1000)
    })
    return true
  },
  GetSettings: async () => ({ ...state.settings }),
  SaveSettings: async (s) => {
    state.settings = { ...s }
    return { ...state.settings }
  },
  SetTheme: async (t) => {
    state.settings.theme = t
  },
  WindowPin: async (b) => {
    state.settings.pinned = b
  },
  WindowMin: async () => undefined,
  WindowMaxToggle: async () => undefined,
  WindowClose: async () => undefined,
  WindowFullscreenToggle: async () => undefined,
  SetWindowTitle: async () => {
    document.title = String(document.title) // no-op，保持可断言
  },
  RevealInShell: async () => undefined,
  SaveHtmlDialog: async (_t, _h, name) => `mock://${name}`,
  CopyText: async (t) => {
    try {
      await navigator.clipboard.writeText(t)
    } catch {
      /* 无头环境忽略 */
    }
  },
  GetAssocState: async () => ({ ...mockAssoc }),
  AssociateMd: async () => {
    mockAssoc.associated = true
    mockAssoc.owner = 'mdview'
  },
  UnassociateMd: async () => {
    mockAssoc.associated = false
    mockAssoc.owner = '（未设置）'
  }
}

// 供无头实测派发"拖拽打开"事件
export function dispatchMockOpenFile(path: string) {
  state.openEvents.push(path)
  window.dispatchEvent(new CustomEvent('mdv:mock-openfile', { detail: path }))
}

// 内置示例图片：将 demo.md 里的 assets/sample.svg 映射到 data URI
export function mockImageHref(): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(DEMO_IMAGE_SVG)
}

export const mockState = state
