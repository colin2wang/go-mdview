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
import type { ViewMode } from '../types'
import AppIcon from './AppIcon.vue'
import ImageLightbox from './ImageLightbox.vue'

const articleEl = ref<HTMLElement | null>(null)
const renderScrollEl = ref<HTMLElement | null>(null)
const srcScrollEl = ref<HTMLElement | null>(null)
const splitWrapEl = ref<HTMLElement | null>(null)
const editEl = ref<HTMLTextAreaElement | null>(null)

const mode = computed<ViewMode>(() => store.viewMode)
const showRender = computed(() => mode.value !== 'source')
const showSource = computed(() => mode.value !== 'render')
const isSplit = computed(() => mode.value === 'split')

// ---------- 源码面板 ----------
// 超大文件不做逐行 DOM，直接整段 <pre>，避免上万行把界面拖卡
const SRC_MAX_LINES = 6000
const SRC_MAX_CHARS = 400000

interface SrcLine {
  n: number
  html: string
}

const sourceText = computed(() => store.current?.content ?? '')
const sourcePath = computed(() => store.current?.path ?? '')
const sourceMeta = computed(() => {
  const c = store.current
  if (!c) return ''
  const lines = c.content ? c.content.split('\n').length : 0
  return `${lines} 行 · ${c.encoding} · ${(c.size / 1024).toFixed(1)} KB`
})
const srcTooBig = computed(() => {
  const c = store.current
  if (!c) return false
  return c.size > SRC_MAX_CHARS || c.content.split('\n').length > SRC_MAX_LINES
})
const srcLines = computed<SrcLine[]>(() => (srcTooBig.value ? [] : buildSrcLines(sourceText.value)))

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 逐行轻量着色：围栏/标题/引用/列表/表格/行内标记，够看清结构即可。 */
function inlineMarks(t: string): string {
  return t
    .replace(/`[^`]+`/g, (m) => `<span class="s-inline">${m}</span>`)
    .replace(/\*\*[^*\n]+\*\*/g, (m) => `<span class="s-strong">${m}</span>`)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, (m) => `<span class="s-link">${m}</span>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_m, p: string, u: string) => `${p}<span class="s-url">${u}</span>`)
}

