import { reactive, watch } from 'vue'
import type { Entry, FileContent, MNode, Settings, TocItem, ViewMode } from './types'
import { CODE_MAX_CSS_VARS, defaultSettings } from './types'
import { getApi, isDesktop } from './api'
import { fileBase, fileToDir } from './demo'
import { renderMarkdown, resolveImgHref, sanitizeHtml, type SrcAnchor } from './markdown'
import { setHljsTheme } from './vendor'
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
  /** Sync-scroll anchors sharing the source of toc (heading source line numbers + DOM id), see markdown.ts */
  srcAnchors: [] as SrcAnchor[],
  activeHeading: '',
  /** Cross-file anchor: consumed by Viewer after rendering when a wiki link carries #heading */
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
  /** The current file was deleted/renamed externally and the user chose to keep it: content is still in the window but stale */
  currentMissing: false,
  /** External-deletion confirm dialog: when set, shows a keep/close prompt */
  goneFile: null as string | null,
  /** Source edit state and draft hoisted into store: close/restart/switch/reload/exit share the same state */
  editing: false,
  draft: '',
  /** Unsaved-changes confirm dialog: when set, shows a save/drop/cancel prompt */
  discardReason: '' as '' | 'close' | 'restart' | 'switch' | 'reload' | 'exit',
  /** The "save" button is writing to disk, guarding double clicks */
  discardSaving: false,
  /** Internal navigation history: back/forward stacks for the title bar ⟵/⟶ buttons */
  navBack: [] as NavLoc[],
  navForward: [] as NavLoc[]
})

/** One position in the navigation stacks: file plus in-document anchor. */
export interface NavLoc {
  path: string
  anchor: string
}

/** Set while a goBack/goForward jump is in flight: openFile does not push further history entries. */
let navJumping = false
/** In-document anchor of the current position (updated on navPush for same-file anchor jumps). */
let navCurAnchor = ''

/**
 * Records a user-initiated internal navigation: pushes the current position
 * onto the back stack and clears the forward stack. prev must be captured
 * before store.current is replaced (early in openFile), otherwise the newly
 * opened file gets pushed and back breaks. Programmatic jumps (navJumping)
 * are not recorded.
 */
export function navPush(prev: NavLoc | null, nextAnchor: string) {
  if (navJumping) return
  if (prev) {
    const top = store.navBack[store.navBack.length - 1]
    // Consecutive de-duplication: same file and anchor is not pushed again
    if (!top || top.path !== prev.path || top.anchor !== prev.anchor) {
      store.navBack.push({ ...prev })
      if (store.navBack.length > 100) store.navBack.shift()
    }
    store.navForward = []
  }
  navCurAnchor = nextAnchor
}

/** In-document anchor jump within the same file: the current position (store.current, i.e. the old file) is pushed. */
export function navPushAnchor(anchor: string) {
  if (navJumping) return
  const cur = store.current
  if (!cur) return
  navPush({ path: cur.path, anchor: navCurAnchor }, anchor)
}

/** Jumps to pos: the anchor is consumed by Viewer after rendering; no history entry is recorded meanwhile. */
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

/** Title bar ⟵: back to the previous internal navigation position. */
export function navBack() {
  const pos = store.navBack.pop()
  if (!pos) return
  const cur = store.current
  if (cur) store.navForward.push({ path: cur.path, anchor: navCurAnchor })
  void navJump(pos)
}

/** Title bar ⟶: forward to the next internal navigation position. */
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

/** Whether there are unsaved draft changes. */
export function hasUnsaved(): boolean {
  return store.editing && !!store.current && store.draft !== store.current.content
}

/** Syncs the unsaved flag to Go: both title-bar ✕ and system close can be intercepted for a confirm dialog. */
export function syncDraftDirty() {
  if (store.desktop) void getApi().then((api) => api.SetDraftDirty(hasUnsaved()))
}

