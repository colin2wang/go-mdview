import type { RendererObject } from 'marked'
import type { MermaidEngine, TocItem } from './types'
import { ensureHljs, ensureKatex, ensureMermaid, ensurePele, freshMarked, maybeMath } from './vendor'
import mockSampleUrl from './assets/mock-sample.svg'
import { getLang, t, type Lang } from './i18n'
import DOMPurify from 'dompurify'
import sanitizeConfig from './sanitize-config.json'
import {
  createState,
  isRemoteSrc,
  mermaidSvgConfig,
  peleSvgConfig,
  remoteAllowed as remoteAllowedByPattern,
  sanitizeWith,
  splitConfig,
  stripSvgExternalRefs,
  stripSvgStyleUrls,
  svgConfig
} from './sanitize-common.js'

export { isRemoteSrc, remoteAllowedByPattern as remoteAllowed }

const parts = splitConfig(sanitizeConfig as Record<string, any>)

/**
 * Markdown rendering pipeline (styles aligned with the mdview demo):
 * preprocessing (footnote/mark/wikilink, fence-aware) → marked custom renderers
 * (heading anchors / code highlighting + language label + copy / local image
 * replay / link classification) → GFM Alert post-processing.
 */

export interface RenderResult {
  html: string
  toc: TocItem[]
  /** Sync-scroll anchors sharing the source of toc: heading source line numbers (0-based, against the pre-preprocess source). */
  anchors: SrcAnchor[]
  hasMath: boolean
  hasMermaid: boolean
}

