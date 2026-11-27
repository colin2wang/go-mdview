<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import {
  store,
  initApp,
  applySettings,
  resolveGoneFile,
  resolveDiscardSave,
  resolveDiscardDrop,
  resolveDiscardCancel,
  discardMessage,
  toast
} from './store'
import { isDesktop } from './api'
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
    // 桌面端由 Go 侧原生拖放（EnableFileDrop + WindowFilesDropped）接管，能拿到绝对路径
    if (isDesktop()) return
    // 浏览器沙箱拿不到本地绝对路径（File.path 恒为空），只能提示不支持
    if ((e as DragEvent).dataTransfer?.files?.length) toast(t('drop.browserNoPath'), 'error')
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
  <div class="app-shell" data-testid="app-shell" data-file-drop-target>
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
    <!-- 未保存草稿确认：点遮罩不生效，只认「保存 / 放弃 / 取消」 -->
    <Teleport to="body">
      <div v-if="store.discardReason" class="modal-mask" data-testid="discard-mask">
        <div class="modal gone-modal discard-modal" data-testid="discard-modal">
          <div class="discard-head">
            <div class="discard-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
              </svg>
            </div>
            <div class="discard-text">
              <h3 class="gone-title">{{ t('discard.title') }}</h3>
              <p class="gone-body">{{ discardMessage(store.discardReason) }}</p>
            </div>
          </div>
          <div class="gone-actions">
            <button class="set-btn" data-testid="discard-save" :disabled="store.discardSaving" @click="resolveDiscardSave()">{{ t('discard.save') }}</button>
            <button class="set-btn danger" data-testid="discard-drop" @click="resolveDiscardDrop()">{{ t('discard.drop') }}</button>
            <button class="set-btn neutral" data-testid="discard-cancel" @click="resolveDiscardCancel()">{{ t('discard.cancel') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
