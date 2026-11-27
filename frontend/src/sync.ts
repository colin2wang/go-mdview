/**
 * Sync-scroll engine v2: the alignment-point table "marks" is the single
 * source of truth.
 *   each point = { y: render-side scroll position, s: source-side scroll
 *   position, line: source line number, id?: heading anchor id }
 * Anchors store scroll positions (not content coordinates); the endpoints are
 * fixed at (0,0) and (R,S) — scrolling either side to the bottom mirrors the
 * other exactly, so clamping and mapping share the same semantics.
 * Piecewise-linear interpolation inside segments, extrapolation beyond the
 * endpoints; after any asynchronous layout change call invalidateSync(), and
 * Viewer's ensureMarks rebuilds via rebuildSync before the next scroll.
 */
import { SCROLL_ALIGN } from './editor-bridge'
import type { SrcAnchor } from './markdown'

export interface SyncPoint {
  y: number
  s: number
  line: number
  id?: string
}

export type RebuildResult = 'ok' | 'ok-fixed' | 'stale'

let marks: SyncPoint[] = []
let dirty = true
let valid = false
let dropped = 0

/** Must be called after layout may have changed (image load, Mermaid/KaTeX completion, wrap/font-size/split changes). */
export function invalidateSync(): void {
  dirty = true
}
export function isSyncDirty(): boolean {
  return dirty
}
export function hasSyncMarks(): boolean {
  return valid && marks.length > 1
}
export function resetSyncState(): void {
  marks = []
  dirty = true
  valid = false
}

function cmHeightAt(cm: CodeMirror.Editor, line: number): number {
  const max = Math.max(0, cm.lineCount() - 1)
  return cm.heightAtLine(Math.max(0, Math.min(line, max)), 'local')
}

/** Source geometry check: heightAtLine's document bottom must match scroller.scrollHeight.
 *  CM5 estimates unmeasured lines with an estimated line height, and the
 *  estimate drifts after font loading or wrap changes; drift is what makes
 *  render→source mapping clamp prematurely to the bottom. */
export function sourceGeometrySuspicious(cm: CodeMirror.Editor, srcSc: HTMLElement | null): boolean {
  if (!srcSc) return true
  const total = srcSc.scrollHeight
  const bottom = cmHeightAt(cm, Math.max(0, cm.lineCount() - 1))
  if (total <= 0 || bottom > total) return true
  return total - bottom > Math.max(240, cm.defaultTextHeight() * 12)
}

export function rebuildSync(
  article: HTMLElement,
  sc: HTMLElement,
  cm: CodeMirror.Editor,
  anchors: SrcAnchor[]
): RebuildResult {
  const srcSc = cm.getScrollerElement() ?? null
  if (sourceGeometrySuspicious(cm, srcSc)) {
    valid = false
    return 'stale'
  }
  const R = Math.max(0, sc.scrollHeight - sc.clientHeight)
  const S = Math.max(0, srcSc.scrollHeight - srcSc.clientHeight)
  const scTop = sc.getBoundingClientRect().top - sc.scrollTop
  const raw: SyncPoint[] = []
  const push = (line: number, contentY: number, id?: string) => {
    if (!Number.isFinite(contentY)) return
    const r = contentY - SCROLL_ALIGN
    if (r <= 2 || r >= R - 2) return
    const s0 = cmHeightAt(cm, line) - SCROLL_ALIGN
    raw.push({ y: r, s: Math.max(0, Math.min(s0, S)), line, id })
  }
  for (const el of Array.from(article.querySelectorAll<HTMLElement>('[data-sl]'))) {
    const line = Number(el.dataset.sl)
    if (Number.isFinite(line)) push(line, el.getBoundingClientRect().top - scTop)
  }
  // Heading anchors as fallback (alignment still works when block anchors are missing), carrying id for TOC highlighting
  for (const a of anchors) {
    const el = article.querySelector<HTMLElement>(`[id="${CSS.escape(a.id)}"]`)
    if (el) push(a.line, el.getBoundingClientRect().top - scTop, a.id)
  }
  raw.sort((p, q) => p.y - q.y)
  // Monotonicity filter: scrolling is monotonic, so s must increase with y; out-of-order points are line-mapping drift
  const pts: SyncPoint[] = []
  dropped = 0
  for (const p of raw) {
    const last = pts[pts.length - 1]
    if (last && p.y - last.y < 4) continue
    if (last && p.s <= last.s + 1) {
      dropped++
      continue
    }
    pts.push(p)
  }
  marks = [
    { y: 0, s: 0, line: 0 },
    ...pts,
    { y: R, s: S, line: Number.MAX_SAFE_INTEGER }
  ]
  valid = true
  dirty = false
  return dropped ? 'ok-fixed' : 'ok'
}

/** Pure function (unit-testable): piecewise-linear interpolation with endpoint extrapolation and degenerate-segment damping. */
export function interpIn(pts: SyncPoint[], pos: number, key: 'y' | 's', o: 'y' | 's'): number | null {
  const n = pts.length
  if (n < 2) return null
  const seg = (i: number, j: number): number => {
    const d = pts[j][key] - pts[i][key]
    if (d <= 0.5) return pts[i][o]
    return pts[i][o] + ((pos - pts[i][key]) / d) * (pts[j][o] - pts[i][o])
  }
  if (pos <= pts[1][key]) return seg(0, 1)
  if (pos >= pts[n - 2][key]) return seg(n - 2, n - 1)
  for (let i = 1; i < n - 2; i++) if (pos <= pts[i + 1][key]) return seg(i, i + 1)
  return pts[n - 2][o]
}

/** Both argument and result are scroll positions */
export function renderToSource(r: number): number | null {
  return interpIn(marks, r, 'y', 's')
}
export function sourceToRender(s: number): number | null {
  return interpIn(marks, s, 's', 'y')
}

/** TOC highlighting and sync scrolling share the same active-heading detection (argument is a scroll position). */
export function activeHeadingId(scroller: HTMLElement): string | null {
  const line = scroller.scrollTop + 96
  let hit: string | null = null
  for (const m of marks) {
    if (m.y > line) break
    if (m.id) hit = m.id
  }
  return hit
}

/** Diagnostics outlet (mounted as window.__syncDiag in dev) */
export function syncDiagnostics(sc: HTMLElement | null, cm: CodeMirror.Editor | null) {
  const srcSc = cm?.getScrollerElement() ?? null
  return {
    valid,
    dirty,
    points: marks.length,
    dropped,
    renderMax: sc ? sc.scrollHeight - sc.clientHeight : null,
    sourceMax: srcSc ? srcSc.scrollHeight - srcSc.clientHeight : null,
    sourceContentBottom: cm ? cmHeightAt(cm, Math.max(0, cm.lineCount() - 1)) : null,
    first: marks[1] ?? null,
    last: marks[marks.length - 2] ?? null
  }
}
