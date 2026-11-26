<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  store,
  patchSettings,
  setTheme,
  setViewMode,
  renderDraft,
  saveSource,
  exportHtml,
  openEntry,
  openFolder,
  openWikiLink,
  toast,
  setDraftText,
  clearDraft,
  cancelDraftRender,
  confirmDiscard,
  syncDraftDirty,
  navPushAnchor
} from '../store'
import { showMenu, hideMenu } from '../context-menu'
import CodeEditor from './CodeEditor.vue'
import { getApi } from '../api'
import { renderDiagramsIn, renderMathIn } from '../markdown'
import { countPreviewText, countStats } from '../stats'
import { srcEditor, scrollSrcToPx } from '../editor-bridge'
import {
  invalidateSync,
  isSyncDirty,
  hasSyncMarks,
  resetSyncState,
  rebuildSync,
  renderToSource,
  sourceToRender,
  activeHeadingId,
  syncDiagnostics,
  type RebuildResult
} from '../sync'
import { status } from '../status'
import { t } from '../i18n'
import type { MermaidEngine, ViewMode } from '../types'
import AppIcon from './AppIcon.vue'
import ImageLightbox from './ImageLightbox.vue'
import MindMap from './MindMap.vue'

const articleEl = ref<HTMLElement | null>(null)
const renderScrollEl = ref<HTMLElement | null>(null)
const splitWrapEl = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof CodeEditor> | null>(null)
const srcPaneEl = ref<HTMLElement | null>(null)
const renderPaneEl = ref<HTMLElement | null>(null)

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

// 源码编辑草稿提升到 store：关闭/重启/切换/外部重载/退出编辑共用同一份状态与确认出口
const editing = computed({
  get: () => store.editing,
  set: (v: boolean) => { store.editing = v }
})
const draft = computed({
  get: () => store.draft,
  set: (v: string) => { store.draft = v }
})
// 编辑器实际内容：编辑中是草稿，否则是文件内容
const shownText = computed(() => (editing.value ? draft.value : sourceText.value))

async function copySource() {
  const api = await getApi()
  // 编辑中复制当前草稿，否则复制文件内容
  await api.CopyText(shownText.value)
  toast(t('toast.copiedSource'))
}

// Pele 的配色来自外部 CSS 变量，单独光栅化 SVG 时要先把实际值内联到根节点
const PELE_CSS_VARS = [
  '--pele-bg', '--pele-fg', '--pele-muted', '--pele-line', '--pele-surface',
  '--pele-surface-alt', '--pele-border', '--pele-accent', '--pele-critical',
  '--pele-font', '--pele-font-mono', '--pele-radius'
]
for (let i = 1; i <= 8; i++) PELE_CSS_VARS.push(`--pele-series-${i}`)

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * WebView2/Chromium 会把含 foreignObject 的 SVG 判为受污染，导致 toDataURL 失败；
 * Mermaid strict 的节点文字仍在 foreignObject 里。仅在光栅化的副本上把它改写成
 * 原生 SVG <text>，页面里显示的 SVG 不动。
 */
