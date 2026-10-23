<script setup lang="ts">
/**
 * 源码编辑器：CodeMirror 5（与参考项目 mdeditor 同一套做法）。
 *
 * 关键点：编辑区用 contenteditable，文字与光标处在**同一套排版**里，
 * 不再「透明输入层 + 底层高亮层」两layer 叠加，因此不存在光标与显示错行的问题；
 * 语法高亮、行号、换行都由 CodeMirror 自己完成，只读态只是 readOnly: 'nocursor'。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
// Markdown 主模式（gfm 依赖 markdown，markdown 内部再回落到 xml 处理内联 HTML）
import 'codemirror/mode/xml/xml.js'
import 'codemirror/mode/markdown/markdown.js'
import 'codemirror/mode/gfm/gfm.js'
// 围栏代码块的常见语言（未加载的语言自动降级为纯文本，不影响使用）
import 'codemirror/mode/javascript/javascript.js'
import 'codemirror/mode/css/css.js'
import 'codemirror/mode/clike/clike.js'
import 'codemirror/mode/python/python.js'
import 'codemirror/mode/go/go.js'
import 'codemirror/mode/shell/shell.js'
// 当前行高亮
import 'codemirror/addon/selection/active-line.js'
import { setSrcEditor } from '../editor-bridge'

const props = defineProps<{
  modelValue: string
  /** 'gfm' = Markdown；其余按纯文本处理 */
  mode: string
  dark: boolean
  wrap: boolean
  lineNo: boolean
  readOnly: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'input'): void
  (e: 'caret', pos: { line: number; col: number }): void
  (e: 'scroll'): void
  (e: 'ready'): void
}>()

const hostEl = ref<HTMLDivElement | null>(null)
let cm: CodeMirror.Editor | null = null
// 程序 setValue（换文件/退出编辑）期间不把 change 当成用户输入回传
let applying = false

const themeOf = (dark: boolean) => (dark ? 'mdv-dark' : 'mdv-light')

function modeOption(mode: string): string | { name: string; gitHubSpice: boolean } {
  // gfm 默认开启 GitHub 增强：7–40 位十六进制串被识别成 SHA 链接（编辑态有下划线、
  // 渲染态没有），与本项目渲染口径不一致，故关闭
  return mode === 'gfm' ? { name: 'gfm', gitHubSpice: false } : mode
}

function emitCaret() {
  if (!cm) return
  const c = cm.getCursor()
  emit('caret', { line: c.line + 1, col: c.ch + 1 })
}

onMounted(() => {
  cm = CodeMirror(hostEl.value!, {
    value: props.modelValue,
    mode: modeOption(props.mode),
    theme: themeOf(props.dark),
    // 与参考项目一致：contenteditable 输入（光标与文字同层，不会有透明层错位）
    inputStyle: 'contenteditable',
    lineNumbers: props.lineNo,
    lineWrapping: props.wrap,
    readOnly: props.readOnly ? 'nocursor' : false,
    styleActiveLine: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    // 只渲染视口附近的行，长文档同样流畅
    viewportMargin: 30,
    autocapitalize: false,
    spellcheck: false
  })
  cm.on('change', () => {
    if (applying || !cm) return
    emit('update:modelValue', cm.getValue())
    emit('input')
  })
  cm.on('cursorActivity', emitCaret)
  cm.on('scroll', () => emit('scroll'))
  setSrcEditor(cm)
  emitCaret()
  emit('ready')
})

onBeforeUnmount(() => {
  if (!cm) return
  setSrcEditor(null)
  cm.getWrapperElement().remove()
  cm = null
})

// 外部改值（换文件、退出编辑还原、切模式）：保留光标与滚动位置，避免跳到顶部
watch(
  () => props.modelValue,
  (v) => {
    if (!cm || v === cm.getValue()) return
    const cur = cm.getCursor()
    const info = cm.getScrollInfo()
    applying = true
    cm.setValue(v)
    try {
      cm.setCursor(Math.min(cur.line, Math.max(0, cm.lineCount() - 1)))
    } catch {
      /* 行数变少时忽略 */
    }
    cm.scrollTo(info.left ?? 0, info.top)
    applying = false
    emitCaret()
  }
)

watch(
  () => props.readOnly,
  (v) => cm?.setOption('readOnly', v ? 'nocursor' : false)
)
watch(
  () => props.wrap,
  (v) => {
    cm?.setOption('lineWrapping', v)
    cm?.refresh()
  }
)
watch(
  () => props.lineNo,
  (v) => cm?.setOption('lineNumbers', v)
)
watch(
  () => props.dark,
  (v) => cm?.setOption('theme', themeOf(v))
)
watch(
  () => props.mode,
  (v) => cm?.setOption('mode', modeOption(v))
)

defineExpose({
  /** 真正的滚动元素：分栏同步与目录跳转都按它来，可当普通 scroll 容器用 */
  scroller: (): HTMLElement | null => cm?.getScrollerElement() ?? null,
  refresh: () => cm?.refresh(),
  focus: () => cm?.focus(),
  lineCount: () => cm?.lineCount() ?? 0
})
</script>

<template>
  <div ref="hostEl" class="src-cm" data-testid="src-cm"></div>
</template>
