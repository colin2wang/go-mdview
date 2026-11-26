/**
 * 同步滚动引擎 v2：以「对齐点表 marks」为唯一事实来源。
 *   每点 = { y: 渲染侧滚动位置, s: 源码侧滚动位置, line: 源码行号, id?: 标题锚点id }
 * 与 v1（内容坐标）不同，锚点直接存**滚动位置**，端点固定 (0,0) 与 (R,S)——
 * 两侧滚到底必然互为镜像，钳位语义与映射语义一致，源码刻度漂移不再表现为
 * 「渲染→源码提前钉底」。
 * 段内线性插值、段外端点外推；任何异步布局变化后 invalidateSync()，
 * 下一次滚动前由 Viewer 的 ensureMarks 调 rebuildSync 重建。
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

/** 布局可能变化后必须调用（图片 load、Mermaid/KaTeX 完成、换行/字号/分栏变化） */
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

/** 源码几何校准：heightAtLine 的文档底必须与 scroller.scrollHeight 吻合。
 *  CM5 未测量行用估算行高、字体加载/换行切换后估算会整体漂移——漂移
 *  正是「渲染→源码被钳位提前到底」的元凶。 */
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
    if (r <= 2 || r >= R - 2) return // 顶部/底部由端点覆盖
    const s0 = cmHeightAt(cm, line) - SCROLL_ALIGN
    raw.push({ y: r, s: Math.max(0, Math.min(s0, S)), line, id })
  }
  // 1) 块级锚点：data-sl（段落级精度，DOM 顺序即文档顺序）
  // Array.from：项目 tsconfig 未开 downlevelIteration，NodeListOf 不能直接 for-of
  for (const el of Array.from(article.querySelectorAll<HTMLElement>('[data-sl]'))) {
    const line = Number(el.dataset.sl)
    if (Number.isFinite(line)) push(line, el.getBoundingClientRect().top - scTop)
  }
  // 2) 标题锚点兜底（块级缺失时仍可对齐），携带 id 供 TOC 高亮共用
  for (const a of anchors) {
    const el = article.querySelector<HTMLElement>(`[id="${CSS.escape(a.id)}"]`)
    if (el) push(a.line, el.getBoundingClientRect().top - scTop, a.id)
  }
  raw.sort((p, q) => p.y - q.y)
  // 3) 单调性过滤：滚动单调 ⇒ s 必须随 y 递增；乱序点 = 行号映射漂移，剔除
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
    { y: R, s: S, line: Number.MAX_SAFE_INTEGER } // 两端同时到底
  ]
  valid = true
  dirty = false
  return dropped ? 'ok-fixed' : 'ok'
}

/** 纯函数（便于单测）：分段线性插值，端点外推、退化段防抖。 */
export function interpIn(pts: SyncPoint[], pos: number, key: 'y' | 's', o: 'y' | 's'): number | null {
  const n = pts.length
  if (n < 2) return null
  const seg = (i: number, j: number): number => {
    const d = pts[j][key] - pts[i][key]
    if (d <= 0.5) return pts[i][o] // 退化段：保持上一点，防抖动
    return pts[i][o] + ((pos - pts[i][key]) / d) * (pts[j][o] - pts[i][o])
  }
  if (pos <= pts[1][key]) return seg(0, 1) // 首段外推
  if (pos >= pts[n - 2][key]) return seg(n - 2, n - 1) // 尾段外推
  for (let i = 1; i < n - 2; i++) if (pos <= pts[i + 1][key]) return seg(i, i + 1)
  return pts[n - 2][o]
}

/** 入参/出参均为滚动位置 */
export function renderToSource(r: number): number | null {
  return interpIn(marks, r, 'y', 's')
}
export function sourceToRender(s: number): number | null {
  return interpIn(marks, s, 's', 'y')
}

/** TOC 高亮与同步滚动共用同一套「当前标题」检测（入参为滚动位置）。 */
export function activeHeadingId(scroller: HTMLElement): string | null {
  const line = scroller.scrollTop + 96 // 激活线：视口顶下方 96px
  let hit: string | null = null
  for (const m of marks) {
    if (m.y > line) break
    if (m.id) hit = m.id
  }
  return hit
}

/** 诊断出口（dev 下挂 window.__syncDiag） */
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
