import type { TocItem } from './types'
import { ensureHljs, ensureKatex, freshMarked, maybeMath, loadScript } from './vendor'

/**
 * Markdown 渲染管线（样式对齐 mdview demo）：
 * 预处理（脚注/mark/wikilink，围栏感知）→ marked 自定义渲染
 * （标题锚点/代码高亮+语言标签+复制/图片本地回放/链接分类）→ GFM Alert 后处理。
 */

export interface RenderResult {
  html: string
  toc: TocItem[]
  hasMath: boolean
  hasMermaid: boolean
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function hexEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

function isWinAbs(p: string): boolean {
  return p.startsWith('/') || (p.length >= 3 && p[1] === ':' && (p[2] === '\\' || p[2] === '/'))
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name.replace(/^[\\/]+/, '')
}

/** 图片地址解析：网络/data 保持；相对路径 → /mdimg/{hex 绝对路径} 回放路由。 */
export function resolveImgHref(href: string, baseDir: string): string {
  if (!href) return href
  if (/^(https?:|data:|blob:)/i.test(href)) return href
  // 浏览器/Mock 模式：无 /mdimg 回放路由，本地图片用内置示例图兜底
  if (!(window as any).go) {
    return '/static/mock-sample.svg'
  }
  let p = href
  try {
    p = decodeURIComponent(href)
  } catch {
    /* 保留原样 */
  }
  p = p.replace(/^\.?\//, '')
  const abs = isWinAbs(p) ? p : baseDir ? joinPath(baseDir, p) : p
  const fileName = p.split(/[\\/]/).pop() ?? p
  return '/mdimg/' + hexEncode(abs) + '/' + encodeURIComponent(fileName)
}

/** md 链接解析为绝对路径。 */
export function resolveMdHref(href: string, baseDir: string): string {
  let p = href
  try {
    p = decodeURIComponent(href)
  } catch {
    /* 保留原样 */
  }
  p = p.replace(/^\.?\//, '')
  return isWinAbs(p) ? p : baseDir ? joinPath(baseDir, p) : p
}

// ---------- 标题 slug ----------

function makeSluger() {
  const seen = new Map<string, number>()
  return (text: string): string => {
    let slug =
      text
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}-]+/gu, '') || 'h'
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    return n === 0 ? `h-${slug}` : `h-${slug}-${n}`
  }
}

function plainText(tokens: any[]): string {
  let out = ''
  for (const t of tokens ?? []) {
    if (t.type === 'text' || t.type === 'codespan' || t.type === 'escape') out += t.text ?? ''
    else if (t.tokens) out += plainText(t.tokens)
  }
  return out
}

// ---------- 预处理 ----------

interface Footnote {
  id: string
  num: number
  content: string
}

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

