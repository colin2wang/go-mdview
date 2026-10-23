/* =====================================================================
 * mindmap.ts —— Markdown → XMind 风格思维导图（零依赖，单文件）
 *   • 解析 # ~ ###### 标题层级，> 引用块作为节点备注
 *   • 左右平衡布局 + 贝塞尔有机连线 + 四级节点样式
 *   • 浏览器：滚轮缩放 / 拖拽 / 点击折叠 / 导出 SVG / PNG
 *   • 深浅主题：文字与淡色底随主题切换
 * 该文件为纯渲染与交互层，工具条按钮由 MindMap.vue 负责（便于复用 i18n）。
 * ===================================================================== */
/* ---------------- 类型 ---------------- */
export interface MindNode {
  id: string
  title: string
  notes: string[] // > 引用内容
  depth: number // 根=0, ##=1, ###=2, ####=3 ...
  parent: MindNode | null
  children: MindNode[]
  collapsed: boolean
  color: string // 所属分支颜色
  side: 0 | 1 | -1 // 0=未分配 1=右侧 -1=左侧
  /* 布局结果 */
  x: number
  y: number
  w: number
  h: number
  extent: number // 子树占用的垂直高度
  titleLines: string[]
  noteLines: string[]
}
export interface MindMapController {
  fit(): void
  zoomIn(): void
  zoomOut(): void
  toggleNotes(): boolean
  collapseTo(level: number): void
  expandAll(): void
  load(markdown: string): void
  setDark(dark: boolean): void
  /** 导出为独立 SVG 文档字符串（含背景矩形）。 */
  exportSvg(): string
  nodeCount(): number
  /** 释放 window 级监听与 ResizeObserver（组件卸载时调用）。 */
  destroy(): void
}
/* ---------------- 配置 ---------------- */
const CFG = {
  font: `"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Segoe UI", sans-serif`,
  palette: ['#4F6DF5', '#00A8A8', '#E8574F', '#F59E0B', '#8B5CF6',
    '#EC4899', '#22A55B', '#0EA5E9', '#D97706', '#64748B'],
  hGapRoot: 76, // 根 → 一级分支水平间距
  hGap: 38, // 其余层级水平间距
  vGapBranch: 28, // 一级分支之间垂直间距
  vGap: 10, // 其余兄弟节点垂直间距
  strokeW: [3.4, 2.2, 1.6, 1.2], // 连线宽度（按父层级）
  style: [ // 各层级结构样式（颜色按主题在 render 时取）
    /* 0 根节点   */ { size: 20, weight: 700, maxW: 400, padX: 26, padY: 18, lh: 30, noteSize: 11.5, noteLh: 17 },
    /* 1 一级分支 */ { size: 15, weight: 700, maxW: 240, padX: 15, padY: 10, lh: 21, noteSize: 11, noteLh: 15 },
    /* 2 二级     */ { size: 13.5, weight: 600, maxW: 190, padX: 12, padY: 8, lh: 19, noteSize: 11, noteLh: 15 },
    /* 3 三级     */ { size: 12.5, weight: 600, maxW: 170, padX: 5, padY: 4, lh: 17, noteSize: 10.5, noteLh: 14 },
    /* ≥4        */ { size: 12, weight: 400, maxW: 155, padX: 5, padY: 4, lh: 16, noteSize: 10.5, noteLh: 14 },
  ],
}
const styleOf = (d: number) => CFG.style[Math.min(d, CFG.style.length - 1)]
const r = (v: number): number => Math.round(v * 10) / 10
const DEFS = `
  <linearGradient id="mmRoot" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#4338CA"/>
  </linearGradient>
  <filter id="mmShadow" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#1E1B4B" flood-opacity="0.25"/>
  </filter>
  <filter id="mmShadowSm" x="-40%" y="-40%" width="180%" height="180%">
    <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#0F172A" flood-opacity="0.16"/>
  </filter>`