function svgForRasterize(source: SVGSVGElement, clone: SVGSVGElement): void {
  const originals = Array.from(source.querySelectorAll('foreignObject'))
  const copies = Array.from(clone.querySelectorAll('foreignObject'))
  copies.forEach((fo, i) => {
    const orig = originals[i]
    const x = parseFloat(fo.getAttribute('x') || '0') || 0
    const y = parseFloat(fo.getAttribute('y') || '0') || 0
    const w = parseFloat(fo.getAttribute('width') || '0') || 0
    const h = parseFloat(fo.getAttribute('height') || '0') || 0
    const label = (orig?.querySelector('div, span') ?? null) as HTMLElement | null
    const lines = String(label?.innerText || orig?.textContent || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!lines.length) {
      fo.remove()
      return
    }
    const cs = label ? getComputedStyle(label) : null
    const fontSize = parseFloat(cs?.fontSize || '14') || 14
    const lineHeight = fontSize * 1.25
    const text = clone.ownerDocument.createElementNS(SVG_NS, 'text')
    const cx = x + w / 2
    text.setAttribute('x', String(cx))
    text.setAttribute('y', String(y + h / 2 - ((lines.length - 1) * lineHeight) / 2))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'middle')
    text.setAttribute('font-size', String(fontSize))
    text.setAttribute('font-weight', cs?.fontWeight || 'normal')
    if (cs?.fontFamily) text.setAttribute('font-family', cs.fontFamily)
    text.setAttribute('fill', cs?.color || '#333333')
    lines.forEach((line, idx) => {
      const tspan = clone.ownerDocument.createElementNS(SVG_NS, 'tspan')
      tspan.setAttribute('x', String(cx))
      tspan.setAttribute('dy', idx === 0 ? '0' : String(lineHeight))
      tspan.textContent = line
      text.appendChild(tspan)
    })
    const parent = fo.parentNode
    if (!parent) return
    parent.replaceChild(text, fo)
    // Mermaid 的 <switch> 里 foreignObject 后面还有一份纯文本兜底，去掉避免重影
    if (parent.nodeName.toLowerCase() === 'switch') {
      Array.from(parent.children).forEach((child) => {
        if (child !== text && child.namespaceURI === SVG_NS && child.localName === 'text') child.remove()
      })
    }
  })
}

