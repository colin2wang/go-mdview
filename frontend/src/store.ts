import { reactive, watch } from 'vue'
import type { Entry, FileContent, MNode, Settings, TocItem, ViewMode } from './types'
import { defaultSettings } from './types'
import { getApi, isDesktop } from './api'
import { fileBase, fileToDir } from './demo'
import { renderMarkdown, resolveImgHref, sanitizeHtml, type SrcAnchor } from './markdown'
import { setLang, t } from './i18n'

export type TabKey = 'toc' | 'history' | 'fav' | 'files'

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
  timer: number
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
  /** 与 toc 同源的同步滚动锚点（标题源码行号 + DOM id），见 markdown.ts */
  srcAnchors: [] as SrcAnchor[],
  activeHeading: '',
  /** 跨文件锚点：wiki 链接带 #heading 时，渲染完成后由 Viewer 消费 */
  pendingAnchor: '',
  hasMath: false,
  hasMermaid: false,
  history: [] as Entry[],
  favorites: [] as Entry[],
  toasts: [] as Toast[],
  settingsOpen: false,
  viewMode: 'render' as ViewMode,
  demoMode: false,
  rendering: false,
  /** 当前文件已被外部删除/改名且用户选择保留：内容仍在窗口中，但已失效 */
  currentMissing: false,
  /** 外部删除确认弹窗：非空时显示「保留/关闭」询问 */
  goneFile: null as string | null,
  /** 源码编辑态与草稿提升到 store：关闭/重启/切换/重载/退出编辑共用同一份状态 */
  editing: false,
  draft: '',
  /** 未保存改动确认弹窗：非空时显示「保存/放弃/取消」询问 */
  discardReason: '' as '' | 'close' | 'restart' | 'switch' | 'reload' | 'exit',
  /** 「保存」按钮正在写盘，防止重复点击 */
  discardSaving: false,
  /** 内部导航历史：标题栏 ⟵/⟶ 按钮的回退/前进栈 */
  navBack: [] as NavLoc[],
  navForward: [] as NavLoc[]
})

/** 导航栈中的一个位置：文件 + 文内锚点。 */
export interface NavLoc {
  path: string
  anchor: string
}

/** goBack/goForward 跳转进行中：openFile 内不再向历史栈追加记录。 */
let navJumping = false
/** 当前位置的文内锚点（同文件锚点跳转时随 navPush 更新）。 */
let navCurAnchor = ''

/**
 * 记录一次用户发起的内部导航：把当前位置压入回退栈并清空前进栈。
 * prev 必须在 store.current 被替换之前捕获（openFile 早期），否则压进去的
 * 是刚打开的新文件，后退就失效了。程序化跳转（navJumping）不记。
 */
export function navPush(prev: NavLoc | null, nextAnchor: string) {
  if (navJumping) return
  if (prev) {
    const top = store.navBack[store.navBack.length - 1]
    // 连续去重：同文件同锚点不重复压栈
    if (!top || top.path !== prev.path || top.anchor !== prev.anchor) {
      store.navBack.push({ ...prev })
      if (store.navBack.length > 100) store.navBack.shift()
    }
    store.navForward = []
  }
  navCurAnchor = nextAnchor
}

/** 同文件内的文内锚点跳转：当前位置（store.current 即旧文件）压栈。 */
export function navPushAnchor(anchor: string) {
  if (navJumping) return
  const cur = store.current
  if (!cur) return
  navPush({ path: cur.path, anchor: navCurAnchor }, anchor)
}

/** 跳到 pos：锚点交给渲染完成后的 Viewer 消费；期间不记栈。 */
async function navJump(pos: NavLoc) {
  navJumping = true
  try {
    navCurAnchor = pos.anchor
    if (pos.anchor) store.pendingAnchor = pos.anchor
    await openFile(pos.path, { pushHistory: false, reason: 'switch' })
  } finally {
    navJumping = false
  }
}

/** 标题栏 ⟵：回退到上一个内部导航位置。 */
export function navBack() {
  const pos = store.navBack.pop()
  if (!pos) return
  const cur = store.current
  if (cur) store.navForward.push({ path: cur.path, anchor: navCurAnchor })
  void navJump(pos)
}

/** 标题栏 ⟶：前进到下一个内部导航位置。 */
export function navForward() {
  const pos = store.navForward.pop()
  if (!pos) return
  const cur = store.current
  if (cur) store.navBack.push({ path: cur.path, anchor: navCurAnchor })
  void navJump(pos)
}

