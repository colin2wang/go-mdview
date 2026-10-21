<script setup lang="ts">
import { store, openEntry, toggleFavorite } from '../store'
import { showMenu } from './ContextMenu.vue'
import { getApi } from '../api'

async function menu(e: MouseEvent, path: string) {
  const api = await getApi()
  const fav = store.favorites.some((f) => f.path === path)
  showMenu(e.clientX, e.clientY, [
    { label: '打开', action: () => openEntry(path) },
    { label: fav ? '取消收藏' : '收藏', action: () => toggleFavorite(path) },
    {
      label: '复制文件路径',
      action: async () => {
        await api.CopyText(path)
        const { toast } = await import('../store')
        toast('已复制路径')
      }
    },
    { label: '打开所在文件夹', action: () => api.RevealInShell(path) }
  ])
}
</script>

<template>
  <div class="panel" data-testid="fav-panel">
    <div class="panel-head">
      <span class="panel-title">收藏</span>
    </div>
    <p v-if="!store.favorites.length" class="panel-empty">
      在文件上右键即可收藏<br /><span class="panel-empty-sub">收藏的文档会保存在这里</span>
    </p>
    <ul v-else class="entry-list">
      <li v-for="e in store.favorites" :key="e.path">
        <a
          class="entry"
          :class="{ dead: !e.exists, current: store.current?.path === e.path }"
          :title="e.path"
          @click="openEntry(e.path)"
          @contextmenu.prevent="menu($event, e.path)"
        >
          <span class="entry-name">{{ e.name }}</span>
          <span class="entry-sub">
            <span class="entry-dir">{{ e.dir }}</span>
            <button class="star-btn on" title="取消收藏" @click.stop="toggleFavorite(e.path)">★</button>
          </span>
        </a>
      </li>
    </ul>
  </div>
</template>
