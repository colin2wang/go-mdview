<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { store, initApp, openEntry, toggleFavorite, applySettings, resolveGoneFile } from './store'
import { getApi, isDesktop } from './api'
import { t } from './i18n'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import Viewer from './components/Viewer.vue'
import StatusBar from './components/StatusBar.vue'
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
    if (f && /\.(md|markdown|mdown|mkd)$/i.test(f.name)) openEntry((f as any).path ?? '', { reRoot: true })
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
    <StatusBar />
    <div v-if="dropHint" class="drop-hint">{{ t('drop.hint') }}</div>
    <div class="toasts" data-testid="toasts">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.kind" :data-testid="'toast-' + t.id">
        {{ t.text }}
      </div>
    </div>
    <SettingsModal />
    <ContextMenu />
    <!-- 外部删除确认：不独占文件，外部始终可删；点遮罩不生效，只认「保留/关闭」按钮 -->
    <Teleport to="body">
      <div v-if="store.goneFile" class="modal-mask" data-testid="gone-mask">
        <div class="modal gone-modal" data-testid="gone-modal">
          <div class="gone-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </div>
          <h3 class="gone-title">{{ t('gone.title') }}</h3>
          <p class="gone-body">{{ t('gone.body', { name: store.goneFile.split(/[\\/]/).pop() ?? store.goneFile }) }}</p>
          <div class="gone-actions">
            <button class="set-btn danger" data-testid="gone-close" @click="resolveGoneFile(false)">{{ t('gone.close') }}</button>
            <button class="set-btn" data-testid="gone-keep" @click="resolveGoneFile(true)">{{ t('gone.keep') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