/** Sync-scroll anchor: id matches the heading id in the rendered DOM. */
export interface SrcAnchor {
  line: number
  id: string
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Placeholder image shown when a remote resource is blocked (data URI, generated locally, no outgoing request).
 *  Cached per language: the key changes on language switch so the copy follows
 *  immediately, and repeated encode per render is avoided. */
const blockedImgCache = new Map<Lang, string>()
function blockedImgUri(): string {
  const lang = getLang()
  const cached = blockedImgCache.get(lang)
  if (cached) return cached
  const uri =
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="28"><rect width="120" height="28" rx="4" fill="#f0f0f0"/><text x="60" y="18" font-size="11" text-anchor="middle" fill="#999">🚫 ${t('img.blocked')}</text></svg>`
    )
  blockedImgCache.set(lang, uri)
  return uri
}

// ---------- Raw HTML sanitization (XSS prevention) ----------
// marked passes HTML tokens in the md through verbatim; .md files from unknown
// sources may carry scripts. String-level regex blacklists cannot beat an HTML
// parser (entity decoding, formaction, <meta>/<base> and other vectors bypass
// them), so real DOM parsing via DOMPurify is required. style tags/attributes
// are forbidden: prevents url() probing and keeps the "100% offline" promise.
// Hooks (remote-URL attribute rewriting, benign button/checkbox preservation)
// live in sanitize-common.js, shared with scripts/sanitize-check.mjs; the
// configuration comes from sanitize-config.json.

/** Unified HTML sanitization outlet: footnotes, error fallbacks and export re-sanitization all go through here. */
export function sanitizeHtml(html: string, blockRemote = true, remoteAllow = ''): string {
  const state = createState(blockRemote, remoteAllow, blockedImgUri, t('img.blocked'))
  return sanitizeWith(DOMPurify, parts, html, state)
}

function hexEncode(s: string): string {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')
}

function isWinAbs(p: string): boolean {
  return p.startsWith('/') || (p.length >= 3 && p[1] === ':' && (p[2] === '\\' || p[2] === '/'))
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name.replace(/^[\\/]+/, '')
}

/** Image URL resolution: network/data kept as-is; relative paths → the /mdimg/{hex absolute path} replay route. */
export function resolveImgHref(href: string, baseDir: string): string {
  if (!href) return href
  if (/^(https?:|data:|blob:)/i.test(href)) return href
  if (typeof window === 'undefined' || window._wails === undefined) {
    return mockSampleUrl
  }
  let p = href
  try {
    p = decodeURIComponent(href)
  } catch {
    /* keep as-is */
  }
  p = p.replace(/^\.?\//, '')
  const abs = isWinAbs(p) ? p : baseDir ? joinPath(baseDir, p) : p
  const fileName = p.split(/[\\/]/).pop() ?? p
  return '/mdimg/' + hexEncode(abs) + '/' + encodeURIComponent(fileName)
}

/** Resolves an md link to an absolute path. */
export function resolveMdHref(href: string, baseDir: string): string {
  let p = href
  try {
    p = decodeURIComponent(href)
  } catch {
    /* keep as-is */
  }
  p = p.replace(/^\.?\//, '')
  return isWinAbs(p) ? p : baseDir ? joinPath(baseDir, p) : p
}

// ---------- Heading slugs ----------

function makeSluger() {
  const seen = new Map<string, number>()
  return (text: string): string => {
    const slug =
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

// ---------- Preprocessing ----------

interface Footnote {
  id: string
  num: number
  content: string
}

function isFenceLine(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

export interface PreprocessResult {
  md: string
  footnotes: Footnote[]
  usedFns: Map<string, number>
  /** Output line → source line number (against the pre-preprocess src), for precise TOC anchor mapping. */
  lineMap: number[]
}

export function preprocess(src: string): PreprocessResult {
  const lines = src.split(/\r?\n/)
  const defs = new Map<string, string>()
  const order: string[] = []
  const used = new Map<string, number>()
  const out: string[] = []
  const lineMap: number[] = []
  let inFence = false
  let fenceMark = ''

  // Inline transforms apply only to plain prose segments: inline code (`...`) and
  // HTML comments are skipped, otherwise `[[x]]` / `[^1]` / `==mark==` would
  // rewrite code snippets too.
  const wikiLink = (m0: string, raw: string): string => {
    const label = raw.trim()
    const [targetRaw, alias] = label.split('|').map((s) => s.trim())
    const hashAt = targetRaw.indexOf('#')
    const target = hashAt >= 0 ? targetRaw.slice(0, hashAt) : targetRaw
    const anchor = hashAt >= 0 ? targetRaw.slice(hashAt + 1) : ''
    const base = target.split(/[\\/]/).pop() || target
    const display = alias || base
    // Obsidian embed syntax ![[file]]: image files become standard Markdown images via the /mdimg replay route
    if (m0.startsWith('!')) {
      const ext = (target.split('.').pop() ?? '').toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) {
        return `![${escapeHtml(display)}](${encodeURI(target)})`
      }
      // Non-image embeds (md transcriptions) degrade to wiki links, dropping the extra !
    }
    const anchorAttr = anchor ? ` data-anchor="${escapeHtml(anchor)}"` : ''
    return `<a class="wikilink" data-wiki="${escapeHtml(target)}"${anchorAttr}>${escapeHtml(display)}</a>`
  }

  const transformProse = (text: string): string => {
    let l = text.replace(/\[\^([^\]\s]+)\]/g, (_m0, id: string) => {
      if (!used.has(id)) used.set(id, used.size + 1)
      const n = used.get(id)!
      return `<sup class="md-fn-ref"><a id="fnref-${escapeHtml(id)}" class="md-fnref-link" href="#fn-${escapeHtml(id)}">${n}</a></sup>`
    })
    l = l.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
    l = l.replace(/!?\[\[([^\]\n]+)\]\]/g, wikiLink)
    return l
  }

  const transformLine = (line: string): string => {
    const skip = /(`+)([\s\S]*?)\1|<!--[\s\S]*?-->/g
    let result = ''
    let last = 0
    for (const m of line.matchAll(skip)) {
      const at = m.index ?? 0
      result += transformProse(line.slice(last, at))
      result += m[0]
      last = at + m[0].length
    }
    return result + transformProse(line.slice(last))
  }

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo]
    if (isFenceLine(line)) {
      const m = line.match(/^\s*(```|~~~)/)
      if (!inFence) {
        inFence = true
        fenceMark = m![1]
      } else if (line.trim().startsWith(fenceMark)) {
        inFence = false
      }
      out.push(line)
      lineMap.push(lineNo)
      continue
    }
    if (!inFence) {
      // A `---` line right after a paragraph is setext h2 syntax, but usually means a rule;
      // an empty line is inserted so it renders as <hr> while the paragraph stays intact
      if (/^\s*-{3,}\s*$/.test(line)) {
        const prev = out[out.length - 1]
        if (prev !== undefined && prev.trim() !== '' && !/^\s*-{3,}\s*$/.test(prev) && !/^\s*>/.test(prev)) {
          out.push('')
          lineMap.push(lineNo)
        }
      }
      // GFM Alert: an empty quote line is inserted after the marker so marked does not lazily merge [!NOTE] with body lines
      const am = line.match(/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i)
      if (am) {
        out.push(line)
        out.push('>')
        lineMap.push(lineNo, lineNo)
        continue
      }
      const def = line.match(/^\[\^([^\]\s]+)\]:\s?(.*)$/)
      if (def) {
        if (!defs.has(def[1])) order.push(def[1])
        defs.set(def[1], def[2])
        continue // footnote definitions are removed from the body
      }
      out.push(transformLine(line))
    } else {
      out.push(line)
    }
    lineMap.push(lineNo)
  }

  const footnotes: Footnote[] = []
  for (const id of order) {
    if (!used.has(id)) continue // unreferenced definitions stay out of the footnote section
    footnotes.push({ id, num: used.get(id)!, content: defs.get(id) ?? '' })
  }
  return { md: out.join('\n'), footnotes, usedFns: used, lineMap }
}

// ---------- Alert post-processing ----------

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

// ---------- Footnote section ----------

async function buildFootnotesHtml(footnotes: Footnote[], blockRemote: boolean, remoteAllow: string): Promise<string> {
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
      // The footnote section is appended after the whole-document sanitize and
      // must be sanitized separately here, otherwise <img onerror> /
      // <style>url(...)</style> / <svg onload> reach v-html bypassing the sanitizer.
      inner = sanitizeHtml(inner, blockRemote, remoteAllow)
      if (/^<p>[\s\S]*<\/p>$/.test(inner) && (inner.match(/<p>/g) ?? []).length === 1) {
        inner = inner.slice(3, -4)
      }
      return `<li id="fn-${escapeHtml(f.id)}" class="md-fn-item">${inner}<a href="#fnref-${escapeHtml(f.id)}" class="md-fn-backlink" title="${escapeHtml(t('fn.back'))}">↩</a></li>`
    })
    .join('\n')
  return `<div class="md-footnotes"><hr>\n<ol class="md-fn-list">\n${items}\n</ol>\n</div>`
}

// ---------- Diagram cards (Mermaid / SVG) ----------

export type DiagramKind = 'mermaid' | 'svg'

const COPY_ICON =
  `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">` +
  `<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>` +
  `<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>` +
  `</svg>`

/**
 * Wraps code HTML into per-line spans: the newline stays outside the span so
 * pre.textContent is byte-identical to the source (the copy button reads
 * textContent directly). highlight.js multi-line tokens are closed at the
 * newline and reopened on the next line so cross-line comments and template
 * strings keep their style; line numbers are generated by a CSS counter.
 */
function wrapCodeLines(html: string): string {
  if (!html) return ''
  const lines: string[] = []
  let cur = ''
  const stack: string[] = []
  const flush = () => {
    let closed = cur
    for (let i = stack.length - 1; i >= 0; i--) closed += '</span>'
    lines.push(`<span class="code-line"><span class="code-line-num" aria-hidden="true"></span>${closed}</span>`)
    cur = stack.join('')
  }
  const tokens = html.match(/<[^>]*>|[^<]+/g) ?? []
  for (const tok of tokens) {
    if (tok.startsWith('<')) {
      if (tok.startsWith('</')) {
        const name = tok.slice(2, -1).trim()
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].startsWith(`<${name}`)) {
            stack.splice(i, 1)
            break
          }
        }
      } else if (!/\/>$/.test(tok) && !/^<(?:br|hr|img|input)\b/i.test(tok)) {
        stack.push(tok)
      }
      cur += tok
      continue
    }
    let start = 0
    for (let i = 0; i < tok.length; i++) {
      if (tok[i] === '\n') {
        cur += tok.slice(start, i)
        flush()
        start = i + 1
      }
    }
    cur += tok.slice(start)
  }
  flush()
  return lines.join('\n')
}