/** 把图形卡片里已净化的 SVG 光栅化为 PNG data URL（复制图片用）。 */
async function diagramPngDataUrl(card: HTMLElement): Promise<string> {
  const svg = card.querySelector('.md-diagram-src svg') as SVGSVGElement | null
  if (!svg) throw new Error('no diagram svg')
  const clone = svg.cloneNode(true) as SVGSVGElement
  svgForRasterize(svg, clone)
  const rect = svg.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width || parseFloat(svg.getAttribute('width') || '') || 800))
  const h = Math.max(1, Math.round(rect.height || parseFloat(svg.getAttribute('height') || '') || 600))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  // Mermaid 的主题在 SVG 自带 <style> 里；Pele 依赖 CSS 变量，必须内联
  const cs = getComputedStyle(svg)
  const css: string[] = []
  for (const name of PELE_CSS_VARS) {
    const v = cs.getPropertyValue(name).trim()
    if (v) css.push(`${name}:${v}`)
  }
  const font = cs.fontFamily.trim()
  if (font) css.push(`font-family:${font}`)
  if (css.length) clone.setAttribute('style', `${clone.getAttribute('style') ?? ''};${css.join(';')}`)

  const xml = new XMLSerializer().serializeToString(clone)
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg rasterize failed'))
      img.src = url
    })
    const scale = Math.min(3, window.devicePixelRatio || 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.scale(scale, scale)
    ctx.fillStyle =
      getComputedStyle(document.documentElement).getPropertyValue('--md-bg').trim() || '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
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

/** 取消待执行的草稿重渲染：退出编辑/换文件后不能再拿旧草稿覆盖正文。 */
function cancelDraftTimer() {
  cancelDraftRender()
}

/** 编辑器里的文本变化（只读态 CodeMirror 不会触发） */
function onEditorInput(v: string) {
  setDraftText(v)
}

async function toggleEdit() {
  // 退出编辑是五个丢弃出口之一：有未保存改动时先确认
  if (editing.value && !(await confirmDiscard('exit'))) return
  // 只读与编辑共用同一个 CodeMirror 实例，只切换 readOnly；
  // 行高/排版完全不变，滚动位置不用换算
  cancelDraftTimer()
  const from = sourceScroller()
  const prevTop = from?.scrollTop ?? 0

  editing.value = !editing.value
  if (editing.value) {
    draft.value = sourceText.value
    syncDraftDirty()
  } else {
    clearDraft()
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
  setDraftText(draft.value)
}

// 保存按钮与 Ctrl+S 共用一个入口：成功后由 saveSource 弹「已保存」气泡，
// saving 防止键盘连续触发 / 双击造成并发写文件
const saving = ref(false)
async function saveDraft() {
  if (!editing.value || saving.value || !store.current) return
  saving.value = true
  try {
    await saveSource(draft.value)
    // 保存成功后草稿内容 == 文件内容，未保存标记自动清零
    syncDraftDirty()
  } finally {
    saving.value = false
  }
}

// 切换文件：确认与清理由 store.openFile → confirmDiscard / clearDraft 统一负责；
// 这里只兜底取消尚未落地的防抖渲染，不能再拿旧草稿覆盖新文件内容。
watch(
  () => store.current?.path,
  () => {
    cancelDraftTimer()
    resetSyncRuntime()
  }
)
// 字号/编辑态切换会影响布局，对齐点表置脏，下次滚动前重建
watch(() => store.settings?.fontSize, () => invalidateSync())
watch(editing, () => invalidateSync())
// 补全失效源（源码侧）：换行/行号切换、分栏宽度、窗口缩放都会改变源码几何，
// 漏掉任何一个都会让源码刻度整体漂移（渲染→源码被钳位提前钉底的元凶）
watch(() => store.settings?.codeWrap, () => invalidateSync())
watch(() => store.settings?.lineNo, () => invalidateSync())
const srcRo = new ResizeObserver(() => invalidateSync())
watch(srcPaneEl, (el) => {
  if (el) srcRo.observe(el)
})
const onWinResize = () => invalidateSync()
window.addEventListener('resize', onWinResize, { passive: true })
// 进入 split / 打开同步开关：清状态，等布局稳定两帧再允许重建
// （避免在 flex 样式未应用的帧量到 0 高，产生全零 marks）
watch([isSplit, syncScroll], () => {
  resetSyncRuntime()
  requestAnimationFrame(() => requestAnimationFrame(() => invalidateSync()))
})
// dev 诊断出口：console 里 __syncDiag() 一眼看清刻度是否吻合
if (import.meta.env.DEV) {
  ;(window as any).__syncDiag = () => syncDiagnostics(renderScrollEl.value, srcEditor.cm)
}

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

// ---------- 源码 ⇄ 正文 位置映射（sync.ts 对齐点表） ----------
// 以 data-sl 块级锚点 + 标题锚点建点表，段内线性插值、端点外推；异步布局变化后
// 置脏，下次滚动前由 ensureMarks 重建。点表不足时回落到比例镜像。

function srcLineTop(line: number): number {
  const cm = srcEditor.cm
  if (!cm) return 0
  return cm.heightAtLine(Math.max(0, Math.min(line, cm.lineCount() - 1)), 'local')
}

/** 滚动前确保对齐点表有效：脏了就重建；源码几何可疑时 refresh 重测，下一帧再建 */
function ensureMarks(): boolean {
  const art = articleEl.value
  const sc = renderScrollEl.value
  const cm = srcEditor.cm
  if (!art || !sc || !cm || store.currentKind !== 'markdown') return hasSyncMarks()
  if (!isSyncDirty() && hasSyncMarks()) return true
  const res: RebuildResult = rebuildSync(art, sc, cm, store.srcAnchors)
  if (res === 'stale') {
    try {
      cm.refresh()
    } catch {
      /* CM 会在下一帧完成重测量 */
    }
    requestAnimationFrame(() => invalidateSync()) // 重测后下一帧重建
  }
  return hasSyncMarks()
}

/** 源码滚动位置 → 正文滚动位置（点表插值；返回 null 表示点表不足，回落镜像） */
function previewTopForSrcTop(top: number): number | null {
  const sc = renderScrollEl.value
  if (!sc || !ensureMarks()) return null
  const y = sourceToRender(top)
  if (y == null) return null
  const pvMax = Math.max(0, sc.scrollHeight - sc.clientHeight)
  return Math.max(0, Math.min(y, pvMax))
}

/** 正文滚动位置 → 源码滚动位置（反向插值；返回 null 表示点表不足，回落镜像） */
function srcTopForPreviewTop(pvTop: number): number | null {
  const src = sourceScroller()
  if (!src || !ensureMarks()) return null
  const st = renderToSource(pvTop)
  if (st == null) return null
  const srcMax = Math.max(0, src.scrollHeight - src.clientHeight)
  return Math.max(0, Math.min(st, srcMax))
}

function markMirrored() {
  mirrorAt = performance.now()
  syncing = true
  requestAnimationFrame(() => (syncing = false))
}

// 双向同步的运行时状态：lastSet 记录程序写入的对侧位置（阈值内视作回声），
// lockUntil 是同步锁时间戳（80ms 内忽略对侧回声），resetSyncRuntime 在切文件时复位
let rafRd = 0
let rafSrc = 0
let lockUntil = 0
const lastSet = { src: -1, rd: -1 }
function resetSyncRuntime(): void {
  lastSet.src = -1
  lastSet.rd = -1
  lockUntil = 0
  resetSyncState()
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

/**
 * 标题锚点规范化：与 markdown.ts 的 makeSluger() 保持同一套 GitHub slug 规则。
 * 渲染器给标题的 id 是 `h-<slug>`（前缀避开页面组件 id），而 md 里的 (#...)
 * 链接写的是不带前缀的标准 slug，两者不能直接按 id 相等匹配。
 */
function anchorSlug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '') || 'h'
  )
}

