import { describe, expect, it } from 'vitest'
import mockSampleUrl from '../assets/mock-sample.svg'
import styleMdCss from '../style-md.css?raw'
import storeSource from '../store.ts?raw'
import { preprocess, resolveImgHref } from '../markdown'
import { parseMarkdown } from '../mindmap'
import { countPreviewText, countStats } from '../stats'
import { remoteAllowed, stripSvgExternalRefs } from '../sanitize-common.js'
import { interpIn } from '../sync'

describe('preprocess', () => {
  it('摘除脚注定义、保留围栏里的 #', () => {
    const r = preprocess('# 标题 [^1]\n\n[^1]: 注释\n\n```sh\n# 不是标题\n```\n')
    expect(r.md).not.toContain('[^1]:')
    expect(r.md).toContain('# 不是标题')
    expect(r.footnotes).toHaveLength(1)
    expect(r.lineMap.length).toBeGreaterThan(0)
  })

  it('wiki 链接支持路径、锚点与别名，行内代码不参与改写', () => {
    const r = preprocess('[[folder/note#head|别名]] 与 `[[raw]]`\n')
    expect(r.md).toContain('data-wiki="folder/note"')
    expect(r.md).toContain('data-anchor="head"')
    expect(r.md).toContain('别名')
    expect(r.md).toContain('`[[raw]]`')
  })

  it('本地图片映射到 /mdimg 回放路由', () => {
    window._wails = {}
    try {
      expect(resolveImgHref('cover.png', 'D:/docs')).toMatch(/^\/mdimg\/[0-9a-f]+\/cover\.png$/)
    } finally {
      delete window._wails
    }
  })

  it('浏览器模式无回放路由时回退到内置示例图', () => {
    expect(resolveImgHref('cover.png', 'D:/docs')).toBe(mockSampleUrl)
  })
})

describe('mindmap', () => {
  it('围栏代码块里的 # 注释不生成节点', () => {
    const root = parseMarkdown('# 根\n\n```sh\n# 假节点\n```\n\n## 真节点\n')
    const labels = JSON.stringify(root)
    expect(labels).not.toContain('假节点')
    expect(labels).toContain('真节点')
  })
})

describe('stats', () => {
  it('中文按字计词', () => {
    expect(countStats('你好世界 hello').words).toBe(5)
  })

  it('隐藏元素、按钮与 SVG 不计入预览字数', () => {
    const el = document.createElement('div')
    el.innerHTML = '<p>可见文字</p><button>按钮</button><svg>文本</svg><span style="display:none">隐藏</span>'
    expect(countPreviewText(el)).toBe(4)
  })
})

describe('sanitize-common', () => {
  it('远程白名单按通配符匹配', () => {
    expect(remoteAllowed('https://cdn.example.com/a.png', 'https://cdn.example.com/*')).toBe(true)
    expect(remoteAllowed('https://evil.tld/a.png', 'https://cdn.example.com/*')).toBe(false)
  })

  it('SVG 远程与 data: 引用被剥离，本地锚点保留', () => {
    const s = stripSvgExternalRefs('<svg><image href="data:image/svg+xml,x"/><use xlink:href="https://evil.tld/a"/><image href="#local"/></svg>')
    expect(s).not.toContain('data:')
    expect(s).not.toContain('evil.tld')
    expect(s).toContain('#local')
  })
})

describe('sync interpIn', () => {
  const pts = [
    { y: 0, s: 0, line: 0 },
    { y: 100, s: 80, line: 4 },
    { y: 300, s: 200, line: 10 },
    { y: 900, s: 480, line: Number.MAX_SAFE_INTEGER }
  ]

  it('段内线性插值', () => {
    expect(interpIn(pts, 200, 'y', 's')).toBe(140)
  })

  it('端点外推', () => {
    expect(interpIn(pts, -50, 'y', 's')).toBe(-40)
    expect(interpIn(pts, 1200, 'y', 's')).toBe(620)
  })

  it('退化段不除零', () => {
    const d = [
      { y: 0, s: 0, line: 0 },
      { y: 100, s: 100, line: 3 },
      { y: 100, s: 140, line: 4 }
    ]
    expect(interpIn(d, 150, 'y', 's')).toBe(100)
  })

  it('点表不足返回 null', () => {
    expect(interpIn([], 5, 'y', 's')).toBeNull()
    expect(interpIn([{ y: 0, s: 0, line: 0 }], 5, 'y', 's')).toBeNull()
  })
})

describe('渲染区代码块最大行数', () => {
  const css = styleMdCss
  const storeSrc = storeSource

  it('图形卡片源码视图与错误提示都受行数变量约束', () => {
    const srcRule = css.match(/\.md-article \.md-diagram-code\s*\{([^}]*)\}/)?.[1] ?? ''
    const hintRule = css.match(/\.md-article \.md-diagram-src-code\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(srcRule).toContain('max-height: var(--code-max-h-diagram, none)')
    expect(srcRule).toContain('overflow-y: auto')
    expect(hintRule).toContain('max-height: var(--code-max-h-dia, none)')
  })

  it('applySettings 写入全部三个代码块的 CSS 变量', () => {
    for (const name of ['--code-max-h', '--code-max-h-dia', '--code-max-h-diagram']) {
      expect(storeSrc).toContain(`setProperty('${name}'`)
    }
  })
})