const DISCARD_REASON_KEYS: Record<string, string> = {
  close: 'discard.close',
  restart: 'discard.restart',
  switch: 'discard.switch',
  reload: 'discard.reload',
  exit: 'discard.exit'
}

let draftTimer: number | undefined
let discardResolve: ((proceed: boolean) => void) | null = null

/** 是否有未保存的草稿改动。 */
export function hasUnsaved(): boolean {
  return store.editing && !!store.current && store.draft !== store.current.content
}

/** 同步未保存标记给 Go：标题栏 ✕ / 系统关闭都能被 BeforeClose 拦下来弹确认。 */
export function syncDraftDirty() {
  if (store.desktop) void getApi().then((api) => api.SetDraftDirty(hasUnsaved()))
}

/** 统一确认入口：无未保存改动直接放行；否则弹窗，返回 true=继续原操作（已保存或已放弃）。 */
export function confirmDiscard(reason: 'close' | 'restart' | 'switch' | 'reload' | 'exit'): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true)
  if (discardResolve) return Promise.resolve(false) // 已有确认弹窗未处理，拒绝重入
  store.discardReason = reason
  return new Promise((resolve) => {
    discardResolve = resolve
  })
}

/** 确认弹窗正文（按触发出口给不同提示，全部走 i18n）。 */
export function discardMessage(reason: string): string {
  return t(DISCARD_REASON_KEYS[reason] ?? 'discard.switch')
}

/** 确认弹窗「放弃」：丢弃草稿并继续原操作（各出口随后会 clearDraft）。 */
export function resolveDiscardDrop() {
  const resolve = discardResolve
  discardResolve = null
  store.discardReason = ''
  resolve?.(true)
}

/** 确认弹窗「取消」：保留草稿、取消原操作（confirmDiscard resolve false）。 */
export function resolveDiscardCancel() {
  const resolve = discardResolve
  discardResolve = null
  store.discardReason = ''
  resolve?.(false)
}

/** 确认弹窗「保存」：先把草稿写回原文件，再继续原操作；失败时保持弹窗供重试/改选。 */
export async function resolveDiscardSave() {
  if (!discardResolve || store.discardSaving) return
  store.discardSaving = true
  try {
    if (!(await saveSource(store.draft))) return
    const resolve = discardResolve
    if (!resolve) return
    discardResolve = null
    store.discardReason = ''
    resolve(true)
  } finally {
    store.discardSaving = false
  }
}

/** 取消草稿重渲染定时器：换文件/退出编辑后不能让旧草稿覆盖正文。 */
export function cancelDraftRender() {
  if (draftTimer !== undefined) {
    window.clearTimeout(draftTimer)
    draftTimer = undefined
  }
}

/** 编辑器输入：300ms 防抖后重渲染预览（draftSeq 负责丢弃过期结果）。 */
export function setDraftText(v: string, debounce = true) {
  store.draft = v
  syncDraftDirty()
  if (draftTimer !== undefined) window.clearTimeout(draftTimer)
  if (!debounce) {
    draftTimer = undefined
    void renderDraft(v)
    return
  }
  draftTimer = window.setTimeout(() => {
    draftTimer = undefined
    void renderDraft(v)
  }, 300)
}

/** 清空编辑态（保存成功 / 放弃修改 / 切换文件后调用）。 */
export function clearDraft() {
  cancelDraftRender()
  store.editing = false
  store.draft = ''
  syncDraftDirty()
}

/** 非法/缺失的 viewMode 回落到 render。 */
function normalizeViewMode(v: unknown): ViewMode {
  return v === 'source' || v === 'split' || v === 'mindmap' ? v : 'render'
}

let toastSeq = 0
export function toast(text: string, kind: 'info' | 'error' = 'info', opts: { dedupe?: boolean; duration?: number } = {}) {
  const duration = opts.duration ?? 2600
  // 去重：相同文案+类型的存活气泡复用，只续期计时（连续自动刷新时同一消息不反复弹）
  if (opts.dedupe) {
    const exist = store.toasts.find((x) => x.text === text && x.kind === kind)
    if (exist) {
      clearTimeout(exist.timer)
      exist.timer = window.setTimeout(() => removeToast(exist.id), duration)
      return
    }
  }
  const id = ++toastSeq
  const item: Toast = { id, text, kind, timer: 0 }
  store.toasts.push(item)
  item.timer = window.setTimeout(() => removeToast(id), duration)
}