/** Whether a code block should render as a diagram card: mermaid / svg (including unlabeled blocks whose content is SVG). */
export function diagramKindOf(lang: string, text: string): DiagramKind | '' {
  const l = lang.toLowerCase()
  if (l === 'mermaid') return 'mermaid'
  if (l === 'svg' || l === 'svg+xml') return 'svg'
  if (l === '' || l === 'xml' || l === 'html') {
    return /<svg[\s>]/i.test(text.slice(0, 512)) ? 'svg' : ''
  }
  return ''
}

/** Inline SVG sanitization: real DOM parsing via DOMPurify removes scripts,
 * foreignObject, event/dangerous attributes and remote references (including
 * data:, whose external image/xlink:href would send requests, breaking the
 * offline promise). allowStyle=true lets Mermaid keep theme <style>, while
 * sanitizeMermaidSvg strips styles containing url(). */
export function sanitizeSvg(code: string, allowStyle = false): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(DOMPurify, parts, stripSvgExternalRefs(code), state, svgConfig(parts, allowStyle))
  return normalizeSvgRoot(clean)
}

/** Mermaid output re-sanitization: keeps local theme styles (stripping <style> containing url()),
 * allows foreignObject (the htmlLabels text carrier, see mermaidSvgConfig). */
export function sanitizeMermaidSvg(code: string): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(DOMPurify, parts, stripSvgExternalRefs(code), state, mermaidSvgConfig(parts))
  try {
    const doc = new DOMParser().parseFromString(clean, 'text/html')
    const root = doc.querySelector('svg')
    if (!root) return clean
    root.querySelectorAll('style').forEach((s) => {
      if (/url\s*\(/i.test(s.textContent ?? '')) s.remove()
    })
    return normalizeSvgRoot(root.outerHTML)
  } catch {
    return clean
  }
}