/* ---------------- 主题色 ---------------- */
const COL_LIGHT = ['#ffffff', '#ffffff', '#1f2937', '#334155', '#64748b']
const NOTE_LIGHT = ['#c7d2fe', 'rgba(255,255,255,.88)', '#64748b', '#94a3b8', '#a3adb8']
const COL_DARK = ['#ffffff', '#ffffff', '#e5e7eb', '#cbd5e1', '#94a3b8']
const NOTE_DARK = ['#c7d2fe', 'rgba(255,255,255,.9)', '#94a3b8', '#64748b', '#475569']
const textColor = (d: number, dark: boolean) => (dark ? COL_DARK : COL_LIGHT)[Math.min(d, 4)]
const noteColor = (d: number, dark: boolean) => (dark ? NOTE_DARK : NOTE_LIGHT)[Math.min(d, 4)]
const FILL_OPACITY = (dark: boolean) => (dark ? 0.2 : 0.12)
const BG_COLOR = (dark: boolean) => (dark ? '#0f172a' : '#ffffff')
/* ---------------- 文本测量与换行 ---------------- */
const CJK_RE = /[⺀-⻿一-鿿぀-ヿ㄰-ㆿ㐀-䶿가-힯豈-﫿ぁ-んァ-ヶ　-〿＀-￯]/
const isCJK = (ch: string) => CJK_RE.test(ch)
class Ruler {
  private ctx: CanvasRenderingContext2D | null = null
  constructor() {
    try {
      if (typeof document !== 'undefined')
        this.ctx = document.createElement('canvas').getContext('2d')
    } catch {
      /* ignore */
    }
  }
  width(text: string, size: number, weight = 400): number {
    if (this.ctx) {
      this.ctx.font = `${weight} ${size}px ${CFG.font}`
      return this.ctx.measureText(text).width
    }
    let w = 0 // 无 canvas 时的启发式估算
    for (const ch of text) w += isCJK(ch) ? size : size * 0.55
    return w
  }
}
const ruler = new Ruler()
/** 自动换行：CJK 逐字可断，latin 按单词断 */
function wrapText(text: string, maxW: number, size: number, weight: number): string[] {
  const lines: string[] = []
  let line = '', lw = 0, word = '', wordW = 0
  const flushWord = () => {
    if (!word) return
    if (line && lw + wordW > maxW) {
      lines.push(line.trimEnd())
      line = ''
      lw = 0
    }
    line += word
    lw += wordW
    word = ''
    wordW = 0
  }
  for (const ch of text) {
    if (isCJK(ch)) {
      flushWord()
      const cw = ruler.width(ch, size, weight)
      if (line && lw + cw > maxW) {
        lines.push(line.trimEnd())
        line = ''
        lw = 0
      }
      line += ch
      lw += cw
    } else if (/\s/.test(ch)) {
      flushWord()
      const sw = ruler.width(' ', size, weight)
      if (line && lw + sw <= maxW) {
        line += ' '
        lw += sw
      }
    } else {
      word += ch
      wordW += ruler.width(ch, size, weight)
    }
  }
  flushWord()
  if (line) lines.push(line.trimEnd())
  return lines.length ? lines : ['']
}
/* ---------------- Markdown 解析 ---------------- */
let __uid = 0
function mkNode(title: string, depth: number, parent: MindNode | null): MindNode {
  return {
    id: 'n' + __uid++,
    title,
    notes: [],
    depth,
    parent,
    children: [],
    collapsed: false,
    color: CFG.palette[0],
    side: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    extent: 0,
    titleLines: [],
    noteLines: [],
  }
}
export function parseMarkdown(markdown: string): MindNode {
  const root = mkNode('未命名导图', 0, null)
  const stack: MindNode[] = [root]
  let current: MindNode = root
  let rootFilled = false
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (h) {
      const depth = h[1].length - 1 // # → 0
      if (depth === 0 && !rootFilled) {
        root.title = h[2]
        rootFilled = true
        current = root
        continue
      }
      const node = mkNode(h[2], depth, null)
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
      const parent = stack[stack.length - 1]
      node.parent = parent
      parent.children.push(node)
      stack.push(node)
      current = node
      continue
    }
    const q = /^>\s?(.*)$/.exec(line) // > 引用 → 当前节点备注
    if (q) {
      const t = q[1].trim()
      if (t) current.notes.push(t)
    }
  }
  if (!rootFilled && root.children.length === 1 && !root.notes.length) {
    const real = root.children[0]
    real.parent = null
    fixDepths(real, 0)
    return real
  }
  fixDepths(root, 0)
  return root
}
function fixDepths(n: MindNode, d: number): void {
  n.depth = d
  n.children.forEach((c) => fixDepths(c, d + 1))
}
/* ---------------- 布局 ---------------- */
function measureNode(n: MindNode, showNotes: boolean): void {
  const st = styleOf(n.depth)
  n.titleLines = wrapText(n.title, st.maxW, st.size, st.weight)
  n.noteLines = showNotes && n.notes.length
    ? wrapText(n.notes.filter(Boolean).join(' · '), st.maxW, st.noteSize, 400)
    : []
  let textW = 0
  for (const l of n.titleLines) textW = Math.max(textW, ruler.width(l, st.size, st.weight))
  for (const l of n.noteLines) textW = Math.max(textW, ruler.width(l, st.noteSize, 400))
  const bodyH =
    n.titleLines.length * st.lh +
    (n.noteLines.length ? 4 + n.noteLines.length * st.noteLh : 0)
  n.w = Math.ceil(textW + st.padX * 2)
  n.h = Math.ceil(bodyH + st.padY * 2)
}
function extentOf(n: MindNode): number {
  if (n.collapsed || n.children.length === 0) {
    n.extent = n.h
    return n.h
  }
  let sum = 0
  for (const c of n.children) sum += extentOf(c)
  const gap = n.depth === 0 ? CFG.vGapBranch : CFG.vGap
  n.extent = Math.max(n.h, sum + gap * (n.children.length - 1))
  return n.extent
}
function place(n: MindNode, leftX: number, side: 1 | -1, centerY: number): void {
  n.side = side
  n.x = leftX
  n.y = centerY - n.h / 2
  if (n.collapsed || n.children.length === 0) return
  const gap = n.depth === 0 ? CFG.vGapBranch : CFG.vGap
  const hgap = n.depth === 0 ? CFG.hGapRoot : CFG.hGap
  let top = centerY - n.extent / 2
  for (const c of n.children) {
    const cx = side === 1 ? n.x + n.w + hgap : n.x - hgap - c.w
    place(c, cx, side, top + c.extent / 2)
    top += c.extent + gap
  }
}
function paintChildren(n: MindNode, color: string): void {
  n.children.forEach((c) => {
    c.color = color
    paintChildren(c, color)
  })
}
function layoutTree(root: MindNode, showNotes: boolean): void {
  const measureAll = (n: MindNode) => {
    measureNode(n, showNotes)
    n.children.forEach(measureAll)
  }
  measureAll(root)
  // 一级分支：配色 + 贪心左右平衡（首次分配后保持稳定，避免折叠时跳动）
  let sumR = 0,
    sumL = 0
  for (let i = 0; i < root.children.length; i++) {
    const b = root.children[i]
    b.color = CFG.palette[i % CFG.palette.length]
    paintChildren(b, b.color)
    const e = extentOf(b)
    if (b.side === 0) {
      if (sumR <= sumL) {
        b.side = 1
        sumR += e + CFG.vGapBranch
      } else {
        b.side = -1
        sumL += e + CFG.vGapBranch
      }
    }
  }
  root.x = -root.w / 2
  root.y = -root.h / 2
  root.side = 1
  for (const side of [1, -1] as const) {
    const bs = root.children.filter((b) => b.side === side)
    if (!bs.length) continue
    const total = bs.reduce((a, b) => a + b.extent, 0) + CFG.vGapBranch * (bs.length - 1)
    let top = -total / 2
    for (const b of bs) {
      const x = side === 1 ? root.x + root.w + CFG.hGapRoot : root.x - CFG.hGapRoot - b.w
      place(b, x, side, top + b.extent / 2)
      top += b.extent + CFG.vGapBranch
    }
  }
}
function treeBounds(root: MindNode) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  const walk = (n: MindNode) => {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
    if (!n.collapsed) n.children.forEach(walk)
  }
  walk(root)
  return { minX, minY, w: maxX - minX, h: maxY - minY }
}
/* ---------------- SVG 渲染 ---------------- */
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c])
function collectEdges(n: MindNode, out: string[]): void {
  if (n.collapsed) return
  for (const c of n.children) {
    const dir = c.side === -1 ? -1 : 1
    const sx = dir === 1 ? n.x + n.w : n.x,
      sy = n.y + n.h / 2
    const ex = dir === 1 ? c.x : c.x + c.w,
      ey = c.y + c.h / 2
    const k = Math.min(Math.abs(ex - sx) * 0.55, 70)
    const d =
      dir === 1
        ? `M ${r(sx)} ${r(sy)} C ${r(sx + k)} ${r(sy)} ${r(ex - k)} ${r(ey)} ${r(ex)} ${r(ey)}`
        : `M ${r(sx)} ${r(sy)} C ${r(sx - k)} ${r(sy)} ${r(ex + k)} ${r(ey)} ${r(ex)} ${r(ey)}`
    const w = CFG.strokeW[Math.min(n.depth, CFG.strokeW.length - 1)]
    out.push(
      `<path d="${d}" fill="none" stroke="${c.color}" stroke-width="${w}" stroke-linecap="round"/>`
    )
    collectEdges(c, out)
  }
}
function nodeSvg(n: MindNode, dark: boolean): string {
  const st = styleOf(n.depth)
  const clickable = n.children.length > 0
  const s: string[] = []
  s.push(`<g class="mm-node${clickable ? ' mm-clickable' : ''}" data-id="${n.id}">`)
  if (clickable) s.push(`<title>${esc(n.title)} · 点击${n.collapsed ? '展开' : '折叠'}</title>`)
  const x = r(n.x),
    y = r(n.y),
    w = r(n.w),
    h = r(n.h)
  if (n.depth === 0) {
    s.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r(
        Math.min(30, n.h / 2)
      )}" fill="url(#mmRoot)" filter="url(#mmShadow)"/>`
    )
  } else if (n.depth === 1) {
    s.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${n.color}" filter="url(#mmShadowSm)"/>`
    )
  } else if (n.depth === 2) {
    s.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${n.color}" fill-opacity="${FILL_OPACITY(
        dark
      )}" stroke="${n.color}" stroke-opacity="0.45"/>`
    )
  } else {
    s.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="transparent"/>`)
  }
  const centered = n.depth <= 1
  const tx = centered ? n.x + n.w / 2 : n.x + st.padX
  const anchor = centered ? 'middle' : 'start'
  for (let i = 0; i < n.titleLines.length; i++) {
    const by = n.y + st.padY + i * st.lh + st.lh / 2 + st.size * 0.35
    s.push(
      `<text x="${r(tx)}" y="${r(by)}" text-anchor="${anchor}" font-size="${st.size}" font-weight="${st.weight}" fill="${textColor(
        n.depth,
        dark
      )}">${esc(n.titleLines[i])}</text>`
    )
  }
  if (n.noteLines.length) {
    const top = n.y + st.padY + n.titleLines.length * st.lh + 4
    for (let j = 0; j < n.noteLines.length; j++) {
      const by = top + j * st.noteLh + st.noteLh / 2 + st.noteSize * 0.35
      s.push(
        `<text x="${r(tx)}" y="${r(by)}" text-anchor="${anchor}" font-size="${st.noteSize}" fill="${noteColor(
          n.depth,
          dark
        )}">${esc(n.noteLines[j])}</text>`
      )
    }
  }
  if (n.depth === 3) {
    let tw = 0
    for (const l of n.titleLines) tw = Math.max(tw, ruler.width(l, st.size, st.weight))
    if (tw > 0) {
      const uy = n.y + st.padY + n.titleLines.length * st.lh - 2.5
      s.push(
        `<line x1="${r(n.x + st.padX)}" y1="${r(uy)}" x2="${r(
          n.x + st.padX + tw
        )}" y2="${r(uy)}" stroke="${n.color}" stroke-opacity="0.6" stroke-width="1.6" stroke-linecap="round"/>`
      )
    }
  }
  if (clickable && (n.collapsed || n.depth <= 1)) {
    let bx: number,
      byy: number
    if (n.depth === 0) {
      bx = n.x + n.w / 2
      byy = n.y + n.h + 15
    } else {
      bx = n.side === 1 ? n.x + n.w + 11 : n.x - 11
      byy = n.y + n.h / 2
    }
    const isCount = n.collapsed && n.children.length <= 9
    const label = n.collapsed ? (isCount ? `+${n.children.length}` : '+') : '−'
    s.push(
      `<circle cx="${r(bx)}" cy="${r(byy)}" r="9" fill="#fff" stroke="${n.color}" stroke-width="1.5"/>` +
        `<text x="${r(bx)}" y="${r(byy + 3.5)}" text-anchor="middle" font-size="${
          isCount ? 9.5 : 13
        }" font-weight="700" fill="${n.color}">${label}</text>`
    )
  }
  s.push('</g>')
  return s.join('')
}
function collectNodes(n: MindNode, out: string[], dark: boolean): void {
  out.push(nodeSvg(n, dark))
  if (!n.collapsed) n.children.forEach((c) => collectNodes(c, out, dark))
}
function partsOf(root: MindNode, showNotes: boolean, dark: boolean) {
  layoutTree(root, showNotes)
  const edges: string[] = [],
    nodes: string[] = []
  collectEdges(root, edges)
  collectNodes(root, nodes, dark)
  return { edges, nodes }
}
/** 生成独立 SVG 文档字符串（含背景，可用于导出 / 转 PNG）。 */
export function renderSvgDocument(root: MindNode, showNotes = true, dark = false): string {
  const { edges, nodes } = partsOf(root, showNotes, dark)
  const b = treeBounds(root)
  const pad = 48
  const vw = r(b.w + pad * 2),
    vh = r(b.h + pad * 2)
  const x0 = r(b.minX - pad),
    y0 = r(b.minY - pad)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${x0} ${y0} ${vw} ${vh}" font-family="${CFG.font.replace(
    /"/g,
    "'"
  )}">
<defs>${DEFS}</defs>
<rect x="${x0}" y="${y0}" width="${vw}" height="${vh}" fill="${BG_COLOR(dark)}"/>
${edges.join('')}${nodes.join('')}
</svg>`
}
/* ---------------- 浏览器交互版 ---------------- */
function walkAll(n: MindNode, fn: (n: MindNode) => void): void {
  fn(n)
  n.children.forEach((c) => walkAll(c, fn))
}
function findNode(root: MindNode, id: string): MindNode | null {
  let res: MindNode | null = null
  walkAll(root, (n) => {
    if (n.id === id) res = n
  })
  return res
}
function countNodes(n: MindNode): number {
  let c = 1
  n.children.forEach((ch) => (c += countNodes(ch)))
  return c
}
/**
 * 在 container 内挂载思维导图。工具条由外部（MindMap.vue）调用返回的方法实现。
 * dark 控制配色；load() 可重新解析文档；setDark() 切换主题后重绘。
 */
export function createMindMap(
  container: HTMLElement,
  markdown: string,
  opts: { dark?: boolean } = {}
): MindMapController {
  container.classList.add('mm-container')
  let root = parseMarkdown(markdown)
  let DARK = !!opts.dark
  let showNotes = true
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'mm-svg')
  container.appendChild(svg)
  svg.innerHTML = `<defs>${DEFS}</defs><g class="mm-content"></g>`
  const content = svg.querySelector('.mm-content') as SVGGElement
  content.setAttribute('font-family', CFG.font)
  const view = { x: 0, y: 0, k: 1 }
  const apply = () =>
    content.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`)
  function draw(): void {
    const { edges, nodes } = partsOf(root, showNotes, DARK)
    content.innerHTML = edges.join('') + nodes.join('')
    apply()
  }
  function fit(): void {
    const b = treeBounds(root)
    const rect = svg.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const k = Math.min(rect.width / (b.w + 80), rect.height / (b.h + 80), 1.25)
    view.k = k
    view.x = rect.width / 2 - k * (b.minX + b.w / 2)
    view.y = rect.height / 2 - k * (b.minY + b.h / 2)
    apply()
  }
  function zoomBy(f: number): void {
    const rect = svg.getBoundingClientRect()
    const cx = rect.width / 2,
      cy = rect.height / 2
    const k = Math.min(4, Math.max(0.05, view.k * f))
    view.x = cx - (cx - view.x) * (k / view.k)
    view.y = cy - (cy - view.y) * (k / view.k)
    view.k = k
    apply()
  }
  svg.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const px = e.clientX - rect.left,
        py = e.clientY - rect.top
      const k = Math.min(4, Math.max(0.05, view.k * Math.exp(-e.deltaY * 0.0013)))
      view.x = px - (px - view.x) * (k / view.k)
      view.y = py - (py - view.y) * (k / view.k)
      view.k = k
      apply()
    },
    { passive: false }
  )
  const drag = { on: false, sx: 0, sy: 0, dist: 0 }
  svg.addEventListener('pointerdown', (e: PointerEvent) => {
    drag.on = true
    drag.sx = e.clientX
    drag.sy = e.clientY
    drag.dist = 0
  })
  const onMove = (e: PointerEvent) => {
    if (!drag.on) return
    const dx = e.clientX - drag.sx,
      dy = e.clientY - drag.sy
    drag.dist += Math.abs(dx) + Math.abs(dy)
    view.x += dx
    view.y += dy
    drag.sx = e.clientX
    drag.sy = e.clientY
    apply()
  }
  window.addEventListener('pointermove', onMove)
  const onUp = (e: PointerEvent) => {
    if (!drag.on) return
    drag.on = false
    if (drag.dist < 6) {
      const el = (e.target as Element | null)?.closest('[data-id]')
      if (el) {
        const n = findNode(root, el.getAttribute('data-id') as string)
        if (n && n.children.length) {
          n.collapsed = !n.collapsed
          draw()
        }
      }
    }
  }
  window.addEventListener('pointerup', onUp)
  // 容器首次拿到非零尺寸后再 fit：挂载瞬间 flex 布局可能还没稳定（画布 0 高时 fit 会早退）
  let sized = false
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const rect = svg.getBoundingClientRect()
          if (!sized && rect.width > 0 && rect.height > 0) {
            sized = true
            fit()
          }
        })
      : null
  ro?.observe(container)
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    ro?.disconnect()
  }
  draw()
  requestAnimationFrame(fit)
  return {
    fit,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    toggleNotes: () => {
      showNotes = !showNotes
      draw()
      return showNotes
    },
    collapseTo: (lv: number) => {
      walkAll(root, (n) => {
        n.collapsed = n.depth >= lv && n.children.length > 0
      })
      draw()
    },
    expandAll: () => {
      walkAll(root, (n) => {
        n.collapsed = false
      })
      draw()
    },
    load: (md: string) => {
      root = parseMarkdown(md)
      draw()
      fit()
    },
    setDark: (dark: boolean) => {
      DARK = dark
      draw()
    },
    exportSvg: () => renderSvgDocument(root, showNotes, DARK),
    nodeCount: () => countNodes(root),
    destroy: cleanup,
  }
}
