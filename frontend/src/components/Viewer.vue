<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  store,
  setTheme,
  setViewMode,
  renderDraft,
  saveSource,
  exportHtml,
  openEntry,
  openFolder,
  openWikiLink,
  toast
} from '../store'
import { showMenu, hideMenu } from './ContextMenu.vue'
import CodeEditor from './CodeEditor.vue'
import { getApi } from '../api'
import { renderDiagramsIn, renderMathIn } from '../markdown'
import { countPreviewText, countStats } from '../stats'
import { srcEditor } from '../editor-bridge'
import { status } from '../status'
import { t } from '../i18n'
import type { ViewMode } from '../types'
import AppIcon from './AppIcon.vue'
import ImageLightbox from './ImageLightbox.vue'
import MindMap from './MindMap.vue'

const articleEl = ref<HTMLElement | null>(null)
const renderScrollEl = ref<HTMLElement | null>(null)
const splitWrapEl = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof CodeEditor> | null>(null)

const mode = computed<ViewMode>(() => store.viewMode)
const isSplit = computed(() => mode.value === 'split')
// 思维导图是渲染面板的独占视图（不叠加源码），故 showSource 不含 mindmap；
// 仅在 markdown 文件上展示，打开图片/纯文本时回退到常规预览
const showSource = computed(() => mode.value === 'source' || mode.value === 'split')
const showRender = computed(() => mode.value !== 'source')
const isMindmap = computed(
  () => mode.value === 'mindmap' && store.currentKind === 'markdown'
)

// ---------- 源码面板 ----------
// 源码区由 CodeMirror 渲染：语法高亮 + 行号 + 光标都在同一套排版里，
// 只读态只是 readOnly: 'nocursor'（仍可选中复制），不再有「透明层叠高亮层」的错位问题

const sourceText = computed(() => store.current?.content ?? '')
const sourcePath = computed(() => store.current?.path ?? '')
const sourceMeta = computed(() => {
  const c = store.current
  if (!c) return ''
  const lines = c.content ? c.content.split('\n').length : 0
  return `${t('src.metaLines', { n: lines })} · ${c.encoding} · ${(c.size / 1024).toFixed(1)} KB`
})
// Markdown 走 gfm 模式（含围栏代码高亮），其余纯文本
const srcMode = computed(() => (store.currentKind === 'markdown' ? 'gfm' : 'text/plain'))

// 源码编辑草稿：只改内存里的渲染结果，不写回文件；关闭编辑或切换文件即还原
const editing = ref(false)
const draft = ref('')
// 编辑器实际内容：编辑中是草稿，否则是文件内容
const shownText = computed(() => (editing.value ? draft.value : sourceText.value))

async function copySource() {
  const api = await getApi()
  // 编辑中复制当前草稿，否则复制文件内容
  await api.CopyText(shownText.value)
  toast(t('toast.copiedSource'))
}

// ---------- 对照分栏 ----------
const splitRatio = ref(0.5)
const dragging = ref(false)

function onSplitDown(e: MouseEvent) {
  dragging.value = true
  document.addEventListener('mousemove', onSplitMove)
  document.addEventListener('mouseup', onSplitUp)
  e.preventDefault()
}
function onSplitMove(e: MouseEvent) {
  const box = splitWrapEl.value?.getBoundingClientRect()
  if (!box || box.width <= 0) return
  splitRatio.value = Math.min(0.8, Math.max(0.2, (e.clientX - box.left) / box.width))
}
function onSplitUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onSplitMove)
  document.removeEventListener('mouseup', onSplitUp)
}
function evenSplit() {
  splitRatio.value = 0.5
}

const syncScroll = ref(true)
let syncing = false

// ---------- 源码编辑（对照模式） ----------
// 行号槽开关：统一由设置对话框控制，编辑/只读两种状态共用
const showLineNo = computed(() => store.settings?.lineNo ?? true)
let draftTimer: number | undefined

