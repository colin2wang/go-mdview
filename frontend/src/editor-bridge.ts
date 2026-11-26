/**
 * 源码编辑器实例桥。
 * 目录跳转（TocPanel）、状态栏等模块需要按行定位源码，但它们与 Viewer 没有父子关系，
 * 用一个模块级句柄共享当前唯一的 CodeMirror 实例（同时只会存在一个源码编辑器）。
 */
export const srcEditor: { cm: CodeMirror.Editor | null } = { cm: null }

export function setSrcEditor(cm: CodeMirror.Editor | null): void {
  srcEditor.cm = cm
}

/** 源码里所有 Markdown 标题行的行号（0-based），顺序与目录一致。 */
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

/** 与 .md-article 内标题的 scroll-margin-top 保持一致（style-md.css）。 */
export const SCROLL_ALIGN = 24

export function srcScroller(): HTMLElement | null {
  return srcEditor.cm?.getScrollerElement() ?? null
}

/**
 * 像素级源码滚动。入参为**滚动位置**（SCROLL_ALIGN 已在 sync.ts 内消化）；
 * 返回写入的 top 与是否被钳位（钳位 = 映射目标超出源码最大滚动，调用方可据此自愈）。
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

/** 把第 line 行（0-based）滚到源码视口顶部。 */
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
