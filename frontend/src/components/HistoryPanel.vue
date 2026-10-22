<script setup lang="ts">
import { computed, ref } from 'vue'
import { store, openEntry, clearHistory, toggleFavorite } from '../store'
import { showMenu } from './ContextMenu.vue'
import { getApi } from '../api'
import { t } from '../i18n'

const q = ref('')
const list = computed(() => {
  const kw = q.value.trim().toLowerCase()
  const arr = store.history
  return kw ? arr.filter((e) => e.name.toLowerCase().includes(kw) || e.dir.toLowerCase().includes(kw)) : arr
})

function relTime(ts: number): string {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000 - ts)
  if (diff < 60) return t('time.now')
  if (diff < 3600) return t('time.minAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('time.hourAgo', { n: Math.floor(diff / 3600) })
  if (diff < 7 * 86400) return t('time.dayAgo', { n: Math.floor(diff / 86400) })
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

async function menu(e: MouseEvent, path: string) {
  const api = await getApi()
  const fav = store.favorites.some((f) => f.path === path)
  showMenu(e.clientX, e.clientY, [
    { label: t('menu.open'), action: () => openEntry(path) },
    { label: fav ? t('menu.unfav') : t('menu.fav'), action: () => toggleFavorite(path) },
    { label: t('menu.copyPath'), action: () => copyPath(path) },
    { label: t('menu.reveal'), action: () => api.RevealInShell(path) }
  ])
}

async function toastCopy() {
  const { toast } = await import('../store')
  toast(t('toast.copiedPath'))
}
function copyPath(path: string) {
  getApi().then((api) => api.CopyText(path)).then(() => toastCopy())
}
</script>

<template>
  <div class="panel" data-testid="history-panel">
    <div class="panel-head">
      <span class="panel-title">{{ t('hist.title') }}</span>
      <button class="link-btn" data-testid="history-clear" @click="clearHistory">{{ t('hist.clear') }}</button>
    </div>
    <input
      v-if="store.history.length"
      v-model="q"
      class="search-input"
      type="search"
      :placeholder="t('hist.search')"
      data-testid="history-search"
    />
    <p v-if="!list.length" class="panel-empty">{{ q.trim() ? t('hist.noMatch') : t('hist.empty') }}</p>
    <ul v-else class="entry-list">
      <li v-for="e in list" :key="e.path">
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
            <span class="entry-time">{{ relTime(e.openedAt) }}</span>
          </span>
        </a>
      </li>
    </ul>
  </div>
</template>
