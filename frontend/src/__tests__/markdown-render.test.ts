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

describe('code line numbers and diagram header', () => {
  const parse = (html: string) => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host
  }

  it('代码块按逻辑行包装，且 pre.textContent 与原文逐字一致', async () => {
    const code = 'def f():\n    return 1'
    const { html } = await renderMarkdown(`\`\`\`python\n${code}\n\`\`\`\n`, '')
    const el = parse(html).querySelector('.code-block pre code')
    expect(el).not.toBeNull()
    expect(el!.querySelectorAll('.code-line').length).toBe(2)
    expect(el!.querySelectorAll('.code-line-num').length).toBe(2)
    expect(el!.textContent).toBe(code)
  })

  it('跨行高亮 token 在换行处配平 span，不改变复制文本', async () => {
    const code = '/* start\n   end */\nconst a = 1'
    const { html } = await renderMarkdown(`\`\`\`js\n${code}\n\`\`\`\n`, '')
    const el = parse(html).querySelector('.code-block pre code')
    expect(el).not.toBeNull()
    expect(el!.querySelectorAll('.code-line').length).toBe(3)
    expect(el!.textContent).toBe(code)
  })

  it('图形源码视图带行号，头部无标题且复制按钮与代码块同形', async () => {
    const code = 'graph TD\n  A-->B'
    const { html } = await renderMarkdown(`\`\`\`mermaid\n${code}\n\`\`\`\n`, '')
    const card = parse(html).querySelector('.md-diagram')
    expect(card).not.toBeNull()
    const src = card!.querySelector('.md-diagram-code code')
    expect(src!.querySelectorAll('.code-line').length).toBe(2)
    expect(src!.textContent).toBe(code)
    expect(card!.querySelector('.md-diagram-title')).toBeNull()
    expect(card!.querySelector('.md-diagram-head .code-lang')?.textContent).toBe('mermaid')
    expect(card!.querySelector('.md-diagram-head .code-copy[data-copy]')).not.toBeNull()
    expect(card!.querySelector('.md-diagram-head [data-toggle-src]')).not.toBeNull()
  })
})
