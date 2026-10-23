/**
 * 字数 / 行数统计（借鉴 mdeditor 的 word-count：纯函数，不依赖 DOM/组件实例）。
 *  - countStats: 源码口径（chars 含 Markdown 标记与空白，lines 按 \n 切分，空内容记 0）
 *  - countPreviewText: 预览口径，遍历渲染后 DOM 的文本节点，只算读者真正看得见的字
 */

export interface CountStats {
  chars: number
  lines: number
  words: number
}

export function countStats(content: string | null | undefined): CountStats {
  const text = (content || '')
    .replace(/[#*`~\[\]()>_|\\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    words: text ? text.split(/\s+/).length : 0,
    chars: (content || '').length,
    lines: content ? content.split('\n').length : 0
  }
}

/** 跳过脚本/样式、隐藏的 KaTeX MathML、图形内部文字与 UI 按钮等非正文节点。 */
const SKIP_CLASS = ['katex-mathml', 'copy-btn', 'code-line-num', 'md-diagram-src', 'mm-toolbar']

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
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return
    if (el.hidden) return
    const cls = el.classList
    if (cls && SKIP_CLASS.some((c) => cls.contains(c))) return
    const style = el.style
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  walk(root)
  return count
}
