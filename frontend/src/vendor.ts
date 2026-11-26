/**
 * 渲染库统一入口：全部改为 npm 依赖 + ESM import，由 Vite 打包进 dist/assets，
 * 不再从 /static/ 注入手工放置的 UMD 文件。大体积库走动态 import 保持按需加载，
 * 失败不缓存以便下次重试；highlight.js 双主题用 ?raw 读入 CSS 文本后自建 style 节点切换。
 */
import githubLightCss from 'highlight.js/styles/github.css?raw'
import githubDarkCss from 'highlight.js/styles/github-dark.css?raw'

const loaded = new Map<string, Promise<any>>()

function once<T>(key: string, factory: () => Promise<T>): Promise<T> {
  let p = loaded.get(key) as Promise<T> | undefined
  if (!p) {
    p = factory().catch((e) => {
      loaded.delete(key)
      throw e
    })
    loaded.set(key, p)
  }
  return p
}

// ---------- highlight.js ----------
export function ensureHljs(): Promise<any> {
  return once('hljs', async () => {
    const mod = await import('highlight.js/lib/common')
    return mod.default
  })
}

/** 代码高亮（hljs 可用时高亮，否则纯转义）。 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  try {
    const hljs = await ensureHljs()
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    }
    if (lang) return esc(code) // 指定了未知语言：不自动猜测，避免 yaml 被误判
    return esc(code)
  } catch {
    return esc(code)
  }
}

// ---------- marked ----------
/** 每次渲染取全新实例，避免 marked.use() 跨调用累积。 */
export async function freshMarked(): Promise<any> {
  const { Marked } = await once('marked', () => import('marked'))
  return new Marked()
}

// ---------- KaTeX ----------
interface KatexBundle {
  katex: any
  renderMathInElement: (el: Element, options?: Record<string, any>) => void
}

export function ensureKatex(): Promise<KatexBundle> {
  return once('katex', async () => {
    await import('katex/dist/katex.min.css')
    const [katexMod, autoRenderMod] = await Promise.all([
      import('katex'),
      import('katex/contrib/auto-render')
    ])
    return { katex: katexMod.default, renderMathInElement: autoRenderMod.default }
  })
}

export function maybeMath(html: string): boolean {
  return /\$[^$\n]+\$|\\\(|\\\[|\$\$/.test(html)
}

// ---------- Mermaid ----------
/** Mermaid.js v11 的 ESM 入口是 default 导出。 */
export function ensureMermaid(): Promise<any> {
  return once('mermaid', async () => {
    const mod = await import('mermaid')
    return mod.default
  })
}

// ---------- Pele ----------
/** Pele 的 ESM 入口只有命名导出 render，没有 default。 */
export function ensurePele(): Promise<any> {
  return once('pele', async () => {
    const mod = await import('pele')
    if (typeof mod.render !== 'function') throw new Error('pele unavailable')
    return mod
  })
}

// ---------- highlight.js 双主题 ----------
/** 把两份主题 CSS 作为 style 节点装入 head，并按主题切换内容。 */
export function setHljsTheme(theme: string): void {
  let light = document.getElementById('mdv-hljs-light') as HTMLStyleElement | null
  let dark = document.getElementById('mdv-hljs-dark') as HTMLStyleElement | null
  if (!light) {
    light = document.createElement('style')
    light.id = 'mdv-hljs-light'
    document.head.appendChild(light)
  }
  if (!dark) {
    dark = document.createElement('style')
    dark.id = 'mdv-hljs-dark'
    document.head.appendChild(dark)
  }
  const isDark = theme === 'dark'
  light.textContent = isDark ? '' : githubLightCss
  dark.textContent = isDark ? githubDarkCss : ''
}
