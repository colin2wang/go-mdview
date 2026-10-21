<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { store, patchSettings } from '../store'

const open = computed(() => store.settingsOpen)
const st = computed(() => store.settings)

function close() {
  store.settingsOpen = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
// 弹窗打开期间接管 Esc；关闭时摘掉监听
watch(open, (v) => {
  if (v) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
function setThemeEvt(v: string) {
  patchSettings({ theme: v })
}
function setFs(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) patchSettings({ fontSize: v })
}
function setWrap(e: Event) {
  const v = (e.target as HTMLInputElement).checked
  patchSettings({ codeWrap: v })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" data-testid="settings-mask" @click.self="close">
      <div class="modal" data-testid="settings-modal" @keydown.esc="close">
        <div class="modal-head">
          <h3>设置</h3>
          <button class="modal-x" title="关闭" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <!-- 用 div 而非 label：label 会把点击转发给首个可关联控件，导致点“主题”二字误触发浅色 -->
          <div class="set-row">
            <span class="set-label">主题</span>
            <span class="set-seg" role="radiogroup">
              <button class="seg-btn" value="light" :class="{ on: st?.theme === 'light' }" data-testid="theme-light" @click="setThemeEvt('light')">浅色</button>
              <button class="seg-btn" value="dark" :class="{ on: st?.theme === 'dark' }" data-testid="theme-dark" @click="setThemeEvt('dark')">深色</button>
            </span>
          </div>
          <label class="set-row">
            <span class="set-label">正文字号</span>
            <span class="set-val">
              <input type="range" min="12" max="28" step="1" :value="st?.fontSize ?? 16" data-testid="font-range" @input="setFs" />
              <b class="fs-num" data-testid="font-num">{{ st?.fontSize ?? 16 }}px</b>
            </span>
          </label>
          <label class="set-row">
            <span class="set-label">代码块自动换行</span>
            <input type="checkbox" class="set-switch" :checked="st?.codeWrap ?? false" data-testid="wrap-check" @change="setWrap" />
          </label>
          <div class="set-about">
            <p><b>mdview</b> 复刻版 · Go + Wails 构建</p>
            <p class="sub">双击 .md 文件打开；拖拽进窗口也能打开；右键菜单可切换主题与导出 HTML。</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
