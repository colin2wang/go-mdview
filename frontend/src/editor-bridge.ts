/**
 * Bridge to the source editor instance. The TOC panel, status bar and other
 * modules need line-level access to the source, but are not children of
 * Viewer; this module-level handle shares the single CodeMirror instance
 * (only one source editor exists at a time).
 */
export const srcEditor: { cm: CodeMirror.Editor | null } = { cm: null }

export function setSrcEditor(cm: CodeMirror.Editor | null): void {
  srcEditor.cm = cm
}

/** Line numbers (0-based) of all Markdown heading lines in the source, in TOC order. */
export function srcHeadingLines(): number[] {
  const cm = srcEditor.cm
  if (!cm) return []
  const out: number[] = []
  let inFence = false
  let fenceMark = ''
  for (let i = 0; i < cm.lineCount(); i++) {
    const line = cm.getLine(i) ?? ''
    const fm = /^\s*(```|~~~)/.exec(line)
    if (fm) {
      if (!inFence) {
        inFence = true
        fenceMark = fm[1]
      } else if (line.trim().startsWith(fenceMark)) {
        inFence = false
      }
      continue
    }
    if (!inFence && /^\s{0,3}#{1,6}(\s|$)/.test(line)) out.push(i)
  }
  return out
}

/** Matches the scroll-margin-top of headings inside .md-article (style-md.css). */
export const SCROLL_ALIGN = 24

export function srcScroller(): HTMLElement | null {
  return srcEditor.cm?.getScrollerElement() ?? null
}

/**
 * Pixel-level source scrolling. The argument is a scroll position
 * (SCROLL_ALIGN is already absorbed inside sync.ts); returns the written top
 * and whether it was clamped (the mapped target exceeded the maximum source
 * scroll, callers can use this for self-healing).
 */
export function scrollSrcToPx(px: number): { top: number; clamped: boolean } {
  const sc = srcScroller()
  if (!sc) return { top: 0, clamped: false }
  const max = Math.max(0, sc.scrollHeight - sc.clientHeight)
  const top = Math.max(0, Math.min(px, max))
  if (Math.abs(sc.scrollTop - top) > 400) {
    sc.scrollTo({ top, behavior: 'smooth' })
  } else {
    sc.scrollTo(0, top)
  }
  return { top, clamped: px > max + 1 }
}

/** Scrolls line (0-based) to the top of the source viewport. */
export function scrollSrcToLine(line: number, smooth = false): void {
  const cm = srcEditor.cm
  if (!cm) return
  const max = Math.max(0, cm.lineCount() - 1)
  const top = cm.heightAtLine(Math.max(0, Math.min(line, max)), 'local')
  if (smooth) {
    const sc = cm.getScrollerElement()
    if (sc) sc.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
  } else {
    cm.scrollTo(0, Math.max(0, top - 8))
  }
}
