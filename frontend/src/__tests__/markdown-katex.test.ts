import { describe, expect, it, vi } from 'vitest'

const { renderMathInElement } = vi.hoisted(() => ({ renderMathInElement: vi.fn() }))

vi.mock('../vendor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vendor')>()
  return {
    ...actual,
    ensureKatex: () => Promise.resolve({ katex: {}, renderMathInElement })
  }
})

import { renderMathIn } from '../markdown'

describe('KaTeX 渲染配置', () => {
  it('显式关闭 trust，避免 \\href / \\includegraphics 生成链接', async () => {
    const el = document.createElement('div')
    await renderMathIn(el)
    expect(renderMathInElement).toHaveBeenCalledWith(el, expect.objectContaining({ trust: false }))
  })
})
