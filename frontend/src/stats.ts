/**
 * Word and line counting (pure functions, no DOM or component dependencies).
 *  - countStats: source-side view (chars include Markdown markup and whitespace,
 *    lines are split on \n, empty content counts as 0)
 *  - countPreviewText: preview-side view, walks text nodes of the rendered DOM
 *    and counts only characters a reader actually sees
 */

export interface CountStats {
  chars: number
  lines: number
  words: number
}

export function countStats(content: string | null | undefined): CountStats {
  const text = (content || '')
    .replace(/[#*`~[\]()>_|\\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const cjk = (text.match(/[⺀-鿿]/g) ?? []).length
  const latin = text.replace(/[⺀-鿿]/g, ' ').trim()
  return {
    words: cjk + (latin ? latin.split(/\s+/).length : 0),
    chars: (content || '').length,
    lines: content ? content.split('\n').length : 0
  }
}

/** Element classes excluded from preview counting: scripts/styles, hidden KaTeX MathML, diagram internals, UI buttons. */
const SKIP_CLASS = ['katex-mathml', 'copy-btn', 'code-copy', 'code-line-num', 'md-diagram-src', 'md-diagram-code', 'mm-toolbar', 'hidden']

export function countPreviewText(root: Node | null | undefined): number {
  if (!root) return 0
  let count = 0
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      count += (node.textContent || '').length
      return
    }
    if (node.nodeType !== 1) return
    const el = node as HTMLElement
    const tag = (el.tagName || '').toLowerCase()
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg' || tag === 'button' || tag === 'input') return
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return
    const cls = el.classList
    if (cls && SKIP_CLASS.some((c) => cls.contains(c))) return
    const style = el.style
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  walk(root)
  return count
}