/** Unified confirm entry: passes straight through without unsaved changes; otherwise shows the dialog, resolving true = continue (saved or dropped). */
export function confirmDiscard(reason: 'close' | 'restart' | 'switch' | 'reload' | 'exit'): Promise<boolean> {
  if (!hasUnsaved()) return Promise.resolve(true)
  if (discardResolve) return Promise.resolve(false) // an unresolved dialog is open, re-entry rejected
  store.discardReason = reason
  return new Promise((resolve) => {
    discardResolve = resolve
  })
}

/** Confirm dialog body (different hint per trigger, all via i18n). */
export function discardMessage(reason: string): string {
  return t(DISCARD_REASON_KEYS[reason] ?? 'discard.switch')
}

/** Confirm dialog "drop": discards the draft and continues (each caller clears the draft afterwards). */
export function resolveDiscardDrop() {
  const resolve = discardResolve
  discardResolve = null
  store.discardReason = ''
  resolve?.(true)
}

/** Confirm dialog "cancel": keeps the draft and aborts (confirmDiscard resolves false). */
export function resolveDiscardCancel() {
  const resolve = discardResolve
  discardResolve = null
  store.discardReason = ''
  resolve?.(false)
}

/** Confirm dialog "save": writes the draft back to the file first, then continues; keeps the dialog open on failure for retry. */
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

/** Cancels the draft re-render timer: after a file switch or leaving editing, a stale draft must not overwrite the body. */
export function cancelDraftRender() {
  if (draftTimer !== undefined) {
    window.clearTimeout(draftTimer)
    draftTimer = undefined
  }
}

/** Editor input: re-renders the preview after a 300ms debounce (draftSeq discards stale results). */
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

/** Clears the edit state (after a successful save / dropping changes / switching files). */
export function clearDraft() {
  cancelDraftRender()
  store.editing = false
  store.draft = ''
  syncDraftDirty()
}

/** Falls back to render for an invalid/missing viewMode. */
function normalizeViewMode(v: unknown): ViewMode {
  return v === 'source' || v === 'split' || v === 'mindmap' ? v : 'render'
}

let toastSeq = 0
export function toast(text: string, kind: 'info' | 'error' = 'info', opts: { dedupe?: boolean; duration?: number } = {}) {
  const duration = opts.duration ?? 2600
  // De-duplication: a live toast with the same text and kind is reused, only the timer renewed (repeated auto-reloads do not re-pop the same message)
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

// ---------- Render ----------

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
    // Error text may carry untrusted content (paths, markdown fragments); the sanitized outlet applies throughout.
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
 * Split-mode source editing: re-renders the body from the editing draft.
 * Only the in-memory render result changes, no file write, no history; the
 * previous result is kept when parsing fails.
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
    if (seq !== draftSeq) return // a newer draft exists, stale result discarded
    store.html = r.html
    store.toc = r.toc
    store.srcAnchors = r.anchors
    store.hasMath = r.hasMath
    store.hasMermaid = r.hasMermaid
  } catch {
    /* parse failed mid-typing: keep the previous render */
  } finally {
    if (seq === draftSeq) store.rendering = false
  }
}

// Language switching only auto-updates Vue templates; copy such as diagram card
// titles/buttons is baked into store.html at renderMarkdown time, so the current
// body must be re-rendered (the draft while editing) to follow the language.
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

// After the remote-blocking switch or whitelist changes, existing <img src>
// in the body do not follow automatically; the current document must be
// re-rendered (the draft while editing) so the old placeholder does not linger.
watch(
  () => [store.settings?.blockRemote, store.settings?.remoteAllow] as const,
  ([block, allow], [prevBlock, prevAllow]) => {
    if (block === prevBlock && allow === prevAllow) return
    const cur = store.current
    if (!cur || cur.kind !== 'markdown') return
    if (store.editing) void renderDraft(store.draft)
    else void renderCurrent(cur)
  }
)

/** Saves the edited body back to the original file (the "save" button in source/split mode). */
export async function saveSource(md: string): Promise<boolean> {
  const cur = store.current
  if (!cur) return false
  try {
    const api = await getApi()
    const fc = await api.SaveMarkdown(cur.path, md, cur.encoding)
    store.current = fc
    store.currentMissing = false // a deleted file rebuilt by saving is valid again
    toast(t('toast.saved'))
    return true
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
    return false
  }
}

