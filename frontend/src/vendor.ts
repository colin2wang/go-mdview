/**
 * 静态渲染库加载器：highlight.js / marked / KaTeX / mermaid 全部走
 * /static/ 下的本地文件（已随应用嵌入），动态按需注入，带缓存 Promise。
 */

const loaded = new Map<string, Promise<void>>()

export function loadScript(src: string): Promise<void> {
  let p = loaded.get(src)
  if (p) return p
  p = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('script load failed: ' + src))
    document.head.appendChild(s)
  })
  loaded.set(src, p)
  return p
}

export function loadCss(href: string, id?: string): Promise<void> {
  if (id) {
    const exists = document.getElementById(id)
    if (exists) return Promise.resolve()
  }
  let p = loaded.get(href)
  if (p) return p
  p = new Promise<void>((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    if (id) link.id = id
    link.onload = () => resolve()
    link.onerror = () => reject(new Error('css load failed: ' + href))
    document.head.appendChild(link)
  })
  loaded.set(href, p)
  return p
}

// ---------- highlight.js ----------
export async function ensureHljs(): Promise<any> {
  const w = window as any
  if (w.hljs) return w.hljs
  await loadScript('/static/highlight.min.js')
  return (window as any).hljs
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
/** 返回 UMD 命名空间（含 .Marked 类与默认实例 .marked）。 */
export async function ensureMarkedNs(): Promise<any> {
  const w = window as any
  if (w.marked?.Marked || w.marked?.parse) return w.marked
  await loadScript('/static/marked.min.js')
  return (window as any).marked
}

/** 每次渲染取全新实例，避免 marked.use() 跨调用累积。 */
export async function freshMarked(): Promise<any> {
  const ns = await ensureMarkedNs()
  if (ns?.Marked) return new ns.Marked()
  return ns?.marked ?? ns
}

// ---------- KaTeX ----------
export async function ensureKatex(): Promise<any> {
  const w = window as any
  if (w.katex) return w.katex
  await loadCss('/static/katex/katex.min.css', 'mdv-katex-css')
  await loadScript('/static/katex/katex.min.js')
  await loadScript('/static/katex/auto-render.min.js')
  return (window as any).katex
}

export function maybeMath(html: string): boolean {
  return /\$[^$\n]+\$|\\\(|\\\[|\$\$/.test(html)
}

// ---------- mermaid ----------
let mermaidReady = false

export async function ensureMermaid(): Promise<any> {
  const w = window as any
  if (mermaidReady && w.mermaid) return w.mermaid
  await loadScript('/static/mermaid.min.js')
  const m = (window as any).mermaid
  if (m && !mermaidReady) {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
    mermaidReady = true
  }
  return m
}
