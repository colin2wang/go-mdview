<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import { store } from '../store'
import TocNode from './TocNode.vue'
import { t } from '../i18n'
import type { TocEntry } from '../types'

const items = computed(() => store.toc)
const minDepth = computed(() => items.value.reduce((m, x) => Math.min(m, x.depth), 6))

// 扁平标题序列 → 嵌套树；层级按最深一级归一（比如文档只有 ###，它就是顶层）
const tree = computed<TocEntry[]>(() => {
  const min = minDepth.value
  const root: TocEntry[] = []
  const stack: TocEntry[] = []
  for (const it of items.value) {
    const node: TocEntry = { ...it, children: [] }
    const level = Math.max(0, it.depth - min)
    while (stack.length > level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else root.push(node)
    stack[level] = node
  }
  return root
})

const RENDER_SEL = '[data-testid="viewer-scroll"]'
const SRC_SEL = '[data-testid="src-scroll"]'

function scroller(sel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(sel)
}

/** 把元素滚到面板视口顶部（带 scroll-margin 留白）。 */
function scrollHeadingInto(sc: HTMLElement | null, el: HTMLElement | null) {
  if (!sc || !el) return
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
  sc.scrollTo({ top: sc.scrollTop + top - 8, behavior: 'smooth' })
}

/** 同上的瞬时版本：对照模式下避免源码侧平滑滚动与同步镜像互相拉扯。 */
function scrollHeadingInstant(sc: HTMLElement | null, el: HTMLElement | null) {
  if (!sc || !el) return
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top
  sc.scrollTop = sc.scrollTop + top - 8
}

/** 只读源码里的标题行（.src-heading 标记），按文档顺序排列。 */
function srcHeadingEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.src-lines .src-heading'))
}

/** 源码行未渲染（超大文件）时的兜底：按目录序号等比定位。 */
function proportionalSrcJump(ordinal: number) {
  const sc = scroller(SRC_SEL)
  if (!sc) return
  const n = items.value.length
  if (n < 2) return
  const max = sc.scrollHeight - sc.clientHeight
  if (max <= 0) return
  sc.scrollTo({ top: (ordinal / (n - 1)) * max, behavior: 'smooth' })
}

function jump(id: string) {
  const mode = store.viewMode
  const ordinal = items.value.findIndex((x) => x.id === id)
  const heads = srcHeadingEls()
  // 标题行数与目录不一致（引用内标题、setext 等）时放弃精确跳转，退回比例定位
  const lineEl = ordinal >= 0 && heads.length === items.value.length ? heads[ordinal] ?? null : null

  // 源码模式：渲染面板隐藏，跳源码面板对应标题行
  if (mode === 'source') {
    if (lineEl) scrollHeadingInto(scroller(SRC_SEL), lineEl)
    else proportionalSrcJump(ordinal)
    return
  }
  // 渲染/对照：跳渲染面板；对照时源码侧同步定位（同步滚动开着会被镜像接管，关着则精确定位到行）
  const el = document.getElementById(id)
  scrollHeadingInto(scroller(RENDER_SEL), el)
  if (mode === 'split') {
    if (lineEl) scrollHeadingInstant(scroller(SRC_SEL), lineEl)
    else proportionalSrcJump(ordinal)
  }
}

function toEdge(top: boolean) {
  const mode = store.viewMode
  const sels = mode === 'source' ? [SRC_SEL] : mode === 'split' ? [RENDER_SEL, SRC_SEL] : [RENDER_SEL]
  for (const sel of sels) {
    const sc = scroller(sel)
    sc?.scrollTo({ top: top ? 0 : sc.scrollHeight, behavior: 'smooth' })
  }
}

// 当前章节高亮变化时，让 TOC 列表把活动项滚入可视区（切文件/长文档翻阅均生效）
watch(
  () => store.activeHeading,
  async () => {
    await nextTick()
    document
      .querySelector('.toc-list .toc-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  }
)
</script>

<template>
  <div class="panel toc-panel" data-testid="toc-panel">
    <template v-if="items.length">
      <button class="toc-endpoint" data-testid="toc-top" :title="t('toc.top.tip')" @click="toEdge(true)">
        <span class="toc-endpoint-ico">⤒</span>{{ t('toc.top') }}
      </button>
      <ul class="toc-list">
        <TocNode
          v-for="it in tree"
          :key="it.id"
          :item="it"
          :active-id="store.activeHeading"
          @jump="jump"
        />
      </ul>
      <button class="toc-endpoint" data-testid="toc-bottom" :title="t('toc.bottom.tip')" @click="toEdge(false)">
        <span class="toc-endpoint-ico">⤓</span>{{ t('toc.bottom') }}
      </button>
    </template>
    <p v-else class="panel-empty">{{ t('toc.empty') }}</p>
  </div>
</template>