// ---------- External file change watching ----------

/** Backend file:watch event payload (Go: mdv.FileEvent). */
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
    // File deleted/renamed externally: the file is not locked (external deletion always possible), so a dialog asks whether to keep the content in the window
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
    // Silent reload: no history push, no tree re-rooting; save/scroll state is handled by the existing flows
    await openFile(ev.path, { pushHistory: false, reason: 'reload' })
    // 3-second toast + de-duplication: one message only when the file changes repeatedly
    toast(t('toast.fileReloaded'), 'info', { dedupe: true, duration: 3000 })
  } catch {
    /* toast already shown inside openFile */
  } finally {
    reloading = false
  }
}

/** Deletion confirm dialog: "keep" leaves the content in the window and marks it stale; "close" clears the view. */
export async function resolveGoneFile(keep: boolean) {
  const p = store.goneFile
  store.goneFile = null
  if (!p) return
  if (!keep && !(await confirmDiscard('switch'))) return
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

// ---------- Open ----------

const MD_KIND_EXTS = ['md', 'markdown', 'mdown', 'mkd']
const IMG_KIND_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']

/** File kind by extension, deciding how the viewer renders it. */
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
  // One of the five discard exits: file switch (external reload passes reason='reload').
  if (!(await confirmDiscard(opts.reason ?? 'switch'))) return false
  // Navigation history: store.current is still the old file here, capture the position first and push after success
  const prevLoc: NavLoc | null = store.current ? { path: store.current.path, anchor: navCurAnchor } : null
  const api = await getApi()
  const kind = fileKind(path)
  try {
    // Register the image directory for all file kinds and wait for it, otherwise /mdimg
    // 403s for a lone image open or startup restore (pushHistory:false) because the whitelist is unregistered.
    await api.AllowImageDir(fileToDir(path))
    clearDraft()
    if (kind === 'image') {
      // Image: no text read, the /mdimg replay route is used directly
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
        // Plain text: no Markdown rendering, shown as one whole block
        store.html = ''
        store.toc = []
        store.srcAnchors = []
        store.hasMath = false
        store.hasMermaid = false
      }
    }
    // The folder tree stays on the remembered directory by default; only association-open/drag entries pass reRoot to switch to the file's directory
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
    // Internal navigation history: external silent reloads are not user navigation, no entry recorded
    if (opts.reason !== 'reload') navPush(prevLoc, store.pendingAnchor)
    // lastFolder updates only when the tree root actually switches, keeping the panel title consistent with the tree content
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
  // Images inside the tree must also replay (same registration entry as single-file open)
  await api.AllowImageDir(dir)
  const st = { ...(store.settings ?? defaultSettings), lastFolder: dir }
  store.settings = st
  api.SaveSettings(st)
  const mdCount = countMd(tree)
  toast(mdCount ? t('toast.loadedFolder', { n: mdCount }) : t('toast.noNotes'))
}

