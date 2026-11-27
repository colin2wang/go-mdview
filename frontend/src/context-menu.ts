import { nextTick, reactive } from 'vue'

/** Module-level singleton state for the context menu; any component can pop it up via showMenu. */
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