/** Pele output re-sanitization: Pele has already filtered inline styles by whitelist, so they are allowed to keep classDef colors. */
export function sanitizePeleSvg(code: string): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(
    DOMPurify,
    parts,
    stripSvgExternalRefs(stripSvgStyleUrls(code)),
    state,
    peleSvgConfig(parts)
  )
  return normalizeSvgRoot(clean)
}

/** Reads an attribute from the root node (used only for width/height checks). */
function svgAttr(attrs: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return m ? (m[2] ?? m[3] ?? '').trim() : ''
}

/**
 * Normalizes the SVG root node size.
 * Many tools export SVG as width="100%" (or without a viewBox); inside a
 * self-sizing container neither width nor height can be computed and the whole
 * image collapses to 0×0, leaving only an empty card on the page:
 * - absolute width/height without a viewBox: the viewBox is derived from them,
 *   yielding an intrinsic aspect ratio
 * - percentage or missing width: rewritten to width="100%", height computed
 *   proportionally by CSS
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
 * Diagram card: same card look as Mermaid, with a "source" button in the head
 * to switch between the rendered result and the original code (SVG is inlined
 * directly, Mermaid renders asynchronously after mount).
 */
export function diagramCard(kind: DiagramKind, label: string, code: string): string {
  const enc = encodeURIComponent(code)
  const engineSelect =
    kind === 'mermaid'
      ? `<select class="md-diagram-engine" data-mm-engine aria-label="${escapeHtml(t('set.mmEngine'))}" title="${escapeHtml(t('set.mmEngine'))}">` +
        `<option value="mermaid">Mermaid.js</option><option value="pele">Pele</option></select>`
      : ''
  return (
    `<div class="md-diagram" data-diagram="${kind}" data-${kind}="${enc}" data-src="${enc}">` +
    `<div class="md-diagram-head">` +
    `<span class="code-lang md-diagram-lang">${escapeHtml(label)}</span>` +
    `<span class="md-diagram-tools">` +
    engineSelect +
    `<button type="button" class="md-diagram-btn" data-toggle-src title="${escapeHtml(t('diag.viewSrc'))}">${escapeHtml(t('diag.src'))}</button>` +
    `</span>` +
    `<button type="button" class="code-copy" data-copy title="${escapeHtml(t('diag.copyTip'))}">${COPY_ICON}</button>` +
    `</div>` +
    `<div class="md-diagram-body"><div class="md-diagram-src">` +
    (kind === 'svg' ? sanitizeSvg(code) : escapeHtml(t('diag.rendering'))) +
    `</div></div>` +
    `<pre class="md-diagram-code"><code>${wrapCodeLines(escapeHtml(code))}</code></pre>` +
    `</div>\n`
  )
}