/** 取消待执行的草稿重渲染：退出编辑/换文件后不能再拿旧草稿覆盖正文。 */
function cancelDraftTimer() {
  if (draftTimer) {
    window.clearTimeout(draftTimer)
    draftTimer = undefined
  }
}

/** 编辑器里的文本变化（只读态 CodeMirror 不会触发） */
function onEditorInput(v: string) {
  draft.value = v
}

async function toggleEdit() {
  // 只读与编辑共用同一个 CodeMirror 实例，只切换 readOnly；
  // 行高/排版完全不变，滚动位置不用换算
  cancelDraftTimer()
  const from = sourceScroller()
  const prevTop = from?.scrollTop ?? 0

  editing.value = !editing.value
  if (editing.value) {
    draft.value = sourceText.value
  } else {
    draft.value = ''
    void renderDraft(sourceText.value) // 还原为文件内容
  }

  await nextTick()
  const now = sourceScroller()
  if (now && now.scrollTop !== prevTop) {
    now.scrollTop = Math.min(prevTop, Math.max(0, now.scrollHeight - now.clientHeight))
  }
  if (isSplit.value && syncScroll.value) mirror(now, renderScrollEl.value)
}

function onDraftInput() {
  if (draftTimer) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => void renderDraft(draft.value), 300)
}

// 切换文件：有未保存改动时先提示，再还原编辑态
watch(
  () => store.current?.path,
  async () => {
    cancelDraftTimer()
    if (editing.value && draft.value && draft.value !== sourceText.value) {
      toast(t('toast.discardedDraft'), 'error')
    }
    draft.value = editing.value ? sourceText.value : ''
    if (editing.value) void renderDraft(draft.value)
  }
)

/** 编辑器挂载/重新可见后需要重算尺寸（v-show 隐藏期间容器无尺寸） */
function refreshEditor() {
  editorRef.value?.refresh()
}

// 源码统计（编辑中按草稿算）与光标位置写进状态栏数据
watch(
  () => shownText.value,
  (v) => {
    const s = countStats(v)
    status.chars = s.chars
    status.lines = s.lines
  },
  { immediate: true }
)

function onCaret(pos: { line: number; col: number }) {
  status.caretLine = pos.line
  status.caretCol = pos.col
  followCaret(pos.line)
}

watch(
  [editing, () => store.current?.path, () => store.current?.encoding],
  () => {
    status.hasFile = !!store.current
    status.editing = editing.value
    const c = store.current
    status.summary = c ? `${c.encoding} · ${(c.size / 1024).toFixed(1)} KB` : ''
  },
  { immediate: true }
)

/**
 * 当前源码侧的滚动元素：CodeMirror 的滚动容器（scroller），
 * 可以直接当普通 scroll 容器用（CM 内部也是直接写它的 scrollTop）。
 */
function sourceScroller(): HTMLElement | null {
  return editorRef.value?.scroller() ?? null
}

/** 按可滚动高度的比例镜像滚动位置，返回是否真的写入。 */
let mirrorAt = 0
function mirror(from: HTMLElement | null, to: HTMLElement | null): boolean {
  if (!from || !to || syncing) return false
  const fMax = from.scrollHeight - from.clientHeight
  const tMax = to.scrollHeight - to.clientHeight
  if (fMax <= 0 || tMax <= 0) return false
  syncing = true
  to.scrollTop = (from.scrollTop / fMax) * tMax
  // 镜像写入的位置同样要记账，否则重渲染时会按过期位置还原，正文被拽回顶部
  if (to === renderScrollEl.value) rememberRender(to)
  mirrorAt = performance.now()
  requestAnimationFrame(() => (syncing = false))
  return true
}

// 镜像写入触发的对方 scroll 事件可能晚于 rAF 解锁，若不拦会被当作用户滚动再镜像回来，
// 与平滑滚动（目录跳转/回到开头结尾）形成回环，把每帧进度拉回原位
function justMirrored() {
  return performance.now() - mirrorAt < 80
}

