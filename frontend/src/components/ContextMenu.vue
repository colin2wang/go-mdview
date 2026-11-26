<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { hideMenu, menuState, type MenuItem } from '../context-menu'

// 菜单状态来自纯 TS 模块（.vue 的命名导出无法被 vue-tsc 识别）
function run(it: MenuItem) {
  hideMenu()
  it.action()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') hideMenu()
}
onMounted(() => {
  window.addEventListener('click', hideMenu, true)
  window.addEventListener('blur', hideMenu)
  window.addEventListener('resize', hideMenu)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('click', hideMenu, true)
  window.removeEventListener('blur', hideMenu)
  window.removeEventListener('resize', hideMenu)
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menuState.open"
      class="ctx-menu"
      :style="{ left: menuState.x + 'px', top: menuState.y + 'px' }"
      data-testid="ctx-menu"
      @contextmenu.prevent
    >
      <button
        v-for="it in menuState.items"
        :key="it.label"
        class="ctx-item"
        :class="{ danger: it.danger }"
        data-testid="ctx-item"
        @click.stop="run(it)"
      >
        {{ it.label }}
      </button>
    </div>
  </Teleport>
</template>