// ---------- Main render ----------

// ---------- Block source-line injection (sync-scroll data-sl) ----------

/** Per-render line-number cursor; never shared at module level, or interleaved renders advance each other's cursor. */
export interface SlContext {
  tokenSrcLine(raw: string): number
  withSl(html: string, raw: string): string
}

export function createSlContext(md: string, lineMap: number[]): SlContext {
  let cursor = 0
  /** token source text → source file line number (cursor method + lineMap mapping back to pre-preprocess lines) */
  const tokenSrcLine = (raw: string): number => {
    if (!raw) return -1
    const i = md.indexOf(raw, cursor)
    if (i < 0) return -1
    cursor = i + raw.length
    const pre = md.slice(0, i).split('\n').length - 1
    return lineMap[pre] ?? pre
  }
  return {
    tokenSrcLine,
    /** Injects data-sl="source line number" into the block-level HTML; returns html unchanged when the source is not found */
    withSl(html: string, raw: string): string {
      const line = tokenSrcLine(raw)
      if (line < 0) return html
      return html.replace(/^<([a-zA-Z][\w-]*)/, `<$1 data-sl="${line}"`)
    }
  }
}

export async function renderMarkdown(
  src: string,
  baseDir: string,
  blockRemote = true,
  remoteAllow = ''
): Promise<RenderResult> {
  const [marked, hljs] = await Promise.all([freshMarked(), ensureHljs()])
  const slug = makeSluger()
  const { md, footnotes, lineMap } = preprocess(src)
  const sl = createSlContext(md, lineMap)

  const renderer: RendererObject = {
    heading(token: any) {
      const text = this.parser.parseInline(token.tokens)
      const plain = plainText(token.tokens)
      const id = slug(plain)
      return sl.withSl(`<h${token.depth} id="${id}">${text}</h${token.depth}>\n`, token.raw)
    },
    code(token: any) {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
      const text = token.text ?? ''
      // mermaid / svg go through diagram cards (source switchable), the rest through code block cards
      const kind = diagramKindOf(lang, text)
      if (kind) return sl.withSl(diagramCard(kind, lang || kind, text), token.raw)

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
      return sl.withSl(
        `<div class="code-block${lang ? ' has-lang' : ''}">` +
          `<div class="code-head">` +
          `<span class="code-lang">${lang ? escapeHtml(lang) : 'text'}</span>` +
          `<span class="code-tools">` +
          `<button type="button" class="code-copy" data-copy title="${escapeHtml(t('code.copy.tip'))}">${COPY_ICON}</button>` +
          `</span>` +
          `</div>` +
          `<pre><code${cls}>${wrapCodeLines(body)}</code></pre></div>\n`,
        token.raw
      )
    },
    paragraph(token: any) {
      return sl.withSl(`<p>${this.parser.parseInline(token.tokens)}</p>\n`, token.raw)
    },
    blockquote(token: any) {
      return sl.withSl(`<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`, token.raw)
    },
    table(token: any) {
      const cell = (tokens: any[], flags: { header: boolean; align: string }): string => {
        const tag = flags.header ? 'th' : 'td'
        const align = flags.align ? ` align="${flags.align}"` : ''
        return `<${tag}${align}>${this.parser.parseInline(tokens)}</${tag}>\n`
      }
      let header = ''
      if (token.header.length > 0) {
        header += '<tr>\n'
        for (let i = 0; i < token.header.length; i++) {
          header += cell(token.header[i].tokens, { header: true, align: token.align[i] })
        }
        header += '</tr>\n'
      }
      let body = ''
      for (const row of token.rows) {
        body += '<tr>\n'
        for (let j = 0; j < row.length; j++) {
          body += cell(row[j].tokens, { header: false, align: token.align[j] })
        }
        body += '</tr>\n'
      }
      if (body) body = `<tbody>\n${body}</tbody>\n`
      let html = '<table>\n'
      if (header) html += `<thead>\n${header}</thead>\n`
      html += body + '</table>\n'
      return sl.withSl(html, token.raw)
    },
    image(token: any) {
      let href = resolveImgHref(token.href ?? '', baseDir)
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      // Remote-resource blocking (default on): no outgoing request, replaced by a local placeholder; whitelist matches pass through
      if (blockRemote && isRemoteSrc(href) && !remoteAllowedByPattern(href, remoteAllow)) {
        href = blockedImgUri()
        return `<img src="${href}" alt="${escapeHtml(token.text ?? '')}" title="${escapeHtml(t('img.blocked'))}" class="md-img-blocked" loading="lazy">`
      }
      return `<img src="${escapeHtml(href)}"${title} alt="${escapeHtml(token.text ?? '')}" loading="lazy">`
    },
    link(token: any) {
      const text = this.parser.parseInline(token.tokens)
      const href = token.href ?? ''
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      if (/^(https?:|mailto:)/i.test(href)) {
        // External link: keeps the real href (copyable); clicks are intercepted by Viewer and handed to the system browser
        return `<a href="${escapeHtml(href)}" data-ext="${escapeHtml(href)}"${title} rel="noopener noreferrer">${text}</a>`
      }
      if (href.startsWith('#')) {
        // In-document anchor: keeps the real href (focusable, address copyable); clicks are intercepted by Viewer for smooth scrolling
        return `<a href="${escapeHtml(href)}" class="md-link-anchor" data-anchor="${escapeHtml(href)}"${title}>${text}</a>`
      }
      if (/\.(md|markdown)$/i.test(href.split('#')[0] ?? '')) {
        const abs = resolveMdHref(href.split('#')[0], baseDir)
        const anchor = href.includes('#') ? '#' + href.split('#')[1] : ''
        return `<a href="#" class="md-link" data-mdlink="${escapeHtml(abs)}" data-anchor="${escapeHtml(anchor)}"${title}>${text}</a>`
      }
      return `<a href="#" class="md-link-dead" data-dead="${escapeHtml(href)}"${title}>${text}</a>`
    }
  }

  marked.use({ gfm: true, breaks: false, renderer })

  // One lexer pass: parse and TOC reuse the same batch of tokens
  const tokens = marked.lexer(md)
  let html = String(marked.parser(tokens))
  html = sanitizeHtml(html, blockRemote, remoteAllow)
  html = postprocessAlerts(html)
  html += await buildFootnotesHtml(footnotes, blockRemote, remoteAllow)

  // TOC and sync-scroll anchors share one source: a single lexer walk produces
  // the directory and source line numbers together, pairing them 1:1. Line
  // numbers map back to the source via preprocess's lineMap; headings rewritten
  // by footnote/wikilink transforms no longer depend on src.indexOf(t.raw), and
  // insertions/deletions from footnote removal or inserted blank lines stay aligned.
  const toc: TocItem[] = []
  const anchors: SrcAnchor[] = []
  try {
    const tocSlug = makeSluger()
    let cursor = 0 // lookup cursor in the source, keeping positioning in document order
    const walk = (arr: any[]) => {
      for (const t of arr) {
        if (t.type === 'heading') {
          const plain = plainText(t.tokens ?? [])
          const id = tocSlug(plain)
          toc.push({ id, text: plain, depth: t.depth })
          const idx = t.raw ? md.indexOf(t.raw, cursor) : -1
          if (idx >= 0) {
            cursor = idx + t.raw.length
            // The raw start line is the heading line (setext-style raw includes the previous line, first line still applies)
            const mdLine = md.slice(0, idx).split('\n').length - 1
            anchors.push({ line: lineMap[mdLine] ?? mdLine, id })
          }
        }
        // Covers headings inside blockquotes and lists
        if (t.type !== 'heading' && t.tokens) walk(t.tokens)
      }
    }
    walk(tokens)
  } catch {
    /* TOC extraction failure does not block rendering */
  }

  return { html, toc, anchors, hasMath: maybeMath(md), hasMermaid: html.includes('data-mermaid') }
}