function buildSrcLines(src: string): SrcLine[] {
  const lines = src.split(/\r?\n/)
  const out: SrcLine[] = []
  let fence = ''
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const n = i + 1
    const t = esc(raw)
    const fm = raw.match(/^\s*(```+|~~~+)/)
    if (fm) {
      const mark = fm[1][0]
      if (!fence) fence = mark
      else if (raw.trimStart().startsWith(fence)) fence = ''
      out.push({ n, html: `<span class="s-fence">${t}</span>` })
      continue
    }
    if (fence) {
      out.push({ n, html: `<span class="s-code">${t}</span>` })
      continue
    }
    if (/^\s{0,3}#{1,6}(\s|$)/.test(raw)) {
      out.push({ n, html: `<span class="s-head">${t}</span>` })
      continue
    }
    if (/^\s*>/.test(raw)) {
      out.push({ n, html: `<span class="s-quote">${t}</span>` })
      continue
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      out.push({ n, html: `<span class="s-hr">${t}</span>` })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      out.push({ n, html: `<span class="s-table">${inlineMarks(t)}</span>` })
      continue
    }
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(raw)) {
      out.push({ n, html: `<span class="s-list">${inlineMarks(t)}</span>` })
      continue
    }
    out.push({ n, html: inlineMarks(t) })
  }
  return out
}

async function copySource() {
  const api = await getApi()
  await api.CopyText(sourceText.value)
  toast('源码已复制')
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
// 只改内存里的渲染结果，不写回文件；关闭编辑或切换文件即还原为文件内容
const editing = ref(false)
const draft = ref('')
let draftTimer: number | undefined

async function toggleEdit() {
  // 切换会换掉源码区的 DOM（列表 ⇄ textarea），先把滚动比例记下来
  const prev = srcScroller()
  const ratio = prev && prev.scrollHeight > prev.clientHeight
    ? prev.scrollTop / (prev.scrollHeight - prev.clientHeight)
    : 0

  editing.value = !editing.value
  if (editing.value) {
    draft.value = sourceText.value
  } else {
    draft.value = ''
    void renderDraft(sourceText.value) // 还原为文件内容
  }

  await nextTick()
  const now = srcScroller()
  if (now) now.scrollTop = ratio * Math.max(0, now.scrollHeight - now.clientHeight)
  if (isSplit.value && syncScroll.value) mirror(now, renderScrollEl.value)
}

function onDraftInput() {
  if (draftTimer) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => void renderDraft(draft.value), 300)
}

// 切换文件：有未保存改动时先提示，再还原编辑态
watch(
  () => store.current?.path,
  () => {
    if (draftTimer) window.clearTimeout(draftTimer)
    if (editing.value && draft.value && draft.value !== sourceText.value) {
      toast('已切换文件，未保存的修改已丢弃', 'error')
    }
    draft.value = editing.value ? sourceText.value : ''
    if (editing.value) void renderDraft(draft.value)
  }
)

/**
 * 当前源码侧的滚动元素：编辑时是 textarea，否则是带行号的源码容器。
 * 编辑态下 srcScrollEl 会被 v-if 卸载而为 null，同步滚动必须改取 textarea，
 * 否则对照模式的同步会静默失效。
 */
function srcScroller(): HTMLElement | null {
  return editing.value ? editEl.value : srcScrollEl.value
}

/** 按可滚动高度的比例镜像滚动位置。 */
function mirror(from: HTMLElement | null, to: HTMLElement | null) {
  if (!from || !to || syncing) return
  const fMax = from.scrollHeight - from.clientHeight
  const tMax = to.scrollHeight - to.clientHeight
  if (fMax <= 0 || tMax <= 0) return
  syncing = true
  to.scrollTop = (from.scrollTop / fMax) * tMax
  requestAnimationFrame(() => (syncing = false))
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
  const sc = renderScrollEl.value
  if (!sc) return
  lastRenderTop = sc.scrollTop
  savedRatio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / (sc.scrollHeight - sc.clientHeight) : 0
  savedFor = store.current?.path ?? ''
  spyHeading(sc)
  if (isSplit.value && syncScroll.value) mirror(sc, srcScroller())
}

function onSrcScroll() {
  if (!isSplit.value || !syncScroll.value) return
  mirror(srcScroller(), renderScrollEl.value)
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
    editing.value = false
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
    if (isSplit.value && syncScroll.value) mirror(sc, srcScroller())
  }
})

// 空状态按钮：弹文件选择框打开 md
async function openFileByDialog() {
  try {
    const api = await getApi()
    const p = await api.OpenFileDialog()
    if (p) await openEntry(p)
  } catch (e) {
    toast(`打开文件失败：${String(e)}`, 'error')
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
  const t = e.target as HTMLElement
  const holder = t.closest('.md-diagram')
  if (holder) {
    const svgEl = holder.querySelector('.md-diagram-src svg')
    if (svgEl) {
      openLightboxSvg(svgEl.outerHTML)
      return
    }
  }
  const img = t.closest('img')
  const src = img?.getAttribute('src')
  if (src) openLightboxUrl(src)
}

async function onArtClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  // 图形卡片「源码」：在渲染结果与源码之间切换
  const tgl = t.closest('button[data-toggle-src]') as HTMLElement | null
  if (tgl) {
    const card = tgl.closest('.md-diagram')
    card?.classList.toggle('show-src')
    return
  }
  // md 内链（渲染器产出 data-mdlink）
  const mdl = t.closest('a[data-mdlink]') as HTMLElement | null
  if (mdl) {
    e.preventDefault()
    pendingAnchor = (mdl.getAttribute('data-anchor') ?? '').replace(/^#/, '')
    openEntry(mdl.getAttribute('data-mdlink') ?? '')
    return
  }
  // wikilink
  const wiki = t.closest('a[data-wiki]') as HTMLElement | null
  if (wiki) {
    e.preventDefault()
    await openWikiLink(wiki.getAttribute('data-wiki') ?? '')
    return
  }
  // 代码/源码复制
  const btn = t.closest('button[data-copy]') as HTMLButtonElement | null
  if (btn) {
    const api = await getApi()
    await api.CopyText(decodeURIComponent(btn.getAttribute('data-copy') ?? ''))
    toast('代码已复制')
    btn.classList.add('done')
    setTimeout(() => btn.classList.remove('done'), 1200)
  }
}

async function onContext(e: MouseEvent) {
  const api = await getApi()
  const items: { label: string; action: () => void }[] = [
    {
      label: store.settings?.theme === 'dark' ? '浅色主题' : '深色主题',
      action: () => setTheme(store.settings?.theme === 'dark' ? 'light' : 'dark')
    }
  ]
  if (store.current) {
    items.push(
      {
        label: mode.value === 'split' ? '退出对照视图' : '源码 ⇄ 渲染对照',
        action: () => setViewMode(mode.value === 'split' ? 'render' : 'split')
      },
      { label: '复制文件路径', action: () => api.CopyText(store.current!.path) },
      { label: '打开所在文件夹', action: () => api.RevealInShell(store.current!.path) },
      { label: '导出 HTML', action: () => exportHtml() }
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
      <p class="empty-sub">把 .md 文件拖进窗口，或</p>
      <div class="empty-actions">
        <button class="empty-btn primary" @click="openFileByDialog">打开文件…</button>
        <button class="empty-btn" @click="openFolder">打开目录…</button>
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
          <span class="pane-tag src">{{ isSplit ? '源码' : 'Markdown 源码' }}</span>
          <span class="src-path" :title="sourcePath">{{ sourcePath }}</span>
          <span class="src-meta">{{ sourceMeta }}</span>
          <button
            v-if="isSplit"
            class="src-btn"
            :class="{ on: syncScroll }"
            title="同步两侧滚动"
            @click="syncScroll = !syncScroll"
          >
            同步滚动
          </button>
          <button
            class="src-btn"
            :class="{ on: editing }"
            :title="editing ? '退出编辑，还原为文件内容' : '编辑源码（仅预览，不写回文件）'"
            data-testid="src-edit"
            @click="toggleEdit"
          >
            编辑
          </button>
          <button
            class="src-btn primary"
            :disabled="!editing"
            title="保存回原文件（需先开启编辑）"
            data-testid="src-save"
            @click="saveSource(draft)"
          >
            保存
          </button>
          <button class="src-btn" title="复制全文" data-testid="src-copy" @click="copySource">复制</button>
          <button
            v-if="!isSplit"
            class="src-btn"
            title="返回渲染视图"
            data-testid="src-back"
            @click="setViewMode('render')"
          >
            返回渲染
          </button>
        </header>
        <textarea
          v-if="editing"
          ref="editEl"
          v-model="draft"
          class="src-edit"
          :class="{ __code_wrapped: store.settings?.codeWrap }"
          spellcheck="false"
          placeholder="在这里编辑 Markdown，右侧实时预览（仅预览，不写回文件）"
          data-testid="src-textarea"
          @input="onDraftInput"
          @scroll="onSrcScroll"
        ></textarea>
        <div
          v-else
          ref="srcScrollEl"
          class="viewer-scroll src-scroll"
          :class="{ __code_wrapped: store.settings?.codeWrap }"
          data-testid="src-scroll"
          @scroll="onSrcScroll"
        >
          <div v-if="srcTooBig" class="source-body" data-testid="source-body">{{ sourceText }}</div>
          <div v-else class="source-body src-lines" data-testid="source-body">
            <div v-for="l in srcLines" :key="l.n" class="src-line">
              <span class="src-ln">{{ l.n }}</span>
              <span class="src-lt" v-html="l.html"></span>
            </div>
          </div>
        </div>
      </section>

      <!-- 分栏拖拽条 -->
      <div
        v-if="isSplit"
        class="split-bar"
        :class="{ dragging }"
        title="拖动调整比例，双击等分"
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
          <span class="pane-tag">渲染结果</span>
          <span v-if="editing" class="pane-live">● 实时预览</span>
          <span class="pane-grow"></span>
        </header>
        <div
          ref="renderScrollEl"
          class="viewer-scroll"
          :class="{ __code_wrapped: store.settings?.codeWrap }"
          data-testid="viewer-scroll"
          @scroll="onRenderScroll"
          @contextmenu.prevent="onContext"
          @dblclick="onArtDblClick"
        >
          <!-- 图片文件预览 -->
          <div v-if="store.currentKind === 'image'" class="img-view" data-testid="img-view">
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
