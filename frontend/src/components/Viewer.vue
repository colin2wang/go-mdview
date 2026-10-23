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
import { getApi } from '../api'
import { renderDiagramsIn, renderMathIn } from '../markdown'
import { t } from '../i18n'
import type { ViewMode } from '../types'
import AppIcon from './AppIcon.vue'
import ImageLightbox from './ImageLightbox.vue'
import MindMap from './MindMap.vue'

const articleEl = ref<HTMLElement | null>(null)
const renderScrollEl = ref<HTMLElement | null>(null)
const srcScrollEl = ref<HTMLElement | null>(null)
const splitWrapEl = ref<HTMLElement | null>(null)
const editEl = ref<HTMLTextAreaElement | null>(null)
const gutterEl = ref<HTMLElement | null>(null)

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
// 只读态与编辑态共用同一套渲染格式（行号槽 + 等宽正文），切换时视觉一致
// 超大文件不做逐行 DOM，直接整段文本，避免上万行把界面拖卡
const SRC_MAX_LINES = 6000
const SRC_MAX_CHARS = 400000

interface SrcLine {
  n: number
  html: string
  heading: boolean
}

const sourceText = computed(() => store.current?.content ?? '')
const sourcePath = computed(() => store.current?.path ?? '')
const sourceMeta = computed(() => {
  const c = store.current
  if (!c) return ''
  const lines = c.content ? c.content.split('\n').length : 0
  return `${t('src.metaLines', { n: lines })} · ${c.encoding} · ${(c.size / 1024).toFixed(1)} KB`
})
const srcTooBig = computed(() => {
  const c = store.current
  if (!c) return false
  return c.size > SRC_MAX_CHARS || c.content.split('\n').length > SRC_MAX_LINES
})

// 源码编辑草稿：只改内存里的渲染结果，不写回文件；关闭编辑或切换文件即还原
const editing = ref(false)
const draft = ref('')
// 输入法组合期间候选字还留在 textarea 里没写进草稿：临时撤掉高亮层让 textarea 自己显字，
// 否则 textarea 的文字是透明的，正在输入的字看不见
const composing = ref(false)
// 只读高亮层、编辑 textarea 与行号槽共用同一份文本，保证两种状态逐行一致
const shownText = computed(() => (editing.value ? draft.value : sourceText.value))
const srcLines = computed<SrcLine[]>(() => (srcTooBig.value ? [] : buildSrcLines(shownText.value)))

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 行内轻量高亮：行内代码、粗体、斜体。
 * Markdown 标记本身保留（弱化为 .src-mark），只给内容加视觉权重，
 * 保证选中复制拿到的仍是原始源码而不是渲染后的文字。
 */
function inlineHtml(raw: string): string {
  const codes: string[] = []
  let s = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_m, body: string) => {
    codes.push(body)
    return `\u0000${codes.length - 1}\u0000`
  })
  s = s.replace(
    /\*\*([^*\n]+)\*\*/g,
    '<span class="src-mark">**</span><strong>$1</strong><span class="src-mark">**</span>'
  )
  s = s.replace(
    /(^|[^*\w])\*([^*\n]+)\*(?!\*)/g,
    '$1<span class="src-mark">*</span><em>$2</em><span class="src-mark">*</span>'
  )
  return s.replace(
    /\u0000(\d+)\u0000/g,
    (_m, i: string) =>
      '<span class="src-mark">`</span><code class="src-code">' +
      codes[Number(i)] +
      '</code><span class="src-mark">`</span>'
  )
}