export function preprocess(src: string): { md: string; footnotes: Footnote[]; usedFns: Map<string, number> } {
  const lines = src.split(/\r?\n/)
  const defs = new Map<string, string>()
  const order: string[] = []
  const used = new Map<string, number>()
  const out: string[] = []
  let inFence = false
  let fenceMark = ''

  for (const line of lines) {
    if (isFenceLine(line)) {
      const m = line.match(/^\s*(```|~~~)/)
      if (!inFence) {
        inFence = true
        fenceMark = m![1]
      } else if (line.trim().startsWith(fenceMark)) {
        inFence = false
      }
      out.push(line)
      continue
    }
    if (!inFence) {
      // GFM Alert：标记行后补空引号行，防止 marked 把 [!NOTE] 与正文懒续行合成同一段
      const am = line.match(/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)
      if (am) {
        out.push(line)
        out.push('>')
        continue
      }
      const def = line.match(/^\[\^([^\]\s]+)\]:\s?(.*)$/)
      if (def) {
        if (!defs.has(def[1])) order.push(def[1])
        defs.set(def[1], def[2])
        continue // 脚注定义从正文摘除
      }
      let l = line.replace(/\[\^([^\]\s]+)\]/g, (m0, id: string) => {
        if (!used.has(id)) used.set(id, used.size + 1)
        const n = used.get(id)!
        return `<sup class="md-fn-ref"><a id="fnref-${escapeHtml(id)}" class="md-fnref-link" href="#fn-${escapeHtml(id)}">${n}</a></sup>`
      })
      l = l.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
      l = l.replace(/\[\[([^\]\n|]+)\]\]/g, (_m0, t: string) => {
        const label = t.trim()
        return `<a class="wikilink" data-wiki="${escapeHtml(label)}">${escapeHtml(label)}</a>`
      })
      out.push(l)
    } else {
      out.push(line)
    }
  }

  const footnotes: Footnote[] = []
  let num = 0
  for (const id of order) {
    if (!used.has(id)) continue // 未被引用的定义不进文末
    num++
    footnotes.push({ id, num: used.get(id)!, content: defs.get(id) ?? '' })
  }
  return { md: out.join('\n'), footnotes, usedFns: used }
}

// ---------- Alert 后处理 ----------

const ALERT_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
}

export function postprocessAlerts(html: string): string {
  return html.replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*<\/p>/gi,
    (_m, t: string) => {
      const k = t.toLowerCase()
      return `<blockquote class="alert alert-${k}"><p class="alert-title">${ALERT_TITLES[k] ?? t}</p>`
    }
  )
}

// ---------- 脚注区 ----------

async function buildFootnotesHtml(footnotes: Footnote[]): Promise<string> {
  if (!footnotes.length) return ''
  const marked = await freshMarked()
  const items = footnotes
    .map((f) => {
      let inner = ''
      try {
        inner = String(marked.parse(f.content)).trim()
      } catch {
        inner = escapeHtml(f.content)
      }
      if (/^<p>[\s\S]*<\/p>$/.test(inner) && (inner.match(/<p>/g) ?? []).length === 1) {
        inner = inner.slice(3, -4)
      }
      return `<li id="fn-${escapeHtml(f.id)}" class="md-fn-item">${inner}<a href="#fnref-${escapeHtml(f.id)}" class="md-fn-backlink" title="返回">↩</a></li>`
    })
    .join('\n')
  return `<div class="md-footnotes"><hr>\n<ol class="md-fn-list">\n${items}\n</ol>\n</div>`
}

// ---------- 主渲染 ----------

export async function renderMarkdown(src: string, baseDir: string): Promise<RenderResult> {
  const [marked, hljs] = await Promise.all([freshMarked(), ensureHljs()])
  const slug = makeSluger()
  const { md, footnotes } = preprocess(src)

  const renderer: any = {
    heading(token: any) {
      const text = this.parser.parseInline(token.tokens)
      const plain = plainText(token.tokens)
      const id = slug(plain)
      return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`
    },
    code(token: any) {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
      if (lang.toLowerCase() === 'mermaid') {
        return (
          `<div class="md-diagram" data-mermaid="${encodeURIComponent(token.text)}">` +
          `<div class="md-diagram-head"><span class="md-diagram-title">Mermaid 图表</span><span class="md-diagram-meta">mermaid</span></div>` +
          `<div class="md-diagram-body"><div class="md-diagram-src">渲染中…</div></div></div>`
        )
      }
      let body: string
      try {
        if (lang && hljs.getLanguage(lang)) {
          body = hljs.highlight(token.text, { language: lang, ignoreIllegals: true }).value
        } else {
          body = escapeHtml(token.text)
        }
      } catch {
        body = escapeHtml(token.text)
      }
      const cls = lang ? ` class="hljs language-${escapeHtml(lang)}"` : ' class="hljs"'
      // 语言标签与复制按钮统一放进 .code-tools（CSS 绝对定位到右上角，按钮悬停才显形）
      return (
        `<div class="code-block${lang ? ' has-lang' : ''}">` +
        `<div class="code-tools">` +
        (lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '') +
        `<button type="button" class="code-copy" data-copy="${encodeURIComponent(token.text)}" title="复制代码">` +
        `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>` +
        `</button>` +
        `</div>` +
        `<pre><code${cls}>${body}</code></pre></div>\n`
      )
    },
    image(token: any) {
      const href = resolveImgHref(token.href ?? '', baseDir)
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<img src="${escapeHtml(href)}"${title} alt="${escapeHtml(token.text ?? '')}" loading="lazy">`
    },
    link(token: any) {
      const text = this.parser.parseInline(token.tokens)
      const href = token.href ?? ''
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      if (/^(https?:|mailto:)/i.test(href)) {
        return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`
      }
      if (/\.(md|markdown)$/i.test(href.split('#')[0] ?? '')) {
        const abs = resolveMdHref(href.split('#')[0], baseDir)
        const anchor = href.includes('#') ? '#' + href.split('#')[1] : ''
        return `<a href="javascript:void(0)" class="md-link" data-mdlink="${escapeHtml(abs)}" data-anchor="${escapeHtml(anchor)}"${title}>${text}</a>`
      }
      return `<a href="javascript:void(0)" class="md-link-dead" data-dead="${escapeHtml(href)}"${title}>${text}</a>`
    }
  }

  marked.use({ gfm: true, breaks: false, renderer })

  let html = String(marked.parse(md))
  html = postprocessAlerts(html)
  html += await buildFootnotesHtml(footnotes)

  // TOC 提取：独立 sluger，按相同文档顺序生成 → 与渲染 id 确定性一致
  const toc: TocItem[] = []
  try {
    const tocSlug = makeSluger()
    const tokens = marked.lexer(md)
    const walk = (arr: any[]) => {
      for (const t of arr) {
        if (t.type === 'heading') {
          const plain = plainText(t.tokens ?? [])
          toc.push({ id: tocSlug(plain), text: plain, depth: t.depth })
        }
        if (t.type !== 'heading' && t.tokens) walk(t.tokens)
      }
    }
    walk(tokens)
  } catch {
    /* TOC 提取失败不阻塞渲染 */
  }

  return { html, toc, hasMath: maybeMath(md), hasMermaid: html.includes('data-mermaid') }
}

/** 渲染数学公式（KaTeX auto-render）。 */
export async function renderMathIn(el: HTMLElement): Promise<void> {
  try {
    await ensureKatex()
    const w = window as any
    if (w.renderMathInElement) {
      w.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false
      })
    }
  } catch {
    /* 公式库加载失败静默降级 */
  }
}

