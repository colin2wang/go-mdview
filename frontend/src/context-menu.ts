import { reactive } from 'vue'

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
  menuState.x = Math.max(4, Math.min(x, window.innerWidth - 190))
  menuState.y = Math.max(4, Math.min(y, window.innerHeight - 40 * items.length - 12))
  menuState.items = items
  menuState.open = true
}

export function hideMenu() {
  menuState.open = false
}
