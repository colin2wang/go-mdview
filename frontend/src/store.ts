import { reactive } from 'vue'
import type { Entry, FileContent, MNode, Settings, TocItem, ViewMode } from './types'
import { defaultSettings } from './types'
import { getApi, isDesktop } from './api'
import { fileBase, fileToDir } from './demo'
import { renderMarkdown, resolveImgHref } from './markdown'
import { setLang, t } from './i18n'

export type TabKey = 'toc' | 'history' | 'fav' | 'files'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export const store = reactive({
  ready: false,
  desktop: false,
  tab: 'toc' as TabKey,
  settings: null as Settings | null,
  tree: [] as MNode[],
  rootName: '',
  current: null as FileContent | null,
  currentKind: 'markdown' as 'markdown' | 'image' | 'text',
  imgUrl: '',
  html: '',
  toc: [] as TocItem[],
  activeHeading: '',
  hasMath: false,
  hasMermaid: false,
  history: [] as Entry[],
  favorites: [] as Entry[],
  toasts: [] as Toast[],
  settingsOpen: false,
  viewMode: 'render' as ViewMode,
  demoMode: false,
  rendering: false
})

/** 非法/缺失的 viewMode 回落到 render。 */
function normalizeViewMode(v: unknown): ViewMode {
  return v === 'source' || v === 'split' ? v : 'render'
}

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

/**
 * 对照模式的源码编辑：用编辑中的草稿重渲染正文。
 * 只改内存里的渲染结果，不写回文件、不记历史；解析失败时保留上一次结果。
 */
let draftSeq = 0
export async function renderDraft(md: string) {
  const fc = store.current
  if (!fc) return
  const seq = ++draftSeq
  store.rendering = true
  try {
    const r = await renderMarkdown(md, fc.dir)
    if (seq !== draftSeq) return // 已有更新的草稿，丢弃过期结果
    store.html = r.html
    store.toc = r.toc
    store.hasMath = r.hasMath
    store.hasMermaid = r.hasMermaid
  } catch {
    /* 输入中途解析失败：保留上一次渲染结果 */
  } finally {
    if (seq === draftSeq) store.rendering = false
  }
}

/** 保存编辑后的正文回原文件（源码/对照模式的「保存」按钮）。 */
export async function saveSource(md: string): Promise<boolean> {
  const cur = store.current
  if (!cur) return false
  try {
    const api = await getApi()
    const fc = await api.SaveMarkdown(cur.path, md, cur.encoding)
    store.current = fc
    toast(t('toast.saved'))
    return true
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
    return false
  }
}

// ---------- 打开 ----------

const MD_KIND_EXTS = ['md', 'markdown', 'mdown', 'mkd']
const IMG_KIND_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

/** 按扩展名判断文件类别，决定查看器渲染方式。 */
export function fileKind(path: string): 'markdown' | 'image' | 'text' {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (MD_KIND_EXTS.includes(ext)) return 'markdown'
  if (IMG_KIND_EXTS.includes(ext)) return 'image'
  return 'text'
}

