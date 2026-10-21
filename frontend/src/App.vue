<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { store, initApp, openEntry, toggleFavorite, applySettings } from './store'
import { getApi, isDesktop } from './api'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import Viewer from './components/Viewer.vue'
import SettingsModal from './components/SettingsModal.vue'
import ContextMenu from './components/ContextMenu.vue'

const dropHint = ref(false)
let dragDepth = 0

onMounted(() => {
  initApp()
  window.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragDepth++
    dropHint.value = true
  })
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) dropHint.value = false
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    dropHint.value = false
    // 桌面端由 Wails runtime.OnFileDrop 接管（能拿到绝对路径），这里只做浏览器兜底
    if (isDesktop()) return
    const f = (e as DragEvent).dataTransfer?.files?.[0]
    if (f && /\.(md|markdown|mdown|mkd)$/i.test(f.name)) openEntry((f as any).path ?? '')
  })
})

// 无文件时主题/字号也要生效：settings 尚未加载时先按默认落地
watch(
  () => store.settings,
  (st) => {
    applySettings(st)
  },
  { immediate: true, deep: false }
)
</script>

<template>
  <div class="app-shell" data-testid="app-shell">
    <TitleBar />
    <div class="app-main">
      <SideBar />
      <Viewer />
    </div>
    <div v-if="dropHint" class="drop-hint">松开以打开 Markdown 文件</div>
    <div class="toasts" data-testid="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind" :data-testid="'toast-' + t.id">
        {{ t.text }}
      </div>
    </div>
    <SettingsModal />
    <ContextMenu />
  </div>
</template>
