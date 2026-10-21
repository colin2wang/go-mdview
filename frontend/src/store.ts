import { reactive } from 'vue'
import type { Entry, FileContent, MNode, Settings, TocItem } from './types'
import { defaultSettings } from './types'
import { getApi, isDesktop } from './api'
import { fileBase, fileToDir } from './demo'
import { renderMarkdown } from './markdown'

export type TabKey = 'toc' | 'history' | 'fav' | 'files'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export const store = reactive({
  ready: false,
  desktop: false,
  tab: 'files' as TabKey,
  settings: null as Settings | null,
  tree: [] as MNode[],
  rootName: '',
  current: null as FileContent | null,
  html: '',
  toc: [] as TocItem[],
  activeHeading: '',
  hasMath: false,
  hasMermaid: false,
  history: [] as Entry[],
  favorites: [] as Entry[],
  toasts: [] as Toast[],
  settingsOpen: false,
  showSource: false,
  demoMode: false,
  rendering: false
})

let toastSeq = 0
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const id = ++toastSeq
  store.toasts.push({ id, text, kind })
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, 2600)
}

function favOf(path: string): boolean {
  return store.favorites.some((f) => f.path === path)
}

// ---------- 渲染 ----------

async function renderCurrent(fc: FileContent) {
  store.rendering = true
  store.hasMath = false
  store.hasMermaid = false
  try {
    const r = await renderMarkdown(fc.content, fc.dir)
    store.html = r.html
    store.toc = r.toc
    store.hasMath = r.hasMath
    store.hasMermaid = r.hasMermaid
  } catch (e) {
    store.html = `<div class="render-error"><h3>渲染失败</h3><pre>${String(e)}</pre></div>`
  } finally {
    store.rendering = false
  }
}

// ---------- 打开 ----------

export async function openFile(path: string, opts: { pushHistory?: boolean } = {}) {
  const api = await getApi()
  try {
    const fc = await api.ReadMarkdown(path)
    store.current = fc
    store.demoMode = false
    await renderCurrent(fc)
    const dir = fileToDir(path)
    if (dir !== store.rootName) {
      store.rootName = dir
      try {
        store.tree = await api.ListTree(dir)
      } catch {
        store.tree = []
      }
    }
    if (opts.pushHistory !== false) {
      api.PushHistory(path).then(() => api.GetHistory().then((h) => (store.history = h)))
    }
    const st = { ...store.settings! }
    st.lastFile = path
    st.lastFolder = dir
    store.settings = st
    api.SaveSettings(st)
    api.SetWindowTitle(`${path} - mdview`)
  } catch (e) {
    toast(`打开失败：${fileBase(path)}`, 'error')
  }
}

export async function refreshTree() {
  const dir = store.rootName || store.settings?.lastFolder
  if (!dir) {
    toast('先在「文件」页选择一个目录')
    return
  }
  const api = await getApi()
  try {
    store.tree = await api.ListTree(dir)
    const mdCount = countMd(store.tree)
    toast(mdCount ? `已刷新，找到 ${mdCount} 个笔记` : '目录里没有 .md 文件')
  } catch {
    toast('目录不可访问', 'error')
  }
}

export async function openFolder() {
  const api = await getApi()
  let dir: string
  try {
    dir = await api.OpenFolderDialog()
  } catch (e) {
    toast(`打开目录失败：${String(e)}`, 'error')
    return
  }
  if (!dir) return
  let tree: MNode[]
  try {
    tree = await api.ListTree(dir)
  } catch {
    toast('目录不可访问', 'error')
    return
  }
  store.rootName = dir
  store.tree = tree
  const st = { ...store.settings!, lastFolder: dir }
  store.settings = st
  api.SaveSettings(st)
  const mdCount = countMd(tree)
  toast(mdCount ? `已载入目录，找到 ${mdCount} 个笔记` : '目录里没有 .md 文件')
}

function countMd(nodes: MNode[]): number {
  let n = 0
  for (const x of nodes) n += x.isDir ? countMd(x.children ?? []) : 1
  return n
}

export async function openWikiLink(title: string) {
  if (!store.current) return
  const api = await getApi()
  const hit = await api.FindByTitle(fileToDir(store.current.path), title)
  if (hit) await openFile(hit)
  else toast(`未找到笔记「${title}」`)
}

// ---------- 收藏/历史 ----------

/** 面板/右键菜单统一入口：文件不存在时给出提示。 */
export async function openEntry(path: string) {
  if (!path) {
    toast('该文件不提供路径信息（浏览器模式下拖拽受限）', 'error')
    return
  }
  const api = await getApi()
  const ok = await api.StatFile(path)
  if (!ok) {
    toast('文件不存在或已被移动', 'error')
    return
  }
  await openFile(path)
}

export async function toggleFavorite(path: string) {
  await toggleFav(path)
}

