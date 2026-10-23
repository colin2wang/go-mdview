/**
 * 底部状态栏数据。源码（含编辑草稿）与渲染正文都在 Viewer 手里，
 * 由它写入，StatusBar 只读；避免把状态塞进 store 或层层传 props。
 */
import { reactive } from 'vue'

export const status = reactive({
  hasFile: false,
  editing: false,
  /** 源码字符数（编辑中取草稿） */
  chars: 0,
  /** 渲染后可见文本字符数 */
  previewChars: 0,
  /** 源码行数 */
  lines: 0,
  /** 光标位置（1-based，仅编辑态有意义） */
  caretLine: 0,
  caretCol: 0,
  /** 左侧摘要：编码 / 文件类别等 */
  summary: ''
})
