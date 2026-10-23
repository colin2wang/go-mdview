<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createMindMap, type MindMapController } from '../mindmap'
import { getApi } from '../api'
import { t } from '../i18n'
import { toast } from '../store'

const props = defineProps<{ markdown: string; dark: boolean; name: string; maxLen: number }>()

const containerEl = ref<HTMLElement | null>(null)
let ctrl: MindMapController | null = null
const notesOn = ref(true)

onMounted(() => {
  if (containerEl.value) {
    ctrl = createMindMap(containerEl.value, props.markdown, { dark: props.dark, maxLen: props.maxLen })
    notesOn.value = true
  }
})
onBeforeUnmount(() => {
  ctrl?.destroy()
  ctrl = null
})

watch(
  () => props.markdown,
  (md) => ctrl?.load(md)
)
watch(
  () => props.dark,
  (d) => ctrl?.setDark(d)
)
watch(
  () => props.maxLen,
  (n) => ctrl?.setMaxLen(n)
)

function fit() {
  ctrl?.fit()
}
function zoomIn() {
  ctrl?.zoomIn()
}
function zoomOut() {
  ctrl?.zoomOut()
}
function toggleNotes() {
  if (!ctrl) return
  notesOn.value = ctrl.toggleNotes()
}
function collapse() {
  ctrl?.collapseTo(2)
}
function expand() {
  ctrl?.expandAll()
}
async function exportSvg() {
  if (!ctrl) return
  const svg = ctrl.exportSvg()
  try {
    const api = await getApi()
    const name = props.name.replace(/\.md$/i, '')
    const out = await api.SaveSvgDialog(name, svg, name + '.svg')
    if (out) toast(t('toast.exported', { name: out.split(/[\\/]/).pop() ?? out }))
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
  }
}
async function exportPng() {
  if (!ctrl) return
  const svg = ctrl.exportSvg()
  try {
    const img = new Image()
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg decode failed'))
      img.src = url
    })
    const bw = img.width || 1200
    const bh = img.height || 800
    const scale = 2 // 2x 提升清晰度
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bw * scale))
    canvas.height = Math.max(1, Math.round(bh * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    const dataUrl = canvas.toDataURL('image/png')
    const api = await getApi()
    const name = props.name.replace(/\.md$/i, '')
    const out = await api.SaveImageDialog(name + '.png', dataUrl)
    if (out) toast(t('toast.exported', { name: out.split(/[\\/]/).pop() ?? out }))
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
  }
}
async function copySvg() {
  if (!ctrl) return
  try {
    const api = await getApi()
    await api.CopyText(ctrl.exportSvg())
    toast(t('toast.copiedSource'))
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
  }
}
</script>

<template>
  <div class="mindmap-view">
    <header class="pane-head mm-head">
      <span class="pane-tag mm-tag">{{ t('mm.title') }}</span>
      <span class="pane-grow"></span>
      <div class="mm-tools" role="toolbar">
        <button class="mm-btn" :title="t('mm.fit.tip')" @click="fit">{{ t('mm.fit') }}</button>
        <button class="mm-btn" :title="t('mm.zoomIn.tip')" @click="zoomIn">＋</button>
        <button class="mm-btn" :title="t('mm.zoomOut.tip')" @click="zoomOut">－</button>
        <button class="mm-btn" :class="{ on: notesOn }" :title="t('mm.notes.tip')" @click="toggleNotes">
          {{ t('mm.notes') }}
        </button>
        <button class="mm-btn" :title="t('mm.collapse.tip')" @click="collapse">{{ t('mm.collapse') }}</button>
        <button class="mm-btn" :title="t('mm.expand.tip')" @click="expand">{{ t('mm.expand') }}</button>
        <span class="mm-sep"></span>
        <button class="mm-btn" :title="t('mm.exportSvg.tip')" @click="exportSvg">{{ t('mm.exportSvg') }}</button>
        <button class="mm-btn" :title="t('mm.exportPng.tip')" @click="exportPng">{{ t('mm.exportPng') }}</button>
        <button class="mm-btn" :title="t('mm.copy.tip')" @click="copySvg">{{ t('mm.copy') }}</button>
      </div>
    </header>
    <!-- 画布容器：mindmap.ts 在此内创建 svg 并处理滚轮/拖拽/点击 -->
    <div ref="containerEl" class="mm-canvas" data-testid="mindmap-canvas"></div>
  </div>
</template>
