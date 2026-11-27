import { nextTick, reactive } from 'vue'

/** 右键菜单的模块级单例状态：任意组件 import { showMenu } 即可呼出。 */
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
  menuState.items = items
  menuState.x = x
  menuState.y = y
  menuState.open = true
  // 菜单项高度/宽度由 CSS 决定，按每项 40px 估算会在字体或缩放变化时溢出屏幕。
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="ctx-menu"]')
    if (!el || !menuState.open) return
    const rect = el.getBoundingClientRect()
    menuState.x = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
    menuState.y = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
  })
}

export function hideMenu() {
  menuState.open = false
}
