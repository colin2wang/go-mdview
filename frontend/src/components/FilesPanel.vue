<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue'
import { store, openFolder, refreshTree, countMd } from '../store'
import { t } from '../i18n'
import type { MNode } from '../types'
import TreeItem from './TreeItem.vue'

const expanded = ref<Set<string>>(new Set())

const rootPath = computed(() => store.settings?.lastFolder ?? '')

function isExpanded(p: string): boolean {
  return expanded.value.has(p)
}
function toggle(p: string) {
  const s = new Set(expanded.value)
  if (s.has(p)) s.delete(p)
  else s.add(p)
  expanded.value = s
}
function collapseAll() {
  expanded.value = new Set()
}
function sepOf(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/'
}
function ancestorsOf(p: string): string[] {
  const sep = sepOf(p)
  const parts = p.split(/[\\/]/)
  const out: string[] = []
  let acc = ''
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? acc + sep + parts[i] : parts[i]
    out.push(acc)
  }
  return out
}

// 递归子组件通过 inject 共享展开状态
provide('treeExpand', { isExpanded, toggle })

watch(
  () => store.current?.path,
  (p) => {
    if (!p) return
    const s = new Set(expanded.value)
    let changed = false
    for (const a of ancestorsOf(p)) {
      if (!s.has(a)) {
        s.add(a)
        changed = true
      }
    }
    if (changed) expanded.value = s
  }
)

function countAll(nodes: MNode[]): number {
  let n = 0
  for (const x of nodes) n += x.isDir ? countAll(x.children ?? []) : 1
  return n
}
</script>

<template>
  <div class="panel files-panel" data-testid="files-panel">
    <div class="panel-head">
      <span class="panel-title" :title="rootPath || t('files.none')">{{ rootPath ? rootPath.split(/[\\/]/).pop() : t('files.none') }}</span>
      <span class="panel-tools">
        <button class="icon-btn" :title="t('files.openFolder')" data-testid="files-open-folder" @click="openFolder">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9Zm1 3v6h11v-5H6.4L4.9 5.5H2.5Z" fill="currentColor" opacity=".85"/></svg>
        </button>
        <button class="icon-btn" :title="t('files.refresh')" data-testid="files-refresh" @click="refreshTree">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
        <button class="icon-btn" :title="t('files.collapse')" data-testid="files-collapse" @click="collapseAll">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 6.5 8 10l4-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </span>
    </div>

    <p v-if="!store.tree.length" class="panel-empty">
      {{ t('files.pickFolder') }}<br />
      <button class="link-btn" @click="openFolder">{{ t('empty.openFolder') }}</button>
    </p>

    <ul v-else class="tree" data-testid="file-tree">
      <TreeItem v-for="node in store.tree" :key="node.path" :node="node" />
    </ul>

    <div class="panel-foot" v-if="store.tree.length">{{ t('files.previewCount', { n: countMd(store.tree), m: countAll(store.tree) }) }}</div>
  </div>
</template>
