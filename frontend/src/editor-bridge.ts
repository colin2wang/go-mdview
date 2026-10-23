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
  for (let i = 0; i < cm.lineCount(); i++) {
    if (/^\s{0,3}#{1,6}(\s|$)/.test(cm.getLine(i) ?? '')) out.push(i)
  }
  return out
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