// ---------- 源码 ⇄ 正文 位置映射（锚点表） ----------
// 按比例镜像在两边高度不成比例时必然对不上（源码有底部留白、正文有图形/表格）。
// 参考 mdeditor：以「源码标题行 ↔ 渲染标题块」为锚点建表，中间按线性插值，
// 锚点不足时（无标题/预览隐藏）才回落到比例镜像。
interface Anchor {
  line: number
  srcTop: number
  pvTop: number
}
let anchors: Anchor[] = []

function srcLineTop(line: number): number {
  const cm = srcEditor.cm
  if (!cm) return 0
  return cm.heightAtLine(Math.max(0, Math.min(line, cm.lineCount() - 1)), 'local')
}
function srcLineCount(): number {
  return srcEditor.cm?.lineCount() ?? shownText.value.split('\n').length
}

/**
 * 目录项 → 源码行号：按标题文本匹配。
 * 不能按序号对应——渲染前的 preprocess 会增删行（摘除脚注定义、补空行）。
 */
function matchHeadingLines(): number[] {
  const cm = srcEditor.cm
  if (!cm) return []
  const norm = (s: string) =>
    s
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/[*_`~]/g, '')
      .replace(/\[([^[\]]*)\]\([^()]*\)/g, '$1')
      .trim()
  const heads: { line: number; text: string }[] = []
  for (let i = 0; i < cm.lineCount(); i++) {
    const raw = cm.getLine(i) ?? ''
    if (/^\s{0,3}#{1,6}(\s|$)/.test(raw)) heads.push({ line: i, text: norm(raw) })
  }
  const out: number[] = []
  let j = 0
  for (const it of store.toc) {
    const want = norm(it.text ?? '')
    let hit = -1
    for (let k = j; k < heads.length; k++) {
      if (heads[k]!.text === want) {
        hit = heads[k]!.line
        j = k + 1
        break
      }
    }
    if (hit < 0) break // 对不上就停止，后续区间交给相邻锚点插值
    out.push(hit)
  }
  return out
}

/** 重建锚点表：目录项（标题）的源码行号 ↔ 渲染块在正文里的位置。 */
function rebuildAnchors(): Anchor[] {
  anchors = []
  const sc = renderScrollEl.value
  if (!sc || !showRender.value || store.currentKind !== 'markdown') return anchors
  const pvMax = Math.max(0, sc.scrollHeight - sc.clientHeight)
  const heads = matchHeadingLines()
  const list: Anchor[] = [{ line: 0, srcTop: 0, pvTop: 0 }]
  const n = Math.min(heads.length, store.toc.length)
  for (let i = 0; i < n; i++) {
    const id = store.toc[i]?.id
    if (!id) continue
    const el = document.getElementById(id)
    if (!el || !sc.contains(el)) continue
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    const line = heads[i]!
    const st = srcLineTop(line)
    if (st <= list[list.length - 1]!.srcTop) continue // 保持单调
    list.push({ line, srcTop: st, pvTop: Math.max(0, Math.min(top - 8, pvMax)) })
  }
  const lastLine = Math.max(0, srcLineCount() - 1)
  // 末尾锚点用「源码可滚动到底」而不是最后一行行高：源码底部还有阅读留白
  const srcEl = sourceScroller()
  const lastSrc = srcEl ? Math.max(0, srcEl.scrollHeight - srcEl.clientHeight) : srcLineTop(lastLine)
  if (lastSrc > list[list.length - 1]!.srcTop && pvMax > 0) {
    list.push({ line: lastLine, srcTop: lastSrc, pvTop: pvMax })
  }
  anchors = list.length >= 2 ? list : []
  return anchors
}

function useAnchors(): Anchor[] {
  return anchors.length >= 2 ? anchors : rebuildAnchors()
}

/** 源码滚动位置 → 正文滚动位置（锚点间线性插值；返回 null 表示锚点不足） */
function previewTopForSrcTop(top: number): number | null {
  const sc = renderScrollEl.value
  if (!sc) return null
  const a = useAnchors()
  if (a.length < 2) return null
  const pvMax = Math.max(0, sc.scrollHeight - sc.clientHeight)
  if (top <= a[0]!.srcTop + 0.5) return 0
  const last = a[a.length - 1]!
  if (top >= last.srcTop - 0.5) return pvMax
  let i = 0
  for (let k = 1; k < a.length; k++) {
    if (a[k]!.srcTop <= top) i = k
    else break
  }
  const a1 = a[i]!
  const a2 = a[i + 1]!
  const span = a2.srcTop - a1.srcTop
  if (span <= 0) return a1.pvTop
  const r = (top - a1.srcTop) / span
  return Math.max(0, Math.min(a1.pvTop + r * (a2.pvTop - a1.pvTop), pvMax))
}

/** 正文滚动位置 → 源码滚动位置（反向插值；返回 null 表示锚点不足） */
function srcTopForPreviewTop(pvTop: number): number | null {
  const src = sourceScroller()
  if (!src) return null
  const a = useAnchors()
  if (a.length < 2) return null
  if (pvTop <= a[0]!.pvTop + 0.5) return 0
  const last = a[a.length - 1]!
  if (pvTop >= last.pvTop - 0.5) return Math.max(0, src.scrollHeight - src.clientHeight)
  let i = 0
  for (let k = 1; k < a.length; k++) {
    if (a[k]!.pvTop <= pvTop) i = k
    else break
  }
  const a1 = a[i]!
  const a2 = a[i + 1]!
  const span = a2.pvTop - a1.pvTop
  if (span <= 0) return a1.srcTop
  const r = (pvTop - a1.pvTop) / span
  return Math.max(0, a1.srcTop + r * (a2.srcTop - a1.srcTop))
}

function markMirrored() {
  mirrorAt = performance.now()
  syncing = true
  requestAnimationFrame(() => (syncing = false))
}

/** 源码滚动 → 正文（编辑态唯一的同步方向） */
function syncSourceToPreview(): boolean {
  const sc = renderScrollEl.value
  const src = sourceScroller()
  if (!sc || !src || !isSplit.value || !syncScroll.value || syncing) return false
  const t = previewTopForSrcTop(src.scrollTop)
  if (t == null) return mirror(src, sc)
  markMirrored()
  sc.scrollTop = t
  rememberRender(sc)
  return true
}

/** 正文滚动 → 源码（非编辑态；编辑态会拖走光标，故不启用） */
function syncPreviewToSource(): boolean {
  const sc = renderScrollEl.value
  const src = sourceScroller()
  if (!sc || !src || !isSplit.value || !syncScroll.value || syncing || editing.value) return false
  const st = srcTopForPreviewTop(sc.scrollTop)
  if (st == null) return mirror(sc, src)
  markMirrored()
  const cm = srcEditor.cm
  if (cm) cm.scrollTo(null, st)
  else src.scrollTop = Math.max(0, Math.min(st, src.scrollHeight - src.clientHeight))
  return true
}

/**
 * 编辑态跟随光标：光标所在行对应到正文的位置若已滚出视口，
 * 就把正文拉到该位置（解决「正在编辑的行在右边偏上甚至被挡住」）。
 */
function followCaret(line1: number) {
  if (!editing.value || !isSplit.value || !syncScroll.value || syncing) return
  const sc = renderScrollEl.value
  if (!sc) return
  const t = previewTopForSrcTop(srcLineTop(line1 - 1))
  if (t == null) return
  if (t >= sc.scrollTop - 8 && t <= sc.scrollTop + sc.clientHeight - 48) return // 已在视口内
  markMirrored()
  sc.scrollTop = t
  rememberRender(sc)
}

// ---------- 滚动 / 补充渲染 ----------
let savedRatio = 0
let savedFor = ''

/** 正文当前滚动比例：重渲染会改变内容高度，按比例记账比绝对像素稳定。 */
function renderRatio(): number {
  const sc = renderScrollEl.value
  if (!sc) return savedRatio
  const max = sc.scrollHeight - sc.clientHeight
  return max > 0 ? sc.scrollTop / max : 0
}

/**
 * 记住正文滚动位置。镜像写入（源码滚动带过来的）也要记：
 * 之前只在「用户直接滚正文」时记账，于是编辑重渲染后按过期位置还原，正文被拽回顶部。
 */
function rememberRender(sc: HTMLElement) {
  savedRatio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0
  savedFor = store.current?.path ?? ''
}

// 跨文件锚点：点击 md 内链带 #anchor 时，渲染完成后再跳
let pendingAnchor = ''
// 正文隐藏期间无法出图（容器无尺寸），记账后切回补做
let pendingPost = false
// 切到纯源码前记住正文滚动位置，切回来还原
let renderScrollTop = 0

function scrollToAnchor(anchor: string) {
  const art = articleEl.value
  const sc = renderScrollEl.value
  if (!art || !sc) return
  const target = decodeURIComponent(anchor).trim()
  if (!target) return
  let node: HTMLElement | undefined
  const heads = Array.from(art.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'))
  for (const h of heads) {
    if ((h.textContent ?? '').trim() === target) {
      node = h
      break
    }
  }
  if (!node) node = document.getElementById(target) ?? undefined
  if (!node) return
  const top = node.getBoundingClientRect().top - sc.getBoundingClientRect().top
  sc.scrollTo({ top: sc.scrollTop + top - 8, behavior: 'smooth' })
}

function spyHeading(sc: HTMLElement) {
  const heads = Array.from(
    articleEl.value?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]') ?? []
  )
  let active = ''
  for (const h of heads) {
    if (h.offsetTop <= sc.scrollTop + 80) active = h.id
    else break
  }
  store.activeHeading = active
}

/** 正文挂载后的补充渲染：Mermaid/SVG 图 + 数学公式。force 用于主题切换后的重绘。 */
async function postRender(art: HTMLElement, force = false) {
  if (store.hasMermaid || art.querySelector('[data-svg]')) {
    await renderDiagramsIn(art, store.settings?.theme === 'dark', force)
  }
  if (store.hasMath) await renderMathIn(art)
}

/** keepRatio：v-html 替换前记下的正文滚动比例（替换后内容高度已变，只能按比例还原）。 */
async function afterRender(redrawDiagram: boolean, keepRatio?: number) {
  const art = articleEl.value
  if (!art) return
  if (!showRender.value) {
    pendingPost = true
    // 换文件了：之前记住的正文滚动位置作废
    if (savedFor !== (store.current?.path ?? '')) renderScrollTop = 0
    return
  }
  await postRender(art, redrawDiagram)
  // 预览字数按渲染后可见文本统计（图形内部文字、复制按钮等不计）
  status.previewChars = store.currentKind === 'markdown' ? countPreviewText(art) : 0
  // 渲染结果变了 → 锚点表失效，重建后再还原滚动位置
  rebuildAnchors()

  const sc = renderScrollEl.value
  if (!sc) return
  if (redrawDiagram) return // 主题切换：保持滚动
  const path = store.current?.path ?? ''
  if (editing.value) {
    // 编辑草稿重渲染：以源码视口为准重新对齐，内容高度变了也不跟着跳
    const ok = isSplit.value && syncScroll.value && syncSourceToPreview()
    if (!ok) sc.scrollTop = (keepRatio ?? savedRatio) * (sc.scrollHeight - sc.clientHeight)
  } else if (savedFor === path) {
    sc.scrollTop = savedRatio * (sc.scrollHeight - sc.clientHeight)
  } else {
    sc.scrollTo({ top: 0 })
    savedRatio = 0
    savedFor = path
  }
  if (pendingAnchor) {
    const a = pendingAnchor
    pendingAnchor = ''
    scrollToAnchor(a)
  }
}

function onRenderScroll() {
  const sc = renderScrollEl.value
  if (!sc) return
  rememberRender(sc)
  // 程序写入的位置只记账、不再往回同步，否则两边互相牵引
  if (justMirrored()) return
  spyHeading(sc)
  syncPreviewToSource()
}

/** 源码侧滚动（CodeMirror 的 scroll 事件）：按锚点表同步到正文 */
function onSrcScroll() {
  if (justMirrored()) return
  syncSourceToPreview()
}

watch(
  () => store.html,
  async () => {
    // v-html 替换会让正文高度先归零，替换前先按比例记账，替换后才能还原到同一位置
    const ratio = renderRatio()
    await nextTick()
    await afterRender(false, ratio)
  }
)
watch(
  () => store.settings?.theme,
  async () => {
    // 图形跟随主题重绘，滚动位置不动
    if (articleEl.value?.querySelector('[data-mermaid]')) await afterRender(true)
  }
)
// 显示模式切换：只在「正文重新可见」时补做图形/公式渲染
watch(mode, async (to, from) => {
  const sc = renderScrollEl.value
  if (to === 'render' && editing.value) {
    // 只剩渲染视图时没有编辑入口，还原为文件内容
    cancelDraftTimer()
    editing.value = false
    draft.value = ''
    await renderDraft(sourceText.value)
  }
  if (to === 'source') {
    if (from !== 'source') renderScrollTop = sc?.scrollTop ?? 0
    await nextTick()
    refreshEditor() // 源码面板刚由 v-show 显示出来，需要重算尺寸
    return
  }
  await nextTick()
  refreshEditor()
  if (pendingPost) {
    pendingPost = false
    if (articleEl.value) await postRender(articleEl.value)
  }
  if (sc) {
    if (from === 'source') sc.scrollTop = renderScrollTop
    if (isSplit.value && syncScroll.value) {
      // 编辑态以源码视口为准，非编辑态从正文回推源码
      if (editing.value) syncSourceToPreview()
      else syncPreviewToSource()
    }
  }
})

// 空状态按钮：弹文件选择框打开 md
async function openFileByDialog() {
  try {
    const api = await getApi()
    const p = await api.OpenFileDialog()
    if (p) await openEntry(p)
  } catch (e) {
    toast(t('toast.openFailed', { e: String(e) }), 'error')
  }
}

// ---------- 图片灯箱 ----------
const lightbox = ref<{ open: boolean; src: string; svg: string }>({ open: false, src: '', svg: '' })

function openLightboxUrl(src: string) {
  lightbox.value = { open: true, src, svg: '' }
}
function openLightboxSvg(svg: string) {
  lightbox.value = { open: true, src: '', svg }
}
function closeLightbox() {
  lightbox.value.open = false
}

/** 双击正文图片 / 图形卡片（Mermaid、SVG）→ 全屏灯箱 */
function onArtDblClick(e: MouseEvent) {
  const tgt = e.target as HTMLElement
  const holder = tgt.closest('.md-diagram')
  if (holder) {
    const svgEl = holder.querySelector('.md-diagram-src svg')
    if (svgEl) {
      openLightboxSvg(svgEl.outerHTML)
      return
    }
  }
  const img = tgt.closest('img')
  const src = img?.getAttribute('src')
  if (src) openLightboxUrl(src)
}

async function onArtClick(e: MouseEvent) {
  const tgt = e.target as HTMLElement
  // 图形卡片「源码」：在渲染结果与源码之间切换
  const tgl = tgt.closest('button[data-toggle-src]') as HTMLElement | null
  if (tgl) {
    const card = tgl.closest('.md-diagram')
    card?.classList.toggle('show-src')
    return
  }
  // md 内链（渲染器产出 data-mdlink）
  const mdl = tgt.closest('a[data-mdlink]') as HTMLElement | null
  if (mdl) {
    e.preventDefault()
    pendingAnchor = (mdl.getAttribute('data-anchor') ?? '').replace(/^#/, '')
    openEntry(mdl.getAttribute('data-mdlink') ?? '')
    return
  }
  // wikilink
  const wiki = tgt.closest('a[data-wiki]') as HTMLElement | null
  if (wiki) {
    e.preventDefault()
    await openWikiLink(wiki.getAttribute('data-wiki') ?? '')
    return
  }
  // 代码/源码复制
  const btn = tgt.closest('button[data-copy]') as HTMLButtonElement | null
  if (btn) {
    const api = await getApi()
    await api.CopyText(decodeURIComponent(btn.getAttribute('data-copy') ?? ''))
    toast(t('toast.codeCopied'))
    btn.classList.add('done')
    setTimeout(() => btn.classList.remove('done'), 1200)
  }
}

async function onContext(e: MouseEvent) {
  const api = await getApi()
  const items: { label: string; action: () => void }[] = [
    {
      label: store.settings?.theme === 'dark' ? t('menu.themeLight') : t('menu.themeDark'),
      action: () => setTheme(store.settings?.theme === 'dark' ? 'light' : 'dark')
    }
  ]
  if (store.current) {
    items.push(
      {
        label: mode.value === 'split' ? t('menu.exitSplit') : t('menu.split'),
        action: () => setViewMode(mode.value === 'split' ? 'render' : 'split')
      },
      { label: t('menu.copyPath'), action: () => api.CopyText(store.current!.path) },
      { label: t('menu.reveal'), action: () => api.RevealInShell(store.current!.path) },
      { label: t('menu.exportHtml'), action: () => exportHtml() }
    )
  }
  showMenu(e.clientX, e.clientY, items)
}

/** 窗口尺寸变化后让 CodeMirror 重算行宽（尤其开了自动换行时） */
function onResize() {
  refreshEditor()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('mousemove', onSplitMove)
  document.removeEventListener('mouseup', onSplitUp)
})
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !store.settingsOpen) hideMenu()
}
</script>

<template>
  <main class="viewer" data-testid="viewer">
    <!-- 空状态：未打开任何文件 -->
    <div v-if="!store.current" class="viewer-empty">
      <AppIcon :size="76" class="empty-logo" />
      <p class="empty-title">mdview</p>
      <p class="empty-sub">{{ t('empty.sub') }}</p>
      <div class="empty-actions">
        <button class="empty-btn primary" @click="openFileByDialog">{{ t('empty.openFile') }}</button>
        <button class="empty-btn" @click="openFolder">{{ t('empty.openFolder') }}</button>
      </div>
    </div>

    <div v-else ref="splitWrapEl" class="viewer-body" :class="{ split: isSplit }">
      <!-- 源码面板：对照模式下固定在左侧 -->
      <section
        v-show="showSource"
        class="viewer-pane src-pane"
        :class="{ 'is-split': isSplit }"
        :style="isSplit ? { flex: `0 0 ${splitRatio * 100}%` } : {}"
        data-testid="source-pane"
      >
        <header class="pane-head src-head">
          <span class="pane-tag src">{{ isSplit ? t('src.tag') : t('src.tagFull') }}</span>
          <span class="src-path" :title="sourcePath">{{ sourcePath }}</span>
          <span class="src-meta">{{ sourceMeta }}</span>
          <button
            v-if="isSplit"
            class="src-btn"
            :class="{ on: syncScroll }"
            :title="t('src.sync.tip')"
            @click="syncScroll = !syncScroll"
          >
            {{ t('src.sync') }}
          </button>
          <button
            class="src-btn"
            :class="{ on: editing }"
            :title="editing ? t('src.edit.on.tip') : t('src.edit.tip')"
            data-testid="src-edit"
            @click="toggleEdit"
          >
            {{ t('src.edit') }}
          </button>
          <button
            class="src-btn primary"
            :disabled="!editing"
            :title="t('src.save.tip')"
            data-testid="src-save"
            @click="saveSource(draft)"
          >
            {{ t('src.save') }}
          </button>
          <button class="src-btn" :title="t('src.copy.tip')" data-testid="src-copy" @click="copySource">{{ t('src.copy') }}</button>
          <button
            v-if="!isSplit"
            class="src-btn"
            :title="t('src.back.tip')"
            data-testid="src-back"
            @click="setViewMode('render')"
          >
            {{ t('src.back') }}
          </button>
        </header>
        <div class="src-edit-wrap" :class="{ 'is-editing': editing }">
          <!-- 源码区：CodeMirror 负责语法高亮 / 行号 / 光标；只读态只是 readOnly，排版完全一致 -->
          <CodeEditor
            ref="editorRef"
            :model-value="shownText"
            :mode="srcMode"
            :dark="store.settings?.theme === 'dark'"
            :wrap="!!store.settings?.codeWrap"
            :line-no="showLineNo"
            :read-only="!editing"
            data-testid="src-cm"
            @update:model-value="onEditorInput"
            @input="onDraftInput"
            @caret="onCaret"
            @scroll="onSrcScroll"
          />
        </div>
      </section>

      <!-- 分栏拖拽条 -->
      <div
        v-if="isSplit"
        class="split-bar"
        :class="{ dragging }"
        :title="t('split.tip')"
        @mousedown="onSplitDown"
        @dblclick="evenSplit"
      >
        <span class="split-grip"></span>
      </div>

      <!-- 渲染正文：用 v-show 保持 DOM，切换源码回来时图形/滚动不丢 -->
      <section
        v-show="showRender"
        class="viewer-pane"
        :class="{ 'is-split': isSplit }"
        :style="isSplit ? { flex: '1 1 0' } : {}"
        data-testid="render-pane"
      >
        <header v-if="isSplit" class="pane-head">
          <span class="pane-tag">{{ t('render.tag') }}</span>
          <span class="pane-grow"></span>
          <!-- 最右侧状态：随编辑态显示「编辑模式 / 阅读模式」 -->
          <span class="pane-mode" :class="{ 'is-edit': editing }" data-testid="pane-mode">
            {{ editing ? t('pane.mode.edit') : t('pane.mode.read') }}
          </span>
        </header>
        <div
          ref="renderScrollEl"
          class="viewer-scroll"
          :class="{ __code_wrapped: store.settings?.codeWrap, 'mm-host': isMindmap }"
          data-testid="viewer-scroll"
          @scroll="onRenderScroll"
          @contextmenu.prevent="onContext"
          @dblclick="onArtDblClick"
        >
          <!-- 思维导图独占视图：标题栏/设置页切到「导图」时显示 -->
          <MindMap
            v-if="isMindmap"
            :markdown="sourceText"
            :name="store.current?.name ?? ''"
            :dark="store.settings?.theme === 'dark'"
            :max-len="store.settings?.mmMaxLen ?? 20"
          />
          <!-- 图片文件预览 -->
          <div v-else-if="store.currentKind === 'image'" class="img-view" data-testid="img-view">
            <img :src="store.imgUrl" alt="" draggable="false" />
          </div>
          <!-- 纯文本文件预览 -->
          <pre v-else-if="store.currentKind === 'text'" class="plain-text" data-testid="plain-text">{{ sourceText }}</pre>
          <article
            v-else
            ref="articleEl"
            class="md-article"
            :class="{ 'in-split': isSplit }"
            data-testid="article"
            v-html="store.html"
            @click="onArtClick"
          ></article>
        </div>
      </section>
    </div>

    <!-- 全屏图片灯箱：双击图片 / Mermaid / SVG 卡片打开，关闭时还原窗口全屏状态 -->
    <ImageLightbox
      v-if="lightbox.open"
      :src="lightbox.src"
      :svg="lightbox.svg"
      @close="closeLightbox"
    />
  </main>
</template>
