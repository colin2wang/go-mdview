<script lang="ts">
import { reactive } from 'vue'

/** 模块级单例状态：任意组件 import { showMenu } 即可呼出。 */
export const menuState = reactive({
  open: false,
  x: 0,
  y: 0,
  items: [] as MenuItem[]
})

export interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
}

export function showMenu(x: number, y: number, items: MenuItem[]) {
  menuState.x = Math.max(4, Math.min(x, window.innerWidth - 190))
  menuState.y = Math.max(4, Math.min(y, window.innerHeight - 40 * items.length - 12))
  menuState.items = items
  menuState.open = true
}
export function hideMenu() {
  menuState.open = false
}
</script>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'

// menuState/hideMenu/MenuItem 来自同文件 plain <script> 导出，同模块作用域可直接使用
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