/** 非围栏行：标题 / 分隔线 / 引用 / 列表各强调一层，其余行走行内高亮。 */
function lineHtml(raw: string): string {
  const h = raw.match(/^(\s{0,3})(#{1,6})(\s+)([\s\S]*)$/)
  if (h) {
    return `${h[1]}<span class="src-mark">${h[2]}${h[3]}</span><span class="src-h">${inlineHtml(h[4])}</span>`
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
    return `<span class="src-mark">${escapeHtml(raw)}</span>`
  }
  const q = raw.match(/^(\s*(?:>\s?)+)([\s\S]*)$/)
  if (q) {
    return `<span class="src-mark">${escapeHtml(q[1])}</span>${inlineHtml(q[2])}`
  }
  const li = raw.match(/^(\s*(?:[-*+]|\d{1,3}[.)])\s+)([\s\S]*)$/)
  if (li) {
    return `<span class="src-mark">${escapeHtml(li[1])}</span>${inlineHtml(li[2])}`
  }
  return inlineHtml(raw)
}

/** 逐行切分源码：标记围栏外的标题行（目录跳转用），并做轻量语法高亮。 */
function buildSrcLines(src: string): SrcLine[] {
  const lines = src.split(/\r?\n/)
  const out: SrcLine[] = []
  let fence = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const fm = raw.match(/^\s*(`{3,}|~{3,})/)
    if (fm) {
      const mark = fm[1][0]
      if (!fence) {
        fence = mark
        fenceLen = fm[1].length
      } else if (mark === fence && fm[1].length >= fenceLen) {
        fence = ''
        fenceLen = 0
      }
      out.push({ n: i + 1, heading: false, html: `<span class="src-mark">${escapeHtml(raw)}</span>` })
      continue
    }
    if (fence) {
      out.push({ n: i + 1, heading: false, html: escapeHtml(raw) })
      continue
    }
    out.push({ n: i + 1, heading: /^\s{0,3}#{1,6}(\s|$)/.test(raw), html: lineHtml(raw) })
  }
  return out
}

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

// 行号槽内容：整段生成，行数与当前正文（草稿或文件内容）一致
let gutterFor = -1
let gutterText = ''
const lineNoText = computed(() => {
  // 逐行渲染时直接用行数组长度，省一次整段 split
  const n = srcTooBig.value ? shownText.value.split('\n').length : srcLines.value.length
  if (n !== gutterFor) {
    const nums: string[] = []
    for (let i = 1; i <= n; i++) nums.push(String(i))
    gutterFor = n
    gutterText = nums.join('\n')
  }
  return gutterText
})

async function toggleEdit() {
  // 只读高亮层与编辑 textarea 叠在同一位置、同一排版，切换只交接滚动位置，
  // DOM 不重建、行高不变，因此不需要按比例换算
  cancelDraftTimer()
  const from = sourceScroller()
  const prevTop = from?.scrollTop ?? 0
  const prevLeft = from?.scrollLeft ?? 0

  editing.value = !editing.value
  composing.value = false
  if (editing.value) {
    draft.value = sourceText.value
  } else {
    draft.value = ''
    void renderDraft(sourceText.value) // 还原为文件内容
  }

  await nextTick()
  const now = sourceScroller()
  if (now) {
    now.scrollTop = Math.min(prevTop, Math.max(0, now.scrollHeight - now.clientHeight))
    now.scrollLeft = prevLeft
  }
  // 编辑态以 textarea 为滚动源，先同步底层高亮层再追平行号
  if (editing.value && editEl.value && srcScrollEl.value) {
    srcScrollEl.value.scrollTop = editEl.value.scrollTop
    srcScrollEl.value.scrollLeft = editEl.value.scrollLeft
  }
  syncGutter()
  if (isSplit.value && syncScroll.value) mirror(now, renderScrollEl.value)
}

function onDraftInput() {
  if (draftTimer) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => void renderDraft(draft.value), 300)
}

// v-model 在 compositionend 之后才把候选字写进草稿，因此结束时补一次预览重渲染
function onComposeStart() {
  composing.value = true
}
function onComposeEnd() {
  composing.value = false
  if (editing.value) onDraftInput()
}

// 切换文件：有未保存改动时先提示，再还原编辑态
watch(
  () => store.current?.path,
  async () => {
    cancelDraftTimer()
    composing.value = false
    if (editing.value && draft.value && draft.value !== sourceText.value) {
      toast(t('toast.discardedDraft'), 'error')
    }
    draft.value = editing.value ? sourceText.value : ''
    if (editing.value) void renderDraft(draft.value)
    // 换文件后正文高度变化，行号槽跟随最终的滚动位置
    await nextTick()
    syncGutter()
  }
)

// 行号槽开关来自设置对话框：重新挂载后追平正文滚动位置
watch(showLineNo, async () => {
  await nextTick()
  syncGutter()
})

/**
 * 当前源码侧的滚动元素：编辑时是覆盖层 textarea，否则是只读高亮层。
 * 高亮层在两种状态下都存在，只是编辑时由 textarea 驱动滚动。
 */
function sourceScroller(): HTMLElement | null {
  return editing.value ? editEl.value : srcScrollEl.value
}

/** 行号槽跟随当前滚动源：编辑时是 textarea，只读时是高亮层。 */
function syncGutter() {
  const sc = sourceScroller()
  const gu = gutterEl.value
  if (sc && gu) gu.scrollTop = sc.scrollTop
}

/** 按可滚动高度的比例镜像滚动位置。 */
let mirrorAt = 0
function mirror(from: HTMLElement | null, to: HTMLElement | null) {
  if (!from || !to || syncing) return
  const fMax = from.scrollHeight - from.clientHeight
  const tMax = to.scrollHeight - to.clientHeight
  if (fMax <= 0 || tMax <= 0) return
  syncing = true
  to.scrollTop = (from.scrollTop / fMax) * tMax
  mirrorAt = performance.now()
  requestAnimationFrame(() => (syncing = false))
}

// 镜像写入触发的对方 scroll 事件可能晚于 rAF 解锁，若不拦会被当作用户滚动再镜像回来，
// 与平滑滚动（目录跳转/回到开头结尾）形成回环，把每帧进度拉回原位
function justMirrored() {
  return performance.now() - mirrorAt < 80
}

// ---------- 滚动 / 补充渲染 ----------
let savedRatio = 0
let savedFor = ''
let lastRenderTop = 0
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

async function afterRender(redrawDiagram: boolean) {
  const art = articleEl.value
  if (!art) return
  if (!showRender.value) {
    pendingPost = true
    // 换文件了：之前记住的正文滚动位置作废
    if (savedFor !== (store.current?.path ?? '')) renderScrollTop = 0
    return
  }
  await postRender(art, redrawDiagram)

  const sc = renderScrollEl.value
  if (!sc) return
  if (redrawDiagram) return // 主题切换：保持滚动
  const path = store.current?.path ?? ''
  if (editing.value) {
    // 编辑草稿重渲染：保持视口位置不变，避免跟着内容跳
    sc.scrollTop = Math.min(lastRenderTop, Math.max(0, sc.scrollHeight - sc.clientHeight))
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
  if (justMirrored()) return
  const sc = renderScrollEl.value
  if (!sc) return
  lastRenderTop = sc.scrollTop
  savedRatio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0
  savedFor = store.current?.path ?? ''
  spyHeading(sc)
  if (isSplit.value && syncScroll.value) mirror(sc, sourceScroller())
}

function onSrcScroll(e: Event) {
  // 编辑态：textarea 是唯一的滚动源，高亮层只被动跟随；
  // 高亮层自身（程序同步触发）的 scroll 直接忽略，避免两边互相牵引
  if (editing.value) {
    if (e.target !== editEl.value) return
    if (editEl.value && srcScrollEl.value) {
      srcScrollEl.value.scrollTop = editEl.value.scrollTop
      srcScrollEl.value.scrollLeft = editEl.value.scrollLeft
    }
  }
  // 行号槽跟随正文滚动（无论是否分栏同步）
  syncGutter()
  if (!isSplit.value || !syncScroll.value || justMirrored()) return
  mirror(sourceScroller(), renderScrollEl.value)
}

watch(
  () => store.html,
  async () => {
    await nextTick()
    await afterRender(false)
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
    composing.value = false
    draft.value = ''
    await renderDraft(sourceText.value)
  }
  if (to === 'source') {
    if (from !== 'source') renderScrollTop = sc?.scrollTop ?? 0
    return
  }
  await nextTick()
  if (pendingPost) {
    pendingPost = false
    if (articleEl.value) await postRender(articleEl.value)
  }
  if (sc) {
    if (from === 'source') sc.scrollTop = renderScrollTop
    if (isSplit.value && syncScroll.value) mirror(sc, sourceScroller())
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

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
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
          <pre v-if="showLineNo" ref="gutterEl" class="src-gutter" aria-hidden="true">{{ lineNoText }}</pre>
          <div class="src-editor" :class="{ 'is-composing': composing }">
            <!-- 高亮层：只读时直接展示，编辑时作为 textarea 的底图，两种状态共用同一份 DOM 与排版 -->
            <div
              ref="srcScrollEl"
              class="viewer-scroll src-scroll"
              :class="{ __code_wrapped: store.settings?.codeWrap, 'is-editing': editing }"
              data-testid="src-scroll"
              @scroll="onSrcScroll"
            >
              <div v-if="srcTooBig" class="source-body" data-testid="source-body">{{ shownText }}</div>
              <div v-else class="source-body src-lines" data-testid="source-body">
                <div
                  v-for="l in srcLines"
                  :key="l.n"
                  v-memo="[l.html]"
                  class="src-line"
                  :class="{ 'src-heading': l.heading }"
                  v-html="l.html"
                ></div>
              </div>
            </div>
            <!-- 编辑层：文字透明，只负责光标/输入/选择，视觉全部来自底层高亮 -->
            <textarea
              v-if="editing"
              ref="editEl"
              v-model="draft"
              class="src-edit"
              :class="{ __code_wrapped: store.settings?.codeWrap }"
              :wrap="store.settings?.codeWrap ? 'soft' : 'off'"
              spellcheck="false"
              :placeholder="t('src.placeholder')"
              data-testid="src-textarea"
              @input="onDraftInput"
              @compositionstart="onComposeStart"
              @compositionend="onComposeEnd"
              @scroll="onSrcScroll"
            ></textarea>
          </div>
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