export async function openFile(path: string, opts: { pushHistory?: boolean; reRoot?: boolean } = {}) {
  const api = await getApi()
  const kind = fileKind(path)
  try {
    if (kind === 'image') {
      // 图片：不走文本读取，直接用 /mdimg 回放路由
      store.current = {
        path, name: fileBase(path), dir: fileToDir(path),
        content: '', encoding: '', size: 0, modTime: 0, kind: 'image'
      }
      store.currentKind = 'image'
      store.demoMode = false
      store.html = ''
      store.toc = []
      store.hasMath = false
      store.hasMermaid = false
      store.imgUrl = resolveImgHref(path, '')
    } else {
      const fc = await api.ReadMarkdown(path)
      fc.kind = kind === 'markdown' ? 'markdown' : 'text'
      store.current = fc
      store.currentKind = fc.kind
      store.demoMode = false
      if (fc.kind === 'markdown') {
        await renderCurrent(fc)
      } else {
        // 纯文本：不渲染 Markdown，直接整段展示
        store.html = ''
        store.toc = []
        store.hasMath = false
        store.hasMermaid = false
      }
    }
    // 默认保持文件夹树停留在记忆的目录；仅关联打开/拖拽入口传 reRoot 切到文件所在目录
    const dir = fileToDir(path)
    if (opts.reRoot && dir !== store.rootName) {
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
    const st = { ...(store.settings ?? defaultSettings), lastFile: path, lastFolder: dir }
    store.settings = st
    api.SaveSettings(st)
    api.SetWindowTitle(`${path} - mdview`)
  } catch (e) {
    toast(t('toast.openFailed', { e: fileBase(path) }), 'error')
  }
}

export async function refreshTree() {
  const dir = store.rootName || store.settings?.lastFolder
  if (!dir) {
    toast(t('toast.selectFolderFirst'))
    return
  }
  const api = await getApi()
  try {
    store.tree = await api.ListTree(dir)
    const mdCount = countMd(store.tree)
    toast(mdCount ? t('toast.refreshed', { n: mdCount }) : t('toast.noNotes'))
  } catch {
    toast(t('toast.dirInaccessible'), 'error')
  }
}

export async function openFolder() {
  const api = await getApi()
  let dir: string
  try {
    dir = await api.OpenFolderDialog()
  } catch (e) {
    toast(t('toast.openFolderFailed', { e: String(e) }), 'error')
    return
  }
  if (!dir) return
  let tree: MNode[]
  try {
    tree = await api.ListTree(dir)
  } catch {
    toast(t('toast.dirInaccessible'), 'error')
    return
  }
  store.rootName = dir
  store.tree = tree
  const st = { ...(store.settings ?? defaultSettings), lastFolder: dir }
  store.settings = st
  api.SaveSettings(st)
  const mdCount = countMd(tree)
  toast(mdCount ? t('toast.loadedFolder', { n: mdCount }) : t('toast.noNotes'))
}

export function countMd(nodes: MNode[]): number {
  let n = 0
  for (const x of nodes) {
    if (x.isDir) n += countMd(x.children ?? [])
    else if (x.supported !== false) n++
  }
  return n
}

export async function openWikiLink(title: string) {
  if (!store.current) return
  const api = await getApi()
  const hit = await api.FindByTitle(fileToDir(store.current.path), title)
  if (hit) await openFile(hit)
  else toast(t('toast.noteNotFound', { title }))
}

// ---------- 收藏/历史 ----------

/** 面板/右键菜单统一入口：文件不存在时给出提示。reRoot 透传给 openFile（切换文件夹树根）。 */
export async function openEntry(path: string, opts: { pushHistory?: boolean; reRoot?: boolean } = {}) {
  if (!path) {
    toast(t('toast.noPathInfo'), 'error')
    return
  }
  const api = await getApi()
  const ok = await api.StatFile(path)
  if (!ok) {
    toast(t('toast.fileMissing'), 'error')
    return
  }
  await openFile(path, opts)
}

export async function toggleFavorite(path: string) {
  await toggleFav(path)
}

export async function toggleFav(path: string) {
  const api = await getApi()
  const now = await api.ToggleFavorite(path)
  store.favorites = await api.GetFavorites()
  toast(now ? t('toast.favAdded') : t('toast.favRemoved'))
}

export function isFav(path: string): boolean {
  return favOf(path)
}

export async function clearHistory() {
  const api = await getApi()
  await api.ClearHistory()
  store.history = []
}

// ---------- 显示模式 ----------

/** 显示模式：仅渲染 / 仅源码 / 源码 ⇄ 渲染对照。设置随 settings 一起落盘。 */
export function setViewMode(mode: ViewMode) {
  if (store.viewMode === mode) return
  store.viewMode = mode
  patchSettings({ viewMode: mode })
}

// ---------- 设置 ----------

/** 把设置落到 DOM：主题类、正文字号变量、代码高亮主题联动。 */
export async function applySettings(st: Settings | null = store.settings) {
  const theme: string = st?.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.setProperty('--md-fs', `${st?.fontSize ?? 16}px`)
  setLang(st?.language)
  const hljsDark = document.getElementById('mdv-hljs-dark') as HTMLLinkElement | null
  const hljsLight = document.getElementById('mdv-hljs-light') as HTMLLinkElement | null
  if (hljsDark) hljsDark.disabled = theme !== 'dark'
  if (hljsLight) hljsLight.disabled = theme === 'dark'
}

export async function applyTheme(theme: string) {
  await applySettings({ ...(store.settings ?? defaultSettings), theme })
}

export async function setTheme(theme: string) {
  store.settings = { ...(store.settings ?? defaultSettings), theme }
  await applySettings(store.settings)
  const api = await getApi()
  api.SetTheme(theme)
  api.SaveSettings(store.settings)
}

export async function patchSettings(patch: Partial<Settings>) {
  const st = { ...(store.settings ?? defaultSettings), ...patch }
  store.settings = st
  await applySettings(st)
  const api = await getApi()
  if (patch.theme !== undefined) api.SetTheme(st.theme)
  api.SaveSettings(st)
}

// ---------- 窗口 ----------

export async function togglePin() {
  const st = { ...(store.settings ?? defaultSettings), pinned: !(store.settings ?? defaultSettings).pinned }
  store.settings = st
  const api = await getApi()
  api.WindowPin(st.pinned)
  api.SaveSettings(st)
}

// ---------- 导出 ----------

export async function exportHtml() {
  if (!store.current) {
    toast(t('toast.noFile'), 'error')
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
  if (out) toast(t('toast.exported', { name: fileBase(out) }))
}

export function copyPath(path: string) {
  getApi().then((api) => api.CopyText(path)).then(() => toast(t('toast.copiedPath')))
}

// ---------- 初始化 ----------

async function handleOpenEvent(path: string) {
  // 关联启动 / 二次启动转发的文件：文件夹树切到文件所在目录
  await openFile(path, { reRoot: true })
  store.tab = 'toc'
}

export async function initApp() {
  const api = await getApi()
  store.desktop = isDesktop()
  store.settings = await api.GetSettings()
  store.viewMode = normalizeViewMode(store.settings?.viewMode)
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
