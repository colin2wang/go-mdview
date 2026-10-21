<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store, setTheme, exportHtml, openEntry, openFolder, openWikiLink, toast, toggleSource } from '../store'
import { showMenu, hideMenu } from './ContextMenu.vue'
import { getApi } from '../api'
import { renderMermaidIn, renderMathIn } from '../markdown'

const articleEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)

// ---------- 源码视图 ----------
const sourceText = computed(() => store.current?.content ?? '')
const sourcePath = computed(() => store.current?.path ?? '')
const sourceMeta = computed(() => {
  const c = store.current
  if (!c) return ''
  const lines = c.content ? c.content.split('\n').length : 0
  return `${lines} 行 · ${c.encoding} · ${(c.size / 1024).toFixed(1)} KB`
})

async function copySource() {
  const api = await getApi()
  await api.CopyText(sourceText.value)
  toast('源码已复制')
}

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

// 滚动记忆（模块级，不进 store）
let savedRatio = 0
let savedFor = ''
// 跨文件锚点：点击 md 内链带 #anchor 时，渲染完成后再跳
let pendingAnchor = ''

function scrollToAnchor(anchor: string) {
  const art = articleEl.value
  const sc = scrollEl.value
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
    // mermaid 跟随主题重绘，滚动位置不动
    if (articleEl.value?.querySelector('[data-mermaid]')) await afterRender(true)
  }
)
// 渲染 ⇄ 源码切换：两个视图共用滚动容器，各自记住自己的位置
watch(
  () => store.showSource,
  async (toSource) => {
    const sc = scrollEl.value
    const art = articleEl.value
    if (toSource) {
      renderScrollTop = sc?.scrollTop ?? 0
      if (sc) sc.scrollTop = 0
      return
    }
    await nextTick()
    if (art && pendingPost) {
      pendingPost = false
      await postRender(art)
    }
    if (sc) sc.scrollTop = renderScrollTop
  }
)

// 源码视图期间正文被隐藏（mermaid/katex 在无尺寸容器里画不出来），
// 先记账，等切回渲染视图再补做
let pendingPost = false
// 切到源码前记住正文滚动位置，切回来还原
let renderScrollTop = 0

/** 正文挂载后的补充渲染：Mermaid 图 + 数学公式。force 用于主题切换后的重绘。 */
async function postRender(art: HTMLElement, force = false) {
  if (store.hasMermaid) await renderMermaidIn(art, store.settings?.theme === 'dark', force)
  if (store.hasMath) await renderMathIn(art)
}

async function afterRender(redrawMermaid: boolean) {
  const art = articleEl.value
  if (!art) return
  if (store.showSource) {
    pendingPost = true
    // 换文件了：之前记住的正文滚动位置作废
    if (savedFor !== (store.current?.path ?? '')) renderScrollTop = 0
    return
  }
  await postRender(art, redrawMermaid)

  const sc = scrollEl.value
  if (!sc) return
  if (redrawMermaid) return // 主题切换：保持滚动
  const path = store.current?.path ?? ''
  if (savedFor === path) {
    sc.scrollTop = savedRatio * sc.scrollHeight
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

function onScroll() {
  const sc = scrollEl.value
  if (!sc) return
  // 源码视图不参与正文的滚动记忆与大纲高亮
  if (store.showSource) return
  savedRatio = sc.scrollHeight > sc.clientHeight ? sc.scrollTop / sc.scrollHeight : 0
  savedFor = store.current?.path ?? ''
  spyHeading(sc)
}

function spyHeading(sc: HTMLElement) {
  const heads = Array.from(articleEl.value?.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]') ?? [])
  let active = ''
  for (const h of heads) {
    if ((h as HTMLElement).offsetTop <= sc.scrollTop + 80) active = h.id
    else break
  }
  store.activeHeading = active
}

async function onArtClick(e: MouseEvent) {
  const t = e.target as HTMLElement
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
  // 代码复制
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
      { label: '复制文件路径', action: () => api.CopyText(store.current!.path) },
      { label: '打开所在文件夹', action: () => api.RevealInShell(store.current!.path) },
      { label: '导出 HTML', action: () => exportHtml() }
    )
  }
  showMenu(e.clientX, e.clientY, items)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && !store.settingsOpen) hideMenu()
}
</script>

<template>
  <main class="viewer" data-testid="viewer">
    <!-- 空状态：未打开任何文件 -->
    <div v-if="!store.current" class="viewer-empty">
      <p class="empty-title">mdview</p>
      <p class="empty-sub">把 .md 文件拖进窗口，或</p>
      <div class="empty-actions">
        <button class="empty-btn" @click="openFileByDialog">打开文件…</button>
        <button class="empty-btn" @click="openFolder">打开目录…</button>
      </div>
    </div>
    <div
      v-else
      ref="scrollEl"
      class="viewer-scroll"
      :class="{ '__code_wrapped': store.settings?.codeWrap }"
      data-testid="viewer-scroll"
      @scroll="onScroll"
      @contextmenu.prevent="onContext"
    >
      <!-- 渲染正文：用 v-show 保持 DOM，切换源码回来时 mermaid/滚动不丢 -->
      <article
        v-show="!store.showSource"
        ref="articleEl"
        class="md-article"
        data-testid="article"
        v-html="store.html"
        @click="onArtClick"
      ></article>

      <!-- 源码视图：md 原始文本 -->
      <div v-show="store.showSource" class="source-view" data-testid="source-view">
        <div class="source-bar">
          <span class="src-tag">源码</span>
          <span class="src-path" :title="sourcePath">{{ sourcePath }}</span>
          <span class="src-meta">{{ sourceMeta }}</span>
          <button class="src-btn" title="复制全文" data-testid="src-copy" @click="copySource">复制全文</button>
          <button class="src-btn" title="返回渲染视图" data-testid="src-back" @click="toggleSource">返回渲染</button>
        </div>
        <pre class="source-body" data-testid="source-body">{{ sourceText }}</pre>
      </div>
    </div>
  </main>
</template>
