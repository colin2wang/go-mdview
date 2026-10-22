<script setup lang="ts">
import { store, openEntry, toggleFavorite } from '../store'
import { showMenu } from './ContextMenu.vue'
import { getApi } from '../api'
import { t } from '../i18n'

async function menu(e: MouseEvent, path: string) {
  const api = await getApi()
  const fav = store.favorites.some((f) => f.path === path)
  showMenu(e.clientX, e.clientY, [
    { label: t('menu.open'), action: () => openEntry(path) },
    { label: fav ? t('menu.unfav') : t('menu.fav'), action: () => toggleFavorite(path) },
    {
      label: t('menu.copyPath'),
      action: async () => {
        await api.CopyText(path)
        const { toast } = await import('../store')
        toast(t('toast.copiedPath'))
      }
    },
    { label: t('menu.reveal'), action: () => api.RevealInShell(path) }
  ])
}
</script>

<template>
  <div class="panel" data-testid="fav-panel">
    <div class="panel-head">
      <span class="panel-title">{{ t('fav.title') }}</span>
    </div>
    <p v-if="!store.favorites.length" class="panel-empty">
      {{ t('fav.empty') }}<br /><span class="panel-empty-sub">{{ t('fav.emptySub') }}</span>
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
            <button class="star-btn on" :title="t('fav.unstar')" @click.stop="toggleFavorite(e.path)">★</button>
          </span>
        </a>
      </li>
    </ul>
  </div>
</template>