/** Renders math formulas (KaTeX auto-render; the ESM entry exports renderMathInElement directly). */
export async function renderMathIn(el: HTMLElement): Promise<void> {
  try {
    const { renderMathInElement } = await ensureKatex()
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true }
      ],
      // KaTeX default trust:false: URL commands like \href / \includegraphics do not render as clickable links.
      // Pinned explicitly so later config reuse cannot enable them and open XSS / remote probing.
      trust: false,
      throwOnError: false
    })
  } catch {
    /* silent fallback when the math library fails to load */
  }
}

let mermaidSeq = 0
let peleSeq = 0

/** Container selector for the diagram card body. */
function srcHolder(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.md-diagram-src')
}

/** done + engine double marker: skips when already done with the same engine, re-renders on engine mismatch. */
const isDoneBy = (b: HTMLElement, e: MermaidEngine) =>
  b.dataset.done === '1' && (b.dataset.engine ?? 'mermaid') === e

/** decodeURIComponent throws on bare % in the source; keeping it as-is is fine. */
function decodeDiagramSource(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Mermaid.js branch: async render; theme switches require a re-render. */
async function renderMermaidBlocks(blocks: HTMLElement[], dark: boolean): Promise<void> {
  try {
    const mermaid = await ensureMermaid()
    if (!mermaid) throw new Error('mermaid unavailable')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    for (const block of blocks) {
      if (isDoneBy(block, 'mermaid')) continue
      const code = decodeDiagramSource(block.dataset.mermaid ?? '')
      const holder = srcHolder(block)
      if (!holder) continue
      block.dataset.engine = 'mermaid'
      try {
        const id = `mdv-mm-${++mermaidSeq}`
        const res = await mermaid.render(id, code)
        holder.innerHTML = sanitizeMermaidSvg(res.svg)
        block.dataset.done = '1'
        block.classList.add('ok')
        block.classList.remove('err')
      } catch {
        holder.innerHTML =
          `<div class="md-diagram-hint"><div class="md-diagram-hint-text">${escapeHtml(t('diag.mermaidErr'))}</div>` +
          `<pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
        block.dataset.done = '1'
        block.classList.add('err')
        block.classList.remove('ok')
      }
    }
  } catch {
    for (const b of blocks) {
      if (isDoneBy(b, 'mermaid')) continue
      const h = srcHolder(b)
      if (h) h.textContent = t('diag.mermaidLoadFailed')
      b.dataset.done = '1'
    }
  }
}

/** Pele branch: synchronous render, theme via CSS variables; falls back to the classic engine on load failure. */
async function renderPeleBlocks(blocks: HTMLElement[], el: HTMLElement, dark: boolean): Promise<void> {
  let pele: any = null
  try {
    pele = await ensurePele()
  } catch {
    console.warn('[mdview] Pele unavailable, falling back to Mermaid.js')
  }
  if (!pele) {
    await renderMermaidBlocks(blocks, dark)
    return
  }
  // render() has no container to read from, so the label font explicitly follows the body
  const fontFamily = getComputedStyle(el).fontFamily || 'sans-serif'
  for (const block of blocks) {
    if (isDoneBy(block, 'pele')) continue
    const holder = srcHolder(block)
    if (!holder) continue
    block.dataset.engine = 'pele'
    const code = decodeDiagramSource(block.dataset.mermaid ?? '')
    try {
      // Offline promise: links and images disabled (Pele allows http(s) by default, must be turned off explicitly)
      const res = pele.render(code, {
        fontFamily,
        idPrefix: `mdv-pele-${++peleSeq}`,
        links: false,
        images: false
      })
      if (!res || typeof res.svg !== 'string') throw new Error('pele returned no svg')
      holder.innerHTML = sanitizePeleSvg(res.svg)
      block.dataset.done = '1'
      block.classList.add('ok')
      block.classList.remove('err')
    } catch (e) {
      // PeleError's message/snippet embed the diagram source: escapeHtml, equivalent to textContent
      const msg = e instanceof Error ? escapeHtml(e.message) : ''
      holder.innerHTML =
        `<div class="md-diagram-hint"><div class="md-diagram-hint-text">${escapeHtml(t('diag.mermaidErr'))}` +
        (msg ? ` <code>${msg}</code>` : '') +
        `</div><pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
      block.dataset.done = '1'
      block.classList.add('err')
      block.classList.remove('ok')
    }
  }
}

/**
 * Renders the diagram cards in the page: Mermaid / Pele produce SVG, inline SVG
 * is inserted directly. force=true re-renders after a theme or engine switch;
 * Pele blocks skip re-rendering via CSS variables.
 */
export async function renderDiagramsIn(
  el: HTMLElement,
  dark: boolean,
  force = false,
  engine: MermaidEngine = 'pele'
): Promise<void> {
  const blocks = el.querySelectorAll<HTMLElement>('[data-mermaid],[data-svg]')
  if (!blocks.length) return
  // The card-head select mirrors the global setting: switches in the settings page sync in on re-render
  el.querySelectorAll<HTMLSelectElement>('select[data-mm-engine]').forEach((sel) => {
    sel.value = engine
  })
  if (force) {
    blocks.forEach((b) => {
      // Inline SVG and Mermaid.js need a re-render to recolor; Pele keeps its done marker, colors switch instantly via CSS variables
      if (b.hasAttribute('data-svg') || (engine === 'mermaid' && isDoneBy(b, 'mermaid'))) {
        delete b.dataset.done
        delete b.dataset.engine
        b.classList.remove('ok', 'err')
      }
    })
  }

  // Inline SVG: no external library needed, inserted directly (invalid content degrades to a source hint)
  for (const block of Array.from(el.querySelectorAll<HTMLElement>('[data-svg]'))) {
    if (block.dataset.done === '1') continue
    const holder = srcHolder(block)
    if (!holder) continue
    const code = decodeDiagramSource(block.dataset.svg ?? '')
    const safe = sanitizeSvg(code)
    if (/<svg[\s>]/i.test(safe)) {
      holder.innerHTML = safe
      block.classList.add('ok')
    } else {
      holder.innerHTML =
        `<div class="md-diagram-hint"><div class="md-diagram-hint-text">${escapeHtml(t('diag.svgErr'))}</div>` +
        `<pre class="md-diagram-src-code">${escapeHtml(code)}</pre></div>`
      block.classList.add('err')
    }
    block.dataset.done = '1'
  }

  const mmBlocks = Array.from(el.querySelectorAll<HTMLElement>('[data-mermaid]'))
  if (!mmBlocks.length) return
  if (engine === 'pele') {
    await renderPeleBlocks(mmBlocks, el, dark)
    return
  }
  await renderMermaidBlocks(mmBlocks, dark)
}
