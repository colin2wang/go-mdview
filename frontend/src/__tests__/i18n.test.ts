import { describe, expect, it } from 'vitest'
import { DICTS, I18N_KEYS, LANGS, formatParams, setLang, t } from '../i18n'

describe('i18n', () => {
  it('四语词典的 key 集合与中文基准完全一致', () => {
    for (const { key } of LANGS) {
      expect(Object.keys(DICTS[key]).sort(), key).toEqual([...I18N_KEYS].sort())
    }
  })

  it('占位符中的正则元字符按字面量匹配', () => {
    expect(formatParams('文件 {file.name} 已保存', { 'file.name': 'notes/a.md' })).toBe('文件 notes/a.md 已保存')
    expect(formatParams('{fileXname}', { 'file.name': 'notes/a.md' })).toBe('{fileXname}')
  })

  it('取词助手能替换现有占位符', () => {
    setLang('zh-CN')
    expect(t('files.previewCount', { n: 3, m: 10 })).toBe('3 / 10 个文件可预览')
  })
})
