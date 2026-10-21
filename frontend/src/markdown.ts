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

// ---------- 原始 HTML 清洗（防 XSS）----------
// marked 会原样放行 md 里的 HTML token；来源不明的 .md 可能携带脚本，
// 统一在插入 DOM 前去掉 <script>/<iframe>/<object>/<embed>、on* 事件
// 属性与 javascript:/vbscript: 链接协议。
function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|xlink:href)\s*=\s*("\s*(javascript|vbscript):[^"]*"|'\s*(javascript|vbscript):[^']*')/gi, '')
    .replace(/\s(href|src|action|xlink:href)\s*=\s*(javascript|vbscript):[^\s>]*/gi, '')
}

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

// ---------- 图形卡片（Mermaid / SVG）----------

export type DiagramKind = 'mermaid' | 'svg'

const COPY_ICON =
  `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">` +
  `<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>` +
  `<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>` +
  `</svg>`

const DIAGRAM_TITLE: Record<string, string> = { mermaid: 'Mermaid 图表', svg: 'SVG 图形' }

/** 代码块是否应渲染成图形卡片：mermaid / svg（含未标注语言但内容是 SVG 的情况）。 */
export function diagramKindOf(lang: string, text: string): DiagramKind | '' {
  const l = lang.toLowerCase()
  if (l === 'mermaid') return 'mermaid'
  if (l === 'svg' || l === 'svg+xml') return 'svg'
  if (l === '' || l === 'xml' || l === 'html') {
    return /<svg[\s>]/i.test(text.slice(0, 512)) ? 'svg' : ''
  }
  return ''
}

/** 内联 SVG 清洗：去掉脚本、外联对象与事件属性。 */
export function sanitizeSvg(code: string): string {
  return normalizeSvgRoot(
    code
      .replace(/<\s*(script|foreignObject)\b[\s\S]*?<\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|foreignObject)\b[^>]*\/?\s*>/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '')
  )
}

/** 取根节点上某属性的值（仅用于 width/height 判断）。 */
function svgAttr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return m ? (m[2] ?? m[3] ?? '').trim() : ''
}

/**
 * 归一化 SVG 根节点尺寸。
 * 很多工具导出的 SVG 是 width="100%"（或不带 viewBox），放进自适应容器里
 * 宽高会同时算不出来，整张图塌成 0×0 —— 页面上就只剩一个空白卡片：
 * - 有绝对宽高却没有 viewBox：按宽高补 viewBox，得到固有宽高比
 * - 宽度是百分比/缺失：改写为 width="100%"，高度交给 CSS 按比例算
 */
function normalizeSvgRoot(svg: string): string {
  if (!/<svg[\s>]/i.test(svg)) return svg
  return svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs
    const w = svgAttr(a, 'width')
    const h = svgAttr(a, 'height')
    const isAbs = (v: string) => /^\d+(\.\d+)?(px|pt|em|)?$/.test(v)
    if (!/viewBox\s*=/i.test(a) && isAbs(w) && isAbs(h) && w !== '' && h !== '') {
      a += ` viewBox="0 0 ${parseFloat(w)} ${parseFloat(h)}"`
    }
    if (!isAbs(w) || w === '') {
      a = a.replace(/\swidth\s*=\s*("[^"]*"|'[^']*')/i, '')
      a += ' width="100%"'
    }
    if (!isAbs(h) || h === '') {
      a = a.replace(/\sheight\s*=\s*("[^"]*"|'[^']*')/i, '')
    }
    return `<svg${a}>`
  })
}

/**
 * 图形卡片：与 Mermaid 一致的卡片外观，头部带「源码」按钮，
 * 可在渲染结果与原始代码之间来回切换（SVG 直接内联，Mermaid 挂载后异步出图）。
 */