function scrollToAnchor(anchor: string) {
  const art = articleEl.value
  const sc = renderScrollEl.value
  if (!art || !sc) return
  let target = anchor.replace(/^#/, '').trim()
  try {
    target = decodeURIComponent(target)
  } catch {
    /* 源码里带了裸 % 时 decode 会抛错，保留原样 */
  }
  if (!target) return
  const heads = Array.from(art.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'))
  let node: HTMLElement | undefined
  // 1. 标题原文：跨文件锚点常直接写成标题文字
  node = heads.find((h) => (h.textContent ?? '').trim() === target)
  // 2. 元素 id：脚注往返（fn-*/fnref-*）、md 里自带的自定义锚点
  if (!node) node = document.getElementById(target) ?? undefined
  // 3. 渲染器产出的标题 id 带 h- 前缀，标准 Markdown 锚点不带
  if (!node) node = document.getElementById(`h-${target}`) ?? undefined
  // 4. 兜底：锚点写法未必是标准 slug（带点、空格、大小写等），规范化后再比
  if (!node) {
    const want = anchorSlug(target)
    if (want) {
      node = heads.find(
        (h) => anchorSlug(h.textContent ?? '') === want || anchorSlug(h.id.replace(/^h-/, '')) === want
      )
    }
  }
  if (!node) return
  const top = node.getBoundingClientRect().top - sc.getBoundingClientRect().top
  sc.scrollTo({ top: sc.scrollTop + top - 8, behavior: 'smooth' })
}

// 标题高亮：由 sync.ts 的对齐点表在滚动时一并给出（activeHeadingId），
// 不再逐帧 querySelectorAll

function invalidateAnchors(): void {
  // Mermaid/KaTeX/懒加载图片异步撑高布局，对齐点表失效，下次滚动前重建
  invalidateSync()
}

const mmEngine = (): MermaidEngine => store.settings?.mermaidEngine ?? 'pele'

/** 正文挂载后的补充渲染：Mermaid/SVG 图 + 数学公式。force 用于主题/引擎切换后的重绘。 */
async function postRender(art: HTMLElement, force = false) {
  if (store.hasMermaid || art.querySelector('[data-svg]')) {
    await renderDiagramsIn(art, store.settings?.theme === 'dark', force, mmEngine())
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
  status.previewChars =
    store.currentKind === 'markdown' && mode.value !== 'mindmap' && mode.value !== 'source'
      ? countPreviewText(art)
      : 0
  // 渲染结果变了 → 对齐点表失效，下次滚动前重建
  invalidateSync()

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
  const crossAnchor = store.pendingAnchor
  if (crossAnchor) store.pendingAnchor = ''
  const a = crossAnchor || pendingAnchor
  if (a) {
    pendingAnchor = ''
    scrollToAnchor(a)
  }
}

// scroll 事件一帧可触发多次，且处理里有 DOM 读写；统一 rAF 节流，一帧最多算一次
// 饱和自愈节流：渲染远未到底、源码却被钳住 → 映射过期，强制重建
let lastHeal = 0

function onRenderScroll() {
  if (rafRd) return
  rafRd = requestAnimationFrame(() => {
    rafRd = 0
    const sc = renderScrollEl.value
    if (!sc) return
    rememberRender(sc)
    // 程序写入的位置只记账、不再往回同步，否则两边互相牵引
    if (justMirrored()) return
    // 标题高亮与同步滚动共用对齐点表（编辑态也照常更新）
    if (ensureMarks()) {
      const hid = activeHeadingId(sc)
      if (hid && hid !== store.activeHeading) store.activeHeading = hid
    }
    if (!isSplit.value || !syncScroll.value || editing.value) return
    if (Date.now() < lockUntil) return
    if (Math.abs(sc.scrollTop - lastSet.rd) < 2) return // 程序滚动回声抑制
    const t = renderToSource(sc.scrollTop) // v2：入参/出参均为滚动位置
    if (t == null) return syncPreviewToSource() // 点表不足回落比例镜像
    const res = scrollSrcToPx(t)
    lockUntil = Date.now() + 80 // 同步锁：抑制对侧回声
    lastSet.src = res.top // 与 scrollTop 同一坐标系
    // 饱和自愈：渲染远未到底、源码却被钳住 → 映射过期，强制重建
    const R = sc.scrollHeight - sc.clientHeight
    if (res.clamped && sc.scrollTop < R * 0.85 && Date.now() - lastHeal > 800) {
      lastHeal = Date.now()
      invalidateSync()
    }
  })
}

/** 源码侧滚动（CodeMirror 的 scroll 事件）：按对齐点表同步到正文 */
function onSrcScroll() {
  if (rafSrc) return
  rafSrc = requestAnimationFrame(() => {
    rafSrc = 0
    if (justMirrored()) return
    if (!isSplit.value || !syncScroll.value) return
    if (Date.now() < lockUntil) return
    const sc = sourceScroller()
    const rd = renderScrollEl.value
    if (!sc || !rd) return
    if (Math.abs(sc.scrollTop - lastSet.src) < 2) return
    if (!ensureMarks()) return syncSourceToPreview()
    const y = sourceToRender(sc.scrollTop)
    if (y == null) return syncSourceToPreview()
    lockUntil = Date.now() + 80
    const target = Math.max(0, Math.min(y, Math.max(0, rd.scrollHeight - rd.clientHeight)))
    lastSet.rd = target
    rd.scrollTop = target
    rememberRender(rd)
  })
}

// 渲染序号：渲染（nextTick/afterRender）是异步的，快速连续切文件时
// 旧回调可能晚到并覆盖新内容/滚动位置，落地前必须比对序号
let renderSeq = 0
watch(
  () => store.html,
  async () => {
    const seq = ++renderSeq
    // v-html 替换会让正文高度先归零，替换前先按比例记账，替换后才能还原到同一位置
    const ratio = renderRatio()
    await nextTick()
    if (seq !== renderSeq) return
    await afterRender(false, ratio)
  }
)
watch(
  () => store.settings?.theme,
  async () => {
    // 图形跟随主题重绘，滚动位置不动（Pele 块由 CSS 变量换色，不会被清标记）
    if (articleEl.value?.querySelector('[data-mermaid]')) await afterRender(true)
  }
)
watch(
  () => store.settings?.mermaidEngine,
  async () => {
    // 引擎切换：按新引擎强制重绘已有图形，滚动位置不动
    if (articleEl.value?.querySelector('[data-mermaid]')) await afterRender(true)
  }
)
// 显示模式切换：只在「正文重新可见」时补做图形/公式渲染
watch(mode, async (to, from) => {
  const sc = renderScrollEl.value
  if (to === 'render' && editing.value) {
    // 只剩渲染视图时没有编辑入口：先确认，用户保留修改则退回对照模式继续编辑
    if (!(await confirmDiscard('exit'))) {
      setViewMode('split')
      return
    }
    cancelDraftTimer()
    clearDraft()
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
const lightbox = ref<{ open: boolean; src: string; svg: string; engine: MermaidEngine }>({
  open: false,
  src: '',
  svg: '',
  engine: 'mermaid'
})

function openLightboxUrl(src: string) {
  lightbox.value = { open: true, src, svg: '', engine: 'mermaid' }
}
function openLightboxSvg(svg: string, engine: MermaidEngine) {
  lightbox.value = { open: true, src: '', svg, engine }
}
function closeLightbox() {
  lightbox.value.open = false
}

/** 双击正文图片 / 图形卡片（Mermaid、SVG）→ 全屏灯箱 */
function onArtDblClick(e: MouseEvent) {
  const tgt = e.target as HTMLElement
  const holder = tgt.closest<HTMLElement>('.md-diagram')
  if (holder) {
    const svgEl = holder.querySelector('.md-diagram-src svg')
    if (svgEl) {
      openLightboxSvg(svgEl.outerHTML, holder.dataset.engine === 'pele' ? 'pele' : 'mermaid')
      return
    }
  }
  const img = tgt.closest('img')
  const src = img?.getAttribute('src')
  if (src) openLightboxUrl(src)
}

async function onArtClick(e: MouseEvent) {
  const tgt = e.target as HTMLElement
  // 外部链接（http/https/mailto）：交给系统默认浏览器，不在 WebView 内导航
  const ext = tgt.closest('a[data-ext]') as HTMLElement | null
  if (ext) {
    e.preventDefault()
    const api = await getApi()
    try {
      await api.OpenExternalURL(ext.getAttribute('data-ext') ?? '')
    } catch (err) {
      toast(t('toast.extLinkFailed', { e: String(err) }), 'error')
    }
    return
  }
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
  // 死链：href="#" 只是为了可聚焦，点击不应滚到页首
  const dl = tgt.closest('a[data-dead]') as HTMLElement | null
  if (dl) {
    e.preventDefault()
    toast(t('toast.deadLink', { href: dl.getAttribute('data-dead') ?? '' }), 'error')
    return
  }
  // 文内锚点：渲染器产出的 # 链接（data-anchor）与脚注往返链接（href="#fn-*"）
  // 统一拦下来自己滚，避免 WebView 走原生 fragment 导航改掉页面地址
  const al = tgt.closest('a.md-link-anchor, a[href^="#"]') as HTMLElement | null
  if (al) {
    e.preventDefault()
    const anchor = al.getAttribute('data-anchor') ?? al.getAttribute('href') ?? ''
    navPushAnchor(anchor.replace(/^#/, ''))
    scrollToAnchor(anchor)
    return
  }
  // wikilink
  const wiki = tgt.closest('a[data-wiki]') as HTMLElement | null
  if (wiki) {
    e.preventDefault()
    await openWikiLink(wiki.getAttribute('data-wiki') ?? '', wiki.getAttribute('data-anchor') ?? '')
    return
  }
  // 代码/源码复制：按钮只带 data-copy 标志，复制内容点击时从所在卡片的
  // <pre> 取 textContent——避免每段代码全文在 DOM 属性里再存一份
  const btn = tgt.closest('button[data-copy]') as HTMLButtonElement | null
  if (btn) {
    const diagram = btn.closest('.md-diagram') as HTMLElement | null
    const api = await getApi()
    try {
      if (diagram && !diagram.classList.contains('show-src')) {
        // 渲染态：复制当前图形（PNG 位图）；源码态仍复制 Markdown 源码
        await api.CopyImage(await diagramPngDataUrl(diagram))
        toast(t('toast.imageCopied'))
      } else {
        const holder = btn.closest('.code-block') ?? diagram
        const code = holder?.querySelector('pre code, pre.md-diagram-code code')?.textContent ?? ''
        await api.CopyText(code)
        toast(t('toast.codeCopied'))
      }
      btn.classList.add('done')
      setTimeout(() => btn.classList.remove('done'), 1200)
    } catch (err) {
      toast(t('toast.opFailed', { e: String(err) }), 'error')
    }
  }
}

/** 图表头部的引擎下拉框：切引擎是全局设置，触发所有图表按新引擎重绘。 */
async function onArtChange(e: Event) {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-mm-engine]')
  if (!sel) return
  const engine: MermaidEngine = sel.value === 'pele' ? 'pele' : 'mermaid'
  if ((store.settings?.mermaidEngine ?? 'pele') === engine) return
  await patchSettings({ mermaidEngine: engine })
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
      // 图片/纯文本/导图模式下正文不是 HTML 文档，导出会得到空文件，直接不提供入口
      ...(store.currentKind === 'markdown' && mode.value !== 'mindmap'
        ? [{ label: t('menu.exportHtml'), action: () => exportHtml() }]
        : [])
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
  // 异步布局变化（懒加载图片、Mermaid 出图）让锚点表过期：捕获阶段接 img load，RO 接尺寸变化
  artResize = new ResizeObserver(() => invalidateAnchors())
  if (articleEl.value) {
    artResize.observe(articleEl.value)
    articleEl.value.addEventListener('load', invalidateAnchors, true)
  }
})
let artResize: ResizeObserver | null = null
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
  document.removeEventListener('mousemove', onSplitMove)
  document.removeEventListener('mouseup', onSplitUp)
  artResize?.disconnect()
  artResize = null
  articleEl.value?.removeEventListener('load', invalidateAnchors, true)
  srcRo.disconnect()
  window.removeEventListener('resize', onWinResize)
})
// ---------- 快捷键 ----------
// Ctrl+A 浏览器默认全选整页：分栏时左右两个面板（连同侧栏）会一起高亮。
// 这里按「活动面板」只建一个选区；活动面板 = 键盘焦点所在面板，
// 否则取最近一次点击/聚焦过的面板（且必须当前可见）。
type ActivePane = 'source' | 'render'
let activePane: ActivePane = 'render'

function activatePane(p: ActivePane) {
  activePane = p
  // 点到渲染面板时主动让源码侧失焦：否则残留的 CodeMirror 焦点会被判成活动面板
  if (p === 'render') {
    const ae = document.activeElement
    if (ae instanceof HTMLElement && srcPaneEl.value?.contains(ae)) ae.blur()
  }
}

function isTextControl(target: EventTarget | null): boolean {
  const tag = target instanceof HTMLElement ? target.tagName : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** 弹窗/输入控件打开时不接管快捷键，CodeMirror 自己处理过的也不重复接管。 */
function shortcutBlocked(e: KeyboardEvent): boolean {
  return (
    e.defaultPrevented ||
    !!store.settingsOpen ||
    !!store.goneFile ||
    !!store.discardReason ||
    searchOpen.value ||
    lightbox.value.open ||
    isTextControl(e.target)
  )
}

function activePaneFor(e: KeyboardEvent): ActivePane | null {
  const t = e.target instanceof HTMLElement && e.target !== document.body ? e.target : null
  const ae =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
  const el = t ?? ae
  if (el) {
    if (srcPaneEl.value?.contains(el)) return 'source'
    if (renderPaneEl.value?.contains(el)) return 'render'
  }
  if (activePane === 'source' && showSource.value) return 'source'
  if (activePane === 'render' && showRender.value) return 'render'
  return showSource.value ? 'source' : showRender.value ? 'render' : null
}

/** 只选中指定面板的内容，不惊动另一个面板。 */
function selectAllIn(pane: ActivePane) {
  const sel = window.getSelection()
  if (!sel) return
  if (pane === 'source') {
    const sc = sourceScroller()
    // 让 CodeMirror 内部选区也覆盖全文（编辑态复制能拿到完整源码）
    editorRef.value?.selectAll()
    const cmFocused = !!srcPaneEl.value?.contains(document.activeElement)
    // CM 有焦点时它自己已画出选区；只读态（nocursor）拿不到焦点，用原生 Range 兜底
    if (cmFocused && sel.anchorNode && sc?.contains(sel.anchorNode)) return
    const code = sc?.querySelector('.CodeMirror-lines') ?? sc
    if (!code) return
    const r = document.createRange()
    r.selectNodeContents(code)
    sel.removeAllRanges()
    sel.addRange(r)
    return
  }
  const host = renderScrollEl.value
  if (!host) return
  // 焦点仍在源码侧时先移走，避免 CodeMirror 把新选区抢回去
  const ae = document.activeElement
  if (ae instanceof HTMLElement && srcPaneEl.value?.contains(ae)) ae.blur()
  const r = document.createRange()
  r.selectNodeContents(host)
  sel.removeAllRanges()
  sel.addRange(r)
}

// ---------- 阅读快捷入口：Ctrl+O 打开 / Ctrl+P 最近文件 / Ctrl+F 查找 ----------
const searchOpen = ref(false)
const searchText = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

async function openByDialog() {
  const api = await getApi()
  const p = await api.OpenFileDialog()
  if (p) void openEntry(p, { reRoot: true })
}

async function quickSwitch() {
  const recent = store.history.slice(0, 10).map((e) => e.path).filter(Boolean)
  if (!recent.length) {
    toast(t('toast.noRecent'), 'info')
    return
  }
  showMenu(120, 64, recent.map((p) => ({ label: p, action: () => void openEntry(p) })))
}

function findText(backwards = false) {
  const q = searchText.value.trim()
  if (!q) return
  const found = window.find(q, false, backwards, true, false, false)
  if (!found) toast(t('toast.findNone', { q }), 'info')
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && searchOpen.value) {
    searchOpen.value = false
    return
  }
  if (e.key === 'Escape' && !store.settingsOpen) hideMenu()
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
  const key = e.key.toLowerCase()
  if (key === 'o' || e.code === 'KeyO') {
    if (shortcutBlocked(e)) return
    e.preventDefault()
    void openByDialog()
    return
  }
  if (key === 'p' || e.code === 'KeyP') {
    if (shortcutBlocked(e)) return
    e.preventDefault()
    void quickSwitch()
    return
  }
  if (key === 'f' || e.code === 'KeyF') {
    if (shortcutBlocked(e)) return
    e.preventDefault()
    searchOpen.value = true
    void nextTick(() => searchInput.value?.focus())
    return
  }
  if (key === 's' || e.code === 'KeyS') {
    // 编辑态全局保存；成功后 saveSource 会弹「已保存」气泡
    if (!editing.value || e.repeat || shortcutBlocked(e)) return
    e.preventDefault()
    void saveDraft()
    return
  }
  if (key === 'a' || e.code === 'KeyA') {
    if (shortcutBlocked(e) || !store.current) return
    const pane = activePaneFor(e)
    if (!pane) return
    e.preventDefault()
    selectAllIn(pane)
  }
}
</script>

<template>
  <main class="viewer" data-testid="viewer">
    <!-- Ctrl+F 查找条：用 WebView 原生查找，命中高亮由浏览器负责 -->
    <div v-if="searchOpen" class="viewer-search">
      <input
        ref="searchInput"
        v-model="searchText"
        type="search"
        :placeholder="t('find.placeholder')"
        :aria-label="t('find.placeholder')"
        @keydown.enter.prevent="findText(false)"
        @keydown.shift.enter.prevent="findText(true)"
      />
      <button type="button" :title="t('find.prev')" @click="findText(true)">↑</button>
      <button type="button" :title="t('find.next')" @click="findText(false)">↓</button>
      <button type="button" :title="t('find.close')" @click="searchOpen = false">✕</button>
    </div>
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
        ref="srcPaneEl"
        class="viewer-pane src-pane"
        :class="{ 'is-split': isSplit }"
        @pointerdown="activatePane('source')"
        @focusin="activatePane('source')"
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
            :disabled="!editing || saving"
            :title="t('src.save.tip')"
            data-testid="src-save"
            @click="saveDraft"
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
        ref="renderPaneEl"
        class="viewer-pane"
        :class="{ 'is-split': isSplit }"
        @pointerdown="activatePane('render')"
        @focusin="activatePane('render')"
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
            @change="onArtChange"
          ></article>
        </div>
      </section>
    </div>

    <!-- 全屏图片灯箱：双击图片 / Mermaid / SVG 卡片打开，关闭时还原窗口全屏状态 -->
    <ImageLightbox
      v-if="lightbox.open"
      :src="lightbox.src"
      :svg="lightbox.svg"
      :engine="lightbox.engine"
      @close="closeLightbox"
    />
  </main>
</template>