function removeToast(id: number) {
  const i = store.toasts.findIndex((t) => t.id === id)
  if (i >= 0) store.toasts.splice(i, 1)
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
    const r = await renderMarkdown(
      fc.content,
      fc.dir,
      store.settings?.blockRemote ?? true,
      store.settings?.remoteAllow ?? ''
    )
    store.html = r.html
    store.toc = r.toc
    store.srcAnchors = r.anchors
    store.hasMath = r.hasMath
    store.hasMermaid = r.hasMermaid
  } catch (e) {
    // 异常文本可能含不可信内容（路径、markdown 片段），统一走净化出口。
    store.html = sanitizeHtml(
      `<div class="render-error"><h3>${t('error.renderFailed')}</h3><pre>${String(e)}</pre></div>`,
      store.settings?.blockRemote ?? true,
      store.settings?.remoteAllow ?? ''
    )
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
    const r = await renderMarkdown(
      md,
      fc.dir,
      store.settings?.blockRemote ?? true,
      store.settings?.remoteAllow ?? ''
    )
    if (seq !== draftSeq) return // 已有更新的草稿，丢弃过期结果
    store.html = r.html
    store.toc = r.toc
    store.srcAnchors = r.anchors
    store.hasMath = r.hasMath
    store.hasMermaid = r.hasMermaid
  } catch {
    /* 输入中途解析失败：保留上一次渲染结果 */
  } finally {
    if (seq === draftSeq) store.rendering = false
  }
}

// 语言切换只让 Vue 模板自动更新；图表卡片标题/按钮等文案是在 renderMarkdown
// 时拼进 store.html 的，必须重渲染当前正文（编辑中重渲染草稿）才会跟着换语言。
watch(
  () => store.settings?.language,
  (lang, prev) => {
    if (!lang || !prev || lang === prev) return
    const cur = store.current
    if (!cur || cur.kind !== 'markdown') return
    if (store.editing) void renderDraft(store.draft)
    else void renderCurrent(cur)
  }
)

/** 保存编辑后的正文回原文件（源码/对照模式的「保存」按钮）。 */
export async function saveSource(md: string): Promise<boolean> {
  const cur = store.current
  if (!cur) return false
  try {
    const api = await getApi()
    const fc = await api.SaveMarkdown(cur.path, md, cur.encoding)
    store.current = fc
    store.currentMissing = false // 已删除文件被保存重建，恢复有效
    toast(t('toast.saved'))
    return true
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
    return false
  }
}

// ---------- 外部文件修改监视 ----------

/** 后端 file:watch 事件负载（Go: mdv.FileEvent）。 */
interface WatchEvent {
  kind: 'changed' | 'gone'
  path: string
  modTime: number
  size: number
}

let reloading = false

async function handleWatchEvent(ev: WatchEvent) {
  const cur = store.current
  if (!cur || cur.path !== ev.path) return
  if (ev.kind === 'gone') {
    // 文件被外部删除/改名：不独占文件（外部始终可删），弹窗问是否在窗口中保留内容
    store.goneFile = ev.path
    return
  }
  if (cur.modTime && ev.modTime && ev.modTime === cur.modTime) return
  if (reloading) return
  if (store.settings && !store.settings.autoReload) {
    toast(t('toast.fileChanged'), 'info')
    return
  }
  reloading = true
  try {
    // 静默重载：不推历史、不改树根；保存/滚动位置由既有流程处理
    await openFile(ev.path, { pushHistory: false, reason: 'reload' })
    // 3 秒气泡 + 去重：文件被反复修改/更新时同一消息只保留一条
    toast(t('toast.fileReloaded'), 'info', { dedupe: true, duration: 3000 })
  } catch {
    /* openFile 内部已 toast */
  } finally {
    reloading = false
  }
}