let mermaidSeq = 0

/** 渲染页面中的 Mermaid 占位块。force=true 用于主题切换后的重绘。 */
export async function renderMermaidIn(el: HTMLElement, dark: boolean, force = false): Promise<void> {
  const blocks = el.querySelectorAll<HTMLElement>('[data-mermaid]')
  if (!blocks.length) return
  if (force) {
    // 主题变了要换色：清掉完成标记与状态类，允许重新渲染
    blocks.forEach((b) => {
      delete b.dataset.done
      b.classList.remove('ok', 'err')
    })
  }
  try {
    await loadScript('/static/mermaid.min.js')
    const mermaid = (window as any).mermaid
    if (!mermaid) throw new Error('mermaid unavailable')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' })
    for (const block of Array.from(blocks)) {
      if (block.dataset.done === '1') continue
      const code = decodeURIComponent(block.dataset.mermaid ?? '')
      const holder = block.querySelector('.md-diagram-src')
      if (!holder) continue
      try {
        const id = `mdv-mm-${++mermaidSeq}`
        const res = await mermaid.render(id, code)
        holder.innerHTML = res.svg
        block.dataset.done = '1'
        block.classList.add('ok')
      } catch (e) {
        holder.innerHTML =
          `<div class="md-diagram-hint"><div class="md-diagram-hint-text">Mermaid 语法有误，已显示源码。</div>` +
          `<pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
        block.dataset.done = '1'
        block.classList.add('err')
      }
    }
  } catch {
    const blocks2 = el.querySelectorAll<HTMLElement>('[data-mermaid]:not([data-done="1"])')
    blocks2.forEach((b) => {
      const h = b.querySelector('.md-diagram-src')
      if (h) h.textContent = 'Mermaid 库加载失败'
      b.dataset.done = '1'
    })
  }
}