export async function toggleFav(path: string) {
  const api = await getApi()
  const now = await api.ToggleFavorite(path)
  store.favorites = await api.GetFavorites()
  toast(now ? '已加入收藏 ★' : '已取消收藏')
}

export function isFav(path: string): boolean {
  return favOf(path)
}

export async function clearHistory() {
  const api = await getApi()
  await api.ClearHistory()
  store.history = []
}

// ---------- 源码视图 ----------

/** 标题栏「显示源码」：在渲染正文与 md 原始文本之间切换。 */
export function toggleSource() {
  store.showSource = !store.showSource
}

// ---------- 设置 ----------

/** 把设置落到 DOM：主题类、正文字号变量、代码高亮主题联动。 */
export async function applySettings(st: Settings | null = store.settings) {
  const theme: string = st?.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.setProperty('--md-fs', `${st?.fontSize ?? 16}px`)
  const hljsDark = document.getElementById('mdv-hljs-dark') as HTMLLinkElement | null
  const hljsLight = document.getElementById('mdv-hljs-light') as HTMLLinkElement | null
  if (hljsDark) hljsDark.disabled = theme !== 'dark'
  if (hljsLight) hljsLight.disabled = theme === 'dark'
}

export async function applyTheme(theme: string) {
  await applySettings({ ...(store.settings ?? defaultSettings), theme })
}

export async function setTheme(theme: string) {
  store.settings = { ...store.settings!, theme }
  await applySettings(store.settings)
  const api = await getApi()
  api.SetTheme(theme)
  api.SaveSettings(store.settings)
}

export async function patchSettings(patch: Partial<Settings>) {
  const st = { ...store.settings!, ...patch }
  store.settings = st
  await applySettings(st)
  const api = await getApi()
  if (patch.theme !== undefined) api.SetTheme(st.theme)
  api.SaveSettings(st)
}

// ---------- 窗口 ----------

export async function togglePin() {
  const st = { ...store.settings!, pinned: !store.settings!.pinned }
  store.settings = st
  const api = await getApi()
  api.WindowPin(st.pinned)
  api.SaveSettings(st)
}

// ---------- 导出 ----------

export async function exportHtml() {
  if (!store.current) {
    toast('没有打开的文件', 'error')
    return
  }
  const api = await getApi()
  const art = document.querySelector('.md-article')
  const inner = art ? art.innerHTML : store.html
  const out = await api.SaveHtmlDialog(
    fileBase(store.current.path).replace(/\.md$/i, ''),
    inner,
    fileBase(store.current.path).replace(/\.md$/i, '') + '.html'
  )
  if (out) toast(`已导出：${fileBase(out)}`)
}

export function copyPath(path: string) {
  getApi().then((api) => api.CopyText(path)).then(() => toast('路径已复制'))
}

// ---------- 初始化 ----------

async function handleOpenEvent(path: string) {
  await openFile(path)
  store.tab = 'toc'
}

export async function initApp() {
  const api = await getApi()
  store.desktop = isDesktop()
  store.settings = await api.GetSettings()
  store.history = await api.GetHistory()
  store.favorites = await api.GetFavorites()
  // highlight.js 双主题样式：applySettings 靠 link.disabled 切换
  try {
    const { loadCss } = await import('./vendor')
    await loadCss('/static/github.min.css', 'mdv-hljs-light')
    await loadCss('/static/github-dark.min.css', 'mdv-hljs-dark')
  } catch {
    /* 样式缺失不阻塞启动 */
  }
  await applySettings(store.settings)
  if (store.settings.pinned) api.WindowPin(true)

  if (store.settings.lastFolder) {
    try {
      store.tree = await api.ListTree(store.settings.lastFolder)
      store.rootName = store.settings.lastFolder
    } catch {
      store.tree = []
    }
  }

  const startup = await api.GetStartupFile()
  if (startup) {
    await handleOpenEvent(startup)
  } else if (store.settings.lastFile) {
    const ok = await api.StatFile(store.settings.lastFile)
    if (ok) await openFile(store.settings.lastFile, { pushHistory: false })
  }

  if (!store.current) {
    // 空状态：不渲染内置示例，等待用户打开文件/目录
    store.demoMode = false
    store.html = ''
  }

  if (isDesktop()) {
    const rt = (window as any).runtime
    rt?.EventsOn?.('mdv:openfile', (p: string) => handleOpenEvent(p))
    // Windows 下必须由 JS 端调用 OnFileDrop，drop 事件才会生效（Wails v2 已知问题 #3985）
    rt?.OnFileDrop?.((_x: number, _y: number, paths: string[]) => {
      for (const p of paths) {
        if (/\.(md|markdown|mdown|mkd)$/i.test(p)) {
          handleOpenEvent(p)
          return
        }
      }
    }, false)
  } else {
    window.addEventListener('mdv:mock-openfile', (e) => {
      handleOpenEvent((e as CustomEvent).detail as string)
    })
  }

  store.ready = true
}
