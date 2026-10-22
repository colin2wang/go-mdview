<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store, patchSettings } from '../store'
import { t } from '../i18n'
import TocPanel from './TocPanel.vue'
import HistoryPanel from './HistoryPanel.vue'
import FavPanel from './FavPanel.vue'
import FilesPanel from './FilesPanel.vue'

const tabs = computed<{ key: 'toc' | 'history' | 'fav' | 'files'; label: string }[]>(() => [
  { key: 'toc', label: t('tab.toc') },
  { key: 'history', label: t('tab.history') },
  { key: 'fav', label: t('tab.fav') },
  { key: 'files', label: t('tab.files') }
])

const dragging = ref(false)
let startX = 0
let startW = 280
// 拖动过程中只改 CSS 变量，松手才落盘，避免每像素写一次 settings.json
const liveWidth = ref(store.settings?.sidebarWidth ?? 280)

function applyWidth(w: number) {
  liveWidth.value = w
  document.documentElement.style.setProperty('--sb-width', w + 'px')
}

function onDown(e: MouseEvent) {
  dragging.value = true
  startX = e.clientX
  startW = store.settings?.sidebarWidth ?? 280
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  e.preventDefault()
}
function onMove(e: MouseEvent) {
  applyWidth(Math.min(520, Math.max(200, startW + e.clientX - startX)))
}
function onUp() {
  dragging.value = false
  document.removeEventListener('mousemove', onMove)
  document.removeEventListener('mouseup', onUp)
  patchSettings({ sidebarWidth: Math.round(liveWidth.value) })
}

watch(
  () => store.settings?.sidebarWidth,
  (w) => applyWidth(w ?? 280),
  { immediate: true }
)
</script>

<template>
  <aside class="sidebar" :class="{ dragging }" data-testid="sidebar">
    <nav class="sb-tabs" data-testid="sb-tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="sb-tab"
        :class="{ active: store.tab === t.key }"
        :data-testid="'tab-' + t.key"
        @click="store.tab = t.key"
      >
        {{ t.label }}
      </button>
    </nav>
    <div class="sb-body">
      <TocPanel v-show="store.tab === 'toc'" />
      <HistoryPanel v-show="store.tab === 'history'" />
      <FavPanel v-show="store.tab === 'fav'" />
      <FilesPanel v-show="store.tab === 'files'" />
    </div>
    <div class="sb-resizer" @mousedown="onDown"></div>
  </aside>
</template>