export function diagramCard(kind: DiagramKind, label: string, code: string): string {
  const enc = encodeURIComponent(code)
  return (
    `<div class="md-diagram" data-diagram="${kind}" data-${kind}="${enc}" data-src="${enc}">` +
    `<div class="md-diagram-head">` +
    `<span class="md-diagram-title">${DIAGRAM_TITLE[kind]}</span>` +
    `<span class="md-diagram-tools">` +
    `<span class="md-diagram-meta">${escapeHtml(label)}</span>` +
    `<button type="button" class="md-diagram-btn" data-toggle-src title="查看源码">源码</button>` +
    `<button type="button" class="md-diagram-btn" data-copy="${enc}" title="复制源码">${COPY_ICON}</button>` +
    `</span>` +
    `</div>` +
    `<div class="md-diagram-body"><div class="md-diagram-src">` +
    (kind === 'svg' ? sanitizeSvg(code) : '渲染中…') +
    `</div></div>` +
    `<pre class="md-diagram-code"><code>${escapeHtml(code)}</code></pre>` +
    `</div>\n`
  )
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
      const text = token.text ?? ''
      // mermaid / svg 走图形卡片（可切源码），其余走代码块卡片
      const kind = diagramKindOf(lang, text)
      if (kind) return diagramCard(kind, lang || kind, text)

      let body: string
      try {
        if (lang && hljs.getLanguage(lang)) {
          body = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
        } else {
          body = escapeHtml(text)
        }
      } catch {
        body = escapeHtml(text)
      }
      const cls = lang ? ` class="hljs language-${escapeHtml(lang)}"` : ' class="hljs"'
      // 头部工具条：语言标签 + 复制按钮（复制按钮悬停才显形）
      return (
        `<div class="code-block${lang ? ' has-lang' : ''}">` +
        `<div class="code-head">` +
        `<span class="code-lang">${lang ? escapeHtml(lang) : 'text'}</span>` +
        `<span class="code-tools">` +
        `<button type="button" class="code-copy" data-copy="${encodeURIComponent(text)}" title="复制代码">${COPY_ICON}</button>` +
        `</span>` +
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
  html = sanitizeHtml(html)
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

/** 图形卡片正文的容器选择器。 */
function srcHolder(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.md-diagram-src')
}

/**
 * 渲染页面中的图形卡片：Mermaid 出 SVG、内联 SVG 直接落地。
 * force=true 用于主题切换后的重绘。
 */
export async function renderDiagramsIn(el: HTMLElement, dark: boolean, force = false): Promise<void> {
  const blocks = el.querySelectorAll<HTMLElement>('[data-mermaid],[data-svg]')
  if (!blocks.length) return
  if (force) {
    // 主题变了要换色：清掉完成标记与状态类，允许重新渲染
    blocks.forEach((b) => {
      delete b.dataset.done
      b.classList.remove('ok', 'err')
    })
  }

  // 内联 SVG：不需要外部库，直接落地（失败/非法内容降级为源码提示）
  for (const block of Array.from(el.querySelectorAll<HTMLElement>('[data-svg]'))) {
    if (block.dataset.done === '1') continue
    const holder = srcHolder(block)
    if (!holder) continue
    let code = block.dataset.svg ?? ''
    try {
      code = decodeURIComponent(code)
    } catch {
      /* 源码里带了裸 % 时 decode 会抛错，保留原样即可 */
    }
    const safe = sanitizeSvg(code)
    if (/<svg[\s>]/i.test(safe)) {
      holder.innerHTML = safe
      block.classList.add('ok')
    } else {
      holder.innerHTML =
        `<div class="md-diagram-hint"><div class="md-diagram-hint-text">SVG 内容无法解析，已显示源码。</div>` +
        `<pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
      block.classList.add('err')
    }
    block.dataset.done = '1'
  }

  const mmBlocks = Array.from(el.querySelectorAll<HTMLElement>('[data-mermaid]'))
  if (!mmBlocks.length) return
  try {
    await loadScript('/static/mermaid.min.js')
    const mermaid = (window as any).mermaid
    if (!mermaid) throw new Error('mermaid unavailable')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' })
    for (const block of mmBlocks) {
      if (block.dataset.done === '1') continue
      const code = decodeURIComponent(block.dataset.mermaid ?? '')
      const holder = srcHolder(block)
      if (!holder) continue
      try {
        const id = `mdv-mm-${++mermaidSeq}`
        const res = await mermaid.render(id, code)
        holder.innerHTML = res.svg
        block.dataset.done = '1'
        block.classList.add('ok')
      } catch {
        holder.innerHTML =
          `<div class="md-diagram-hint"><div class="md-diagram-hint-text">Mermaid 语法有误，已显示源码。</div>` +
          `<pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
        block.dataset.done = '1'
        block.classList.add('err')
      }
    }
  } catch {
    for (const b of mmBlocks) {
      if (b.dataset.done === '1') continue
      const h = srcHolder(b)
      if (h) h.textContent = 'Mermaid 库加载失败'
      b.dataset.done = '1'
    }
  }
}
