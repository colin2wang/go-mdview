import type { MermaidEngine, TocItem } from './types'
import { ensureHljs, ensureKatex, ensurePele, freshMarked, maybeMath, loadScript } from './vendor'
import { t } from './i18n'
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
 * Markdown 渲染管线（样式对齐 mdview demo）：
 * 预处理（脚注/mark/wikilink，围栏感知）→ marked 自定义渲染
 * （标题锚点/代码高亮+语言标签+复制/图片本地回放/链接分类）→ GFM Alert 后处理。
 */

export interface RenderResult {
  html: string
  toc: TocItem[]
  /** 与 toc 同源的同步滚动锚点：标题的源码行号（0 基，按 preprocess 前的原文计）。 */
  anchors: SrcAnchor[]
  hasMath: boolean
  hasMermaid: boolean
}

/** 同步滚动锚点：id 与渲染 DOM 的标题 id 一致。 */
export interface SrcAnchor {
  line: number
  id: string
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 远程资源被拦截时显示的占位图（data URI，本地生成不外发请求）。
 *  每次渲染时生成，保证语言切换后拦截文案即时跟随当前语言。 */
function blockedImgUri(): string {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="28"><rect width="120" height="28" rx="4" fill="#f0f0f0"/><text x="60" y="18" font-size="11" text-anchor="middle" fill="#999">🚫 ${t('img.blocked')}</text></svg>`
    )
  )
}

/** 当前拦截判断是否放行该地址：开关未开、不是远程、或命中白名单。 */
function remotePasses(href: string, blockRemote: boolean, remoteAllow: string): boolean {
  return !blockRemote || !isRemoteSrc(href) || remoteAllowedByPattern(href, remoteAllow)
}

// ---------- 原始 HTML 清洗（防 XSS）----------
// marked 会原样放行 md 里的 HTML token；来源不明的 .md 可能携带脚本。
// 字符串级正则黑名单对抗不了 HTML 解析器（实体解码、formaction、<meta>/<base>
// 等向量都能绕过），必须走真实 DOM 解析的 DOMPurify（随构建打包，运行时离线）。
// 禁 style 标签/属性：既防 url() 外发探测，也与「100% 离线」承诺一致。
// hook（远程 URL 属性覆盖、良性 button/checkbox 保留）在 sanitize-common.js
// 中与 scripts/sanitize-check.mjs 共用同一份实现，配置来自 sanitize-config.json。

/** 统一 HTML 净化出口：脚注、异常兜底、导出二次净化都走这里。 */
export function sanitizeHtml(html: string, blockRemote = true, remoteAllow = ''): string {
  const state = createState(blockRemote, remoteAllow, blockedImgUri, t('img.blocked'))
  return sanitizeWith(DOMPurify, parts, html, state)
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
  // 浏览器/Mock 模式：无 /mdimg 回放路由，本地图片用内置示例图兜底。
  // v3 运行时挂载 window._wails（v2 的 window.go 已不存在），与 api.ts 的 isDesktop 保持一致。
  if (typeof window === 'undefined' || window._wails === undefined) {
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

export interface PreprocessResult {
  md: string
  footnotes: Footnote[]
  usedFns: Map<string, number>
  /** 输出行 → 原始行号（preprocess 前的 src），供 TOC 锚点精确回映射。 */
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

  // 行内变换只作用于普通文本段：跳过行内代码（`...`）与 HTML 注释，
  // 否则 `[[x]]` / `[^1]` / `==mark==` 会把代码片段也改写掉。
  const wikiLink = (m0: string, raw: string): string => {
    const label = raw.trim()
    const [targetRaw, alias] = label.split('|').map((s) => s.trim())
    const hashAt = targetRaw.indexOf('#')
    const target = hashAt >= 0 ? targetRaw.slice(0, hashAt) : targetRaw
    const anchor = hashAt >= 0 ? targetRaw.slice(hashAt + 1) : ''
    const base = target.split(/[\\/]/).pop() || target
    const display = alias || base
    // Obsidian 嵌入语法 ![[file]]：图片类文件转成标准 Markdown 图片，走 /mdimg 回放
    if (m0.startsWith('!')) {
      const ext = (target.split('.').pop() ?? '').toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) {
        return `![${escapeHtml(display)}](${encodeURI(target)})`
      }
      // 非图片嵌入（如 md 转录）降级为 wiki 链接，去掉多余的 !
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
      // `---` 紧跟段落行是 setext 二级标题语法，但多数人本意是分隔线；
      // 补一个空行让它按 <hr> 渲染，段落保持正常显示
      if (/^\s*-{3,}\s*$/.test(line)) {
        const prev = out[out.length - 1]
        if (prev !== undefined && prev.trim() !== '' && !/^\s*-{3,}\s*$/.test(prev) && !/^\s*>/.test(prev)) {
          out.push('')
          lineMap.push(lineNo)
        }
      }
      // GFM Alert：标记行后补空引号行，防止 marked 把 [!NOTE] 与正文懒续行合成同一段
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
        continue // 脚注定义从正文摘除
      }
      out.push(transformLine(line))
    } else {
      out.push(line)
    }
    lineMap.push(lineNo)
  }

  const footnotes: Footnote[] = []
  let num = 0
  for (const id of order) {
    if (!used.has(id)) continue // 未被引用的定义不进文末
    num++
    footnotes.push({ id, num: used.get(id)!, content: defs.get(id) ?? '' })
  }
  return { md: out.join('\n'), footnotes, usedFns: used, lineMap }
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
      // 脚注区在整段 sanitize 之后追加，必须在此单独净化，否则 <img onerror> /
      // <style>url(...)</style> / <svg onload> 会直达 v-html 绕过整套 sanitizer。
      inner = sanitizeHtml(inner, blockRemote, remoteAllow)
      if (/^<p>[\s\S]*<\/p>$/.test(inner) && (inner.match(/<p>/g) ?? []).length === 1) {
        inner = inner.slice(3, -4)
      }
      return `<li id="fn-${escapeHtml(f.id)}" class="md-fn-item">${inner}<a href="#fnref-${escapeHtml(f.id)}" class="md-fn-backlink" title="${escapeHtml(t('fn.back'))}">↩</a></li>`
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

function diagTitle(kind: string): string {
  return kind === 'mermaid' ? t('diag.mermaid') : t('diag.svg')
}

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

/** 内联 SVG 清洗：走 DOMPurify 真实 DOM 解析，去掉脚本、foreignObject、
 * 事件/危险属性与远程引用（含 data:，外链 image/xlink:href 会外发请求，违反离线承诺）。
 * allowStyle=true 供 Mermaid 保留主题 <style>，但由 sanitizeMermaidSvg 去掉含 url() 的样式。 */
export function sanitizeSvg(code: string, allowStyle = false): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(DOMPurify, parts, stripSvgExternalRefs(code), state, svgConfig(parts, allowStyle))
  return normalizeSvgRoot(clean)
}

/** Mermaid 输出二次净化：保留本地主题样式（剥掉含 url() 的 <style>），
 * 放行 foreignObject（htmlLabels 的节点文字载体，见 mermaidSvgConfig）。 */
export function sanitizeMermaidSvg(code: string): string {
  const state = createState(true, '', () => '', '')
  const clean = sanitizeWith(DOMPurify, parts, stripSvgExternalRefs(code), state, mermaidSvgConfig(parts))
  try {
    // 用 HTML 解析而非 image/svg+xml：foreignObject 里保留了 div/br 等 HTML
    // 标签，XML 严格语法会解析失败；HTML 序列化结果回灌 innerHTML 语义一致。
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

/** Pele 输出二次净化：Pele 已按白名单过滤内联 style，放行它以保留 classDef 配色。 */
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
    `<span class="md-diagram-title">${escapeHtml(diagTitle(kind))}</span>` +
    `<span class="md-diagram-tools">` +
    `<span class="md-diagram-meta">${escapeHtml(label)}</span>` +
    `<button type="button" class="md-diagram-btn" data-toggle-src title="${escapeHtml(t('diag.viewSrc'))}">${escapeHtml(t('diag.src'))}</button>` +
    `<button type="button" class="md-diagram-btn" data-copy title="${escapeHtml(t('diag.copySrc'))}">${COPY_ICON}</button>` +
    `</span>` +
    `</div>` +
    `<div class="md-diagram-body"><div class="md-diagram-src">` +
    (kind === 'svg' ? sanitizeSvg(code) : escapeHtml(t('diag.rendering'))) +
    `</div></div>` +
    `<pre class="md-diagram-code"><code>${escapeHtml(code)}</code></pre>` +
    `</div>\n`
  )
}

// ---------- 主渲染 ----------

// ---------- 块级源码行号注入（同步滚动 data-sl） ----------
let slMd = ''
let slCursor = 0
let slLineMap: number[] = []

/** marked.parse 前调用：跟踪预处理文本与行映射（与现有锚点生成同源） */
function beginSlTracking(md: string, lineMap: number[]): void {
  slMd = md
  slCursor = 0
  slLineMap = lineMap
}

/** token 原文 → 原文件行号（游标法 + lineMap 回映射预处理前行号） */
function tokenSrcLine(raw: string): number {
  if (!raw) return -1
  const i = slMd.indexOf(raw, slCursor)
  if (i < 0) return -1
  slCursor = i + raw.length
  const pre = slMd.slice(0, i).split('\n').length - 1
  return slLineMap[pre] ?? pre
}

/** 块级 HTML 注入 data-sl="原文件行号"；找不到原文时原样返回 */
function withSl(html: string, raw: string): string {
  const line = tokenSrcLine(raw)
  if (line < 0) return html
  return html.replace(/^<([a-zA-Z][\w-]*)/, `<$1 data-sl="${line}"`)
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
  beginSlTracking(md, lineMap)

  const renderer: any = {
    heading(token: any) {
      const text = this.parser.parseInline(token.tokens)
      const plain = plainText(token.tokens)
      const id = slug(plain)
      return withSl(`<h${token.depth} id="${id}">${text}</h${token.depth}>\n`, token.raw)
    },
    code(token: any) {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
      const text = token.text ?? ''
      // mermaid / svg 走图形卡片（可切源码），其余走代码块卡片
      const kind = diagramKindOf(lang, text)
      if (kind) return withSl(diagramCard(kind, lang || kind, text), token.raw)

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
      return withSl(
        `<div class="code-block${lang ? ' has-lang' : ''}">` +
          `<div class="code-head">` +
          `<span class="code-lang">${lang ? escapeHtml(lang) : 'text'}</span>` +
          `<span class="code-tools">` +
          `<button type="button" class="code-copy" data-copy title="${escapeHtml(t('code.copy.tip'))}">${COPY_ICON}</button>` +
          `</span>` +
          `</div>` +
          `<pre><code${cls}>${body}</code></pre></div>\n`,
        token.raw
      )
    },
    paragraph(token: any) {
      // marked v15 默认输出（defaults.renderer 在 use 前为 null，只能内联实现）
      return withSl(`<p>${this.parser.parseInline(token.tokens)}</p>\n`, token.raw)
    },
    blockquote(token: any) {
      return withSl(`<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`, token.raw)
    },
    table(token: any) {
      // 复刻 marked v15 默认 table renderer：header/tbody + 对齐属性
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
      return withSl(html, token.raw)
    },
    image(token: any) {
      let href = resolveImgHref(token.href ?? '', baseDir)
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      // 远程资源拦截（默认开）：不外发请求，用本地占位图代替；命中白名单的放行
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
        // 外链：保留真实 href（可复制），点击由 Viewer 拦截后交给系统默认浏览器
        return `<a href="${escapeHtml(href)}" data-ext="${escapeHtml(href)}"${title} rel="noopener noreferrer">${text}</a>`
      }
      if (href.startsWith('#')) {
        // 文内锚点：保留真实 href（可聚焦、可复制地址），点击统一由 Viewer 拦截后平滑滚动。
        // 不要用 javascript:void(0)：DOMPurify 会删掉该 href，链接退化成没有目标的 <a>。
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

  // 解析一次，parse 与 TOC 复用同一批 tokens（旧实现 lexer 跑两遍）
  const tokens = marked.lexer(md)
  let html = String(marked.parser(tokens))
  html = sanitizeHtml(html, blockRemote, remoteAllow)
  html = postprocessAlerts(html)
  html += await buildFootnotesHtml(footnotes, blockRemote, remoteAllow)

  // TOC 与同步滚动锚点同源：同一次 lexer 遍历同时产出目录与源码行号，天然 1:1 配对。
  // 行号经 preprocess 的 lineMap 映射回原文；标题含脚注/wikilink 被改写时也不再依赖
  // src.indexOf(t.raw)，摘脚注定义/补空行造成的增删同样不会错位。
  const toc: TocItem[] = []
  const anchors: SrcAnchor[] = []
  try {
    const tocSlug = makeSluger()
    let cursor = 0 // 在原文中的查找游标，保证按文档顺序定位
    const walk = (arr: any[]) => {
      for (const t of arr) {
        if (t.type === 'heading') {
          const plain = plainText(t.tokens ?? [])
          const id = tocSlug(plain)
          toc.push({ id, text: plain, depth: t.depth })
          const idx = t.raw ? md.indexOf(t.raw, cursor) : -1
          if (idx >= 0) {
            cursor = idx + t.raw.length
            // raw 起始行即标题行（setext 样式 raw 含上一行，同样取首行）
            const mdLine = md.slice(0, idx).split('\n').length - 1
            anchors.push({ line: lineMap[mdLine] ?? mdLine, id })
          }
        }
        // 覆盖引用块/列表内标题
        if (t.type !== 'heading' && t.tokens) walk(t.tokens)
      }
    }
    walk(tokens)
  } catch {
    /* TOC 提取失败不阻塞渲染 */
  }

  return { html, toc, anchors, hasMath: maybeMath(md), hasMermaid: html.includes('data-mermaid') }
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
let peleSeq = 0

/** 图形卡片正文的容器选择器。 */
function srcHolder(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.md-diagram-src')
}

/** done + engine 双标记：同引擎已完成则跳过；引擎不符时自动重绘。 */
const isDoneBy = (b: HTMLElement, e: MermaidEngine) =>
  b.dataset.done === '1' && (b.dataset.engine ?? 'mermaid') === e

/** 源码里带裸 % 时 decodeURIComponent 会抛错，保留原样即可。 */
function decodeDiagramSource(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Mermaid.js 分支：异步 render，主题切换必须重绘。 */
async function renderMermaidBlocks(blocks: HTMLElement[], dark: boolean): Promise<void> {
  try {
    await loadScript('/static/mermaid.min.js')
    const mermaid = (window as any).mermaid
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

/** Pele 分支：同步 render、CSS 变量切主题；加载失败时回退经典引擎。 */
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
  // render() 没有容器可读，标签字体显式跟随正文
  const fontFamily = getComputedStyle(el).fontFamily || 'sans-serif'
  for (const block of blocks) {
    if (isDoneBy(block, 'pele')) continue
    const holder = srcHolder(block)
    if (!holder) continue
    block.dataset.engine = 'pele'
    const code = decodeDiagramSource(block.dataset.mermaid ?? '')
    try {
      // 离线承诺：禁链接禁图片（Pele 默认放行 http(s)，必须显式关掉）
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
      // PeleError 的 message/snippet 含图源码：走 escapeHtml，等价 textContent
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
 * 渲染页面中的图形卡片：Mermaid / Pele 出 SVG、内联 SVG 直接落地。
 * force=true 用于主题或引擎切换后的重绘；Pele 块靠 CSS 变量免重绘。
 */
export async function renderDiagramsIn(
  el: HTMLElement,
  dark: boolean,
  force = false,
  engine: MermaidEngine = 'mermaid'
): Promise<void> {
  const blocks = el.querySelectorAll<HTMLElement>('[data-mermaid],[data-svg]')
  if (!blocks.length) return
  if (force) {
    blocks.forEach((b) => {
      // 内联 SVG 与 Mermaid.js 要换色重绘；Pele 保留 done 标记，颜色随 CSS 变量即时切换
      if (b.hasAttribute('data-svg') || (engine === 'mermaid' && isDoneBy(b, 'mermaid'))) {
        delete b.dataset.done
        delete b.dataset.engine
        b.classList.remove('ok', 'err')
      }
    })
  }

  // 内联 SVG：不需要外部库，直接落地（失败/非法内容降级为源码提示）
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
