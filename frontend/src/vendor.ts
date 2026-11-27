/**
 * Unified entry point for render libraries: all npm dependencies imported as
 * ESM and bundled by Vite into dist/assets. Large libraries use dynamic
 * imports for on-demand loading; failures are not cached so the next access
 * retries. The highlight.js dual theme reads CSS via ?raw and switches by
 * creating style nodes.
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

/** Code highlighting (highlights when hljs is available, plain escaping otherwise). */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  try {
    const hljs = await ensureHljs()
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    }
    if (lang) return esc(code)
    return esc(code)
  } catch {
    return esc(code)
  }
}

// ---------- marked ----------
/** Returns a fresh instance per render, avoiding cross-call accumulation via marked.use(). */
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
/** Mermaid.js v11's ESM entry is a default export. */
export function ensureMermaid(): Promise<any> {
  return once('mermaid', async () => {
    const mod = await import('mermaid')
    return mod.default
  })
}

// ---------- Pele ----------
/** Pele's ESM entry has only the named export render, no default. */
export function ensurePele(): Promise<any> {
  return once('pele', async () => {
    const mod = await import('pele')
    if (typeof mod.render !== 'function') throw new Error('pele unavailable')
    return mod
  })
}

// ---------- highlight.js dual theme ----------
/** Installs both theme CSS files as style nodes in head and switches their content by theme. */
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
