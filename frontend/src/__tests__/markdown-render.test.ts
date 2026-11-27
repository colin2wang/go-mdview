import { describe, expect, it } from 'vitest'
import { createSlContext, preprocess, renderMarkdown } from '../markdown'

describe('render context isolation', () => {
  it('交错的渲染上下文互不推进对方的源码行游标', () => {
    const a = preprocess('# Alpha\n\n段落 A\n\n## Beta\n\n段落 B\n')
    const b = preprocess('# Gamma\n\n段落 C\n\n## Delta\n\n段落 D\n')
    const ctxA = createSlContext(a.md, a.lineMap)
    const ctxB = createSlContext(b.md, b.lineMap)

    expect(ctxA.withSl('<h1>x</h1>', '# Alpha')).toContain('data-sl="0"')
    expect(ctxB.withSl('<h1>x</h1>', '# Gamma')).toContain('data-sl="0"')
    expect(ctxA.withSl('<h2>x</h2>', '## Beta')).toContain('data-sl="4"')
    expect(ctxB.withSl('<h2>x</h2>', '## Delta')).toContain('data-sl="4"')
  })

  it('并发渲染两篇文档时 data-sl 行号各自正确', async () => {
    const [a, b] = await Promise.all([
      renderMarkdown('# Alpha\n\n## Beta\n', ''),
      renderMarkdown('# Gamma\n\n## Delta\n', '')
    ])
    expect(a.html).toContain('data-sl="0"')
    expect(a.html).toContain('data-sl="2"')
    expect(b.html).toContain('data-sl="0"')
    expect(b.html).toContain('data-sl="2"')
    expect(a.html).toContain('Alpha</h1>')
    expect(b.html).toContain('Gamma</h1>')
  })
})
