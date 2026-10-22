<script setup lang="ts">
import { inject, ref } from 'vue'
import { store, openEntry, toggleFavorite } from '../store'
import { showMenu } from './ContextMenu.vue'
import { getApi } from '../api'
import type { MNode } from '../types'

/**
 * 文件树递归节点：目录可无限层级展开（替代旧版写死 3 层的模板）。
 * 展开状态由父级 FilesPanel 统一持有，便于“当前文件”自动展开祖先链。
 */
const props = defineProps<{ node: MNode }>()

const expand = inject<{ isExpanded: (p: string) => boolean; toggle: (p: string) => void }>('treeExpand')!

const isOpen = () => expand.isExpanded(props.node.path)

async function menu(e: MouseEvent, node: MNode) {
  const api = await getApi()
  const fav = store.favorites.some((f) => f.path === node.path)
  const items = [
    ...(!node.isDir && !supported(node) ? [] : [{ label: '打开', action: () => openEntry(node.path, { keepTree: true }) }]),
    { label: fav ? '取消收藏' : '收藏', action: () => toggleFavorite(node.path) },
    {
      label: '复制文件路径',
      action: async () => {
        await api.CopyText(node.path)
        const { toast } = await import('../store')
        toast('已复制路径')
      }
    }
  ]
  if (!node.isDir) items.push({ label: '打开所在文件夹', action: () => api.RevealInShell(node.path) })
  showMenu(e.clientX, e.clientY, items)
}

/** 是否支持预览（目录恒为 true；旧数据无 supported 字段时按可预览处理） */
function supported(node: MNode): boolean {
  return node.isDir || node.supported !== false
}
</script>

<template>
  <li>
    <!-- 目录 -->
    <a v-if="node.isDir" class="tree-row dir" :title="node.path" @click="expand.toggle(node.path)">
      <svg class="chev" :class="{ open: isOpen() }" viewBox="0 0 16 16" width="12" height="12"><path d="M5.5 4 10 8l-4.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      <svg class="ficon" viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 3.5h4l1.5 2h7.5v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9Z" fill="currentColor" opacity=".8"/></svg>
      <span class="tree-name">{{ node.name }}</span>
    </a>
    <!-- 文件 -->
    <a
      v-else
      class="tree-row file"
      :class="{ current: store.current?.path === node.path, unsupported: !supported(node) }"
      :title="node.path"
      @click="supported(node) && openEntry(node.path, { keepTree: true })"
      @contextmenu.prevent="menu($event, node)"
    >
      <svg class="ficon" viewBox="0 0 16 16" width="14" height="14"><path d="M4 1.5h5L12.5 5v9.5h-8.5Z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 8.5h5M5.5 11h3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      <span class="tree-name">{{ node.name }}</span>
      <span v-if="!supported(node)" class="no-preview">无法预览</span>
      <span v-else-if="store.current?.path === node.path" class="cur-badge">当前</span>
    </a>

    <ul v-if="node.isDir && isOpen()" class="tree-sub">
      <TreeItem v-for="c in node.children ?? []" :key="c.path" :node="c" />
    </ul>
  </li>
</template>