/** 删除确认弹窗：选择「保留」——内容留在窗口并标记失效；「关闭」——清空视图。 */
export async function resolveGoneFile(keep: boolean) {
  const p = store.goneFile
  store.goneFile = null
  if (!p) return
  const api = await getApi()
  if (!keep && !(await confirmDiscard('switch'))) return
  await api.StopWatch()
  if (keep && store.current?.path === p) {
    store.currentMissing = true
    toast(t('toast.keptMissing'), 'error')
  } else if (!keep) {
    store.current = null
    store.currentKind = 'markdown'
    store.html = ''
    store.toc = []
    store.srcAnchors = []
    store.demoMode = false
    store.currentMissing = false
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

export async function openFile(
  path: string,
  opts: { pushHistory?: boolean; reRoot?: boolean; reason?: 'switch' | 'reload' } = {}
): Promise<boolean> {
  // 五个丢弃出口之一：切换文件（外部重载传 reason='reload'）。
  if (!(await confirmDiscard(opts.reason ?? 'switch'))) return false
  // 导航历史：此刻 store.current 还是旧文件，先记下位置，成功后再入栈
  const prevLoc: NavLoc | null = store.current ? { path: store.current.path, anchor: navCurAnchor } : null
  const api = await getApi()
  const kind = fileKind(path)
  try {
    // 所有文件类型统一登记图片目录并等待完成，否则单独打开图片 /
    // 启动恢复（pushHistory:false）时 /mdimg 会因白名单未登记而 403。
    await api.AllowImageDir(fileToDir(path))
    clearDraft()
    if (kind === 'image') {
      // 图片：不走文本读取，直接用 /mdimg 回放路由
      store.current = {
        path, name: fileBase(path), dir: fileToDir(path),
        content: '', encoding: '', size: 0, modTime: 0, kind: 'image'
      }
      store.currentKind = 'image'
      store.demoMode = false
      store.currentMissing = false
      store.html = ''
      store.toc = []
      store.srcAnchors = []
      store.hasMath = false
      store.hasMermaid = false
      store.imgUrl = resolveImgHref(path, '')
    } else {
      const fc = await api.ReadMarkdown(path)
      fc.kind = kind === 'markdown' ? 'markdown' : 'text'
      store.current = fc
      store.currentKind = fc.kind
      store.demoMode = false
      store.currentMissing = false
      if (fc.kind === 'markdown') {
        await renderCurrent(fc)
      } else {
        // 纯文本：不渲染 Markdown，直接整段展示
        store.html = ''
        store.toc = []
        store.srcAnchors = []
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
    // 内部导航历史：外部静默重载不算用户导航，不记栈
    if (opts.reason !== 'reload') navPush(prevLoc, store.pendingAnchor)
    // lastFolder 只在真正切换文件夹树根时更新，避免面板标题与实际树内容不符
    const st = { ...(store.settings ?? defaultSettings), lastFile: path }
    if (opts.reRoot && store.rootName === dir) st.lastFolder = dir
    store.settings = st
    api.SaveSettings(st)
    api.SetWindowTitle(`${path} - mdview`)
    return true
  } catch (e) {
    if (String(e).includes('file too large')) toast(t('error.tooLarge'), 'error')
    else toast(t('toast.openFailed', { e: fileBase(path) }), 'error')
    return false
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
    store.tree = await api.RefreshTree(dir)
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
  // 目录树里的图片也要能回放（与单文件打开走同一登记入口）
  await api.AllowImageDir(dir)
  const st = { ...(store.settings ?? defaultSettings), lastFolder: dir }
  store.settings = st
  api.SaveSettings(st)
  const mdCount = countMd(tree)
  toast(mdCount ? t('toast.loadedFolder', { n: mdCount }) : t('toast.noNotes'))
}

/** 只统计可预览的 Markdown 笔记，图片/文本文件不计入「笔记数」。 */
export function countMd(nodes: MNode[]): number {
  let n = 0
  for (const x of nodes) {
    if (x.isDir) n += countMd(x.children ?? [])
    else if (x.supported !== false && fileKind(x.path) === 'markdown') n++
  }
  return n
}

export async function openWikiLink(title: string, anchor = '') {
  if (!store.current) return
  const api = await getApi()
  // 支持 [[folder/note]] 与 [[note#heading]]：取 basename 建索引，锚点交给渲染完成后跳转
  const base = title.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? title
  store.pendingAnchor = anchor.replace(/^#/, '')
  const hits = await api.FindByTitles(fileToDir(store.current.path), base)
  if (hits.length > 1) {
    // 同名笔记不静默取第一个：弹列表让用户选
    const { showMenu } = await import('./components/ContextMenu.vue')
    showMenu(
      Math.round(window.innerWidth / 2),
      Math.round(window.innerHeight / 2),
      hits.map((p) => ({ label: p, action: () => void openFile(p) }))
    )
  } else if (hits.length === 1) {
    await openFile(hits[0])
  } else {
    store.pendingAnchor = ''
    toast(t('toast.noteNotFound', { title: base }))
  }
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

export async function removeHistory(path: string) {
  const api = await getApi()
  await api.RemoveHistory(path)
  store.history = await api.GetHistory()
}

export async function clearHistory() {
  const api = await getApi()
  await api.ClearHistory()
  store.history = []
}

// ---------- 显示模式 ----------

/** 显示模式：仅渲染 / 仅源码 / 源码 ⇄ 渲染对照。设置随 settings 一起落盘。 */
export async function setViewMode(mode: ViewMode) {
  if (store.viewMode === mode) return
  store.viewMode = mode
  await patchSettings({ viewMode: mode })
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
  await patchSettings({ theme })
  await applySettings(store.settings)
}

/** 设置写盘：120ms 合并 + 串行落盘，以 Go 返回的规范化结果为准。 */
let settingsChain: Promise<void> = Promise.resolve()
let settingsTimer: number | undefined
let pendingSettings: Settings | null = null
let pendingTheme: string | undefined
let settingsWaiters: Array<() => void> = []

function flushSettings() {
  settingsTimer = undefined
  const st = pendingSettings
  const theme = pendingTheme
  const waiters = settingsWaiters
  pendingSettings = null
  pendingTheme = undefined
  settingsWaiters = []
  if (!st) return
  settingsChain = settingsChain
    .then(async () => {
      const api = await getApi()
      if (theme !== undefined) await api.SetTheme(theme)
      const saved = await api.SaveSettings(st)
      if (saved) store.settings = saved
      const err = await api.GetLastError()
      if (err) toast(t('toast.settingsWriteFailed', { e: err }), 'error')
    })
    .catch(() => undefined)
    .finally(() => waiters.forEach((resolve) => resolve()))
}

export async function patchSettings(patch: Partial<Settings>) {
  const st = { ...(store.settings ?? defaultSettings), ...patch }
  store.settings = st
  await applySettings(st)
  pendingSettings = st
  if (patch.theme !== undefined) pendingTheme = st.theme
  await new Promise<void>((resolve) => {
    settingsWaiters.push(resolve)
    if (settingsTimer !== undefined) window.clearTimeout(settingsTimer)
    settingsTimer = window.setTimeout(flushSettings, 120)
  })
}

// ---------- 窗口 ----------

export async function togglePin() {
  const pinned = !(store.settings ?? defaultSettings).pinned
  const api = await getApi()
  api.WindowPin(pinned)
  await patchSettings({ pinned })
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
  // 导出是脱离应用的独立 HTML：强制开启远程拦截并二次净化，
  // 后端再把 /mdimg/{hex}/{name} 内嵌为 base64（见 mdv.ExportHtml）。
  const safe = sanitizeHtml(inner, true, '')
  const base = fileBase(store.current.path).replace(/\.md$/i, '')
  const out = await api.SaveHtmlDialog(
    base + (hasUnsaved() ? ` (${t('export.draft')})` : ''),
    safe,
    base + '.html'
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
    // v3 运行时：事件回调参数是 WailsEvent 对象，载荷在 ev.data
    const { Events } = await import('@wailsio/runtime')
    Events.On('mdv:openfile', (ev) => handleOpenEvent(ev.data as string))
    // 外部修改/删除监视：后端 mdv watcher 经 Event.Emit 推送
    Events.On('file:watch', (ev) => handleWatchEvent(ev.data as WatchEvent))
    // 系统级关闭（标题栏 ✕ / Alt+F4）被 Go 关闭拦截后，在这里统一弹确认
    Events.On('draft:close-request', async () => {
      if (await confirmDiscard('close')) {
        await api.SetDraftDirty(false)
        api.WindowClose()
      }
    })
    // 原生拖放：Go 侧 EnableFileDrop + WindowFilesDropped 事件转发绝对路径
    Events.On('mdv:files-dropped', (ev) => {
      const paths = (ev.data as string[]) ?? []
      // 放开全部可预览类型（markdown / 图片 / 文本），交给 fileKind 分发
      const files = paths.filter((p) => fileKind(p) !== 'text' || /\.(txt|text|log|json|yaml|yml|ini|csv)$/i.test(p))
      if (!files.length) return
      if (files.length === 1) {
        void handleOpenEvent(files[0])
        return
      }
      void import('./components/ContextMenu.vue').then(({ showMenu }) => {
        showMenu(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2), [
          { label: t('drop.openFirst'), action: () => void handleOpenEvent(files[0]) },
          {
            label: t('drop.addAll'),
            action: () => {
              void handleOpenEvent(files[0])
              files.slice(1).forEach((p) => void api.PushHistory(p))
            }
          }
        ])
      })
    })
  } else {
    window.addEventListener('mdv:mock-openfile', (e) => {
      handleOpenEvent((e as CustomEvent).detail as string)
    })
  }

  store.ready = true
}