/** Counts only previewable Markdown notes; images/text files do not count as notes. */
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
  // Supports [[folder/note]] and [[note#heading]]: indexes by basename, the anchor is handed to post-render consumption
  const base = title.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? title
  store.pendingAnchor = anchor.replace(/^#/, '')
  const hits = await api.FindByTitles(fileToDir(store.current.path), base)
  if (hits.length > 1) {
    // Same-named notes never silently pick the first: a list is shown for the user to choose
    const { showMenu } = await import('./context-menu')
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

// ---------- Favorites/history ----------

/** Unified entry for panel/context-menu: reports when the file does not exist. reRoot is forwarded to openFile (tree root switch). */
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

// ---------- Display mode ----------

/** Display mode: render only / source only / side-by-side. Persisted with settings. */
export async function setViewMode(mode: ViewMode) {
  if (store.viewMode === mode) return
  store.viewMode = mode
  await patchSettings({ viewMode: mode })
}

// ---------- Settings ----------

/** Applies settings to the DOM: theme class, body font-size variable, code highlighting theme linkage. */
export async function applySettings(st: Settings | null = store.settings) {
  const theme: string = st?.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.style.setProperty('--md-fs', `${st?.fontSize ?? 16}px`)
  // Line numbers of rendered code blocks/diagram source: per-line wrapping is generated at render time, so only the root class toggles here,
  // no full re-render, avoiding sync anchor rebuilds.
  document.documentElement.classList.toggle('__code_lineno', st?.codeBlockLineNo ?? true)
  // Code block max lines: 0 = unlimited (max-height: none). Three variables cover
  // .code-block pre (line box = 0.875em × 1.6 line height, 28px padding),
  // the diagram card "source" view .md-diagram-code (12.5px × 1.6 + 28px) and
  // .md-diagram-src-code in the diagram error hint (12px × 1.5 + 20px).
  const codeLines = st?.codeMaxLines ?? 20
  const codeMax = (lineBox: string, padding: number) =>
    codeLines > 0 ? `calc(${codeLines} * ${lineBox} + ${padding}px)` : 'none'
  const [codeVar, diaVar, diagramVar] = CODE_MAX_CSS_VARS
  document.documentElement.style.setProperty(codeVar, codeMax('1.4em', 28))
  document.documentElement.style.setProperty(diaVar, codeMax('18px', 20))
  document.documentElement.style.setProperty(diagramVar, codeMax('20px', 28))
  setLang(st?.language)
  setHljsTheme(theme)
}

export async function applyTheme(theme: string) {
  await applySettings({ ...(store.settings ?? defaultSettings), theme })
}

export async function setTheme(theme: string) {
  await patchSettings({ theme })
  await applySettings(store.settings)
}

/** Persists settings with 120ms coalescing and serial writes; the normalized result returned by Go is authoritative. */
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
      if (saved) {
        store.settings = saved
        // Re-apply DOM state (theme/font size/code max lines etc.) from Go's normalized values
        await applySettings(saved)
      }
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

// ---------- Window ----------

export async function togglePin() {
  const pinned = !(store.settings ?? defaultSettings).pinned
  const api = await getApi()
  api.WindowPin(pinned)
  await patchSettings({ pinned })
}

// ---------- Export ----------

export async function exportHtml() {
  if (!store.current) {
    toast(t('toast.noFile'), 'error')
    return
  }
  const api = await getApi()
  const art = document.querySelector('.md-article')
  const inner = art ? art.innerHTML : store.html
  // The export is a standalone HTML detached from the app: remote blocking is forced on and content is re-sanitized;
  // the backend then embeds /mdimg/{hex}/{name} as base64 (see mdv.ExportHtml).
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

// ---------- Initialization ----------

async function handleOpenEvent(path: string) {
  // File from association launch / second-instance forwarding: the tree re-roots to the file's directory
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
    // Empty state: no built-in demo rendered, waiting for the user to open a file/folder
    store.demoMode = false
    store.html = ''
  }

  if (isDesktop()) {
    // v3 runtime: event callback arguments are WailsEvent objects, payload in ev.data
    const { Events } = await import('@wailsio/runtime')
    Events.On('mdv:openfile', (ev) => handleOpenEvent(ev.data as string))
    // External modification/deletion watching: pushed by the backend mdv watcher via Event.Emit
    Events.On('file:watch', (ev) => handleWatchEvent(ev.data as WatchEvent))
    // System-level close (title-bar ✕ / Alt+F4) intercepted by Go surfaces the confirm dialog here
    Events.On('draft:close-request', async () => {
      if (await confirmDiscard('close')) {
        await api.SetDraftDirty(false)
        api.WindowClose()
      }
    })
    // Native drag & drop: Go-side EnableFileDrop + WindowFilesDropped forward absolute paths
    Events.On('mdv:files-dropped', (ev) => {
      const paths = (ev.data as string[]) ?? []
      // All previewable kinds allowed (markdown / image / text), dispatched by fileKind
      const files = paths.filter((p) => fileKind(p) !== 'text' || /\.(txt|text|log|json|yaml|yml|ini|csv)$/i.test(p))
      if (!files.length) return
      if (files.length === 1) {
        void handleOpenEvent(files[0])
        return
      }
      void import('./context-menu').then(({ showMenu }) => {
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
