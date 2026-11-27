<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../i18n'
import type { MermaidEngine } from '../types'
import { sanitizeMermaidSvg, sanitizePeleSvg, sanitizeSvg } from '../markdown'

/**
 * 全屏图片灯箱：滚轮缩放、拖拽平移，ESC / 右上角 ✕ 关闭。
 * src 为图片地址；svg 为内联 SVG 文本（Mermaid / SVG 图形卡片双击时使用）。
 */
const props = defineProps<{ src?: string; svg?: string; engine?: MermaidEngine | 'svg' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const fitMode = ref<'fit' | 'actual'>('fit')
const imgError = ref(false)
const reloadKey = ref(0)

/** 灯箱是第二个 v-html 汇点：Mermaid / SVG 的 outerHTML 必须再次净化后才能落地。 */
const safeSvg = computed(() => {
  if (!props.svg) return ''
  // 内联 SVG 沿用正文的通用出口（保留 SMIL 动画），不能套 Mermaid 的二次净化配置。
  if (props.engine === 'svg') return sanitizeSvg(props.svg)
  return props.engine === 'pele' ? sanitizePeleSvg(props.svg) : sanitizeMermaidSvg(props.svg)
})

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  width: fitMode.value === 'fit' ? '92vw' : 'auto',
  height: fitMode.value === 'fit' ? '92vh' : 'auto',
  maxWidth: fitMode.value === 'fit' ? '92vw' : 'none',
  maxHeight: fitMode.value === 'fit' ? '92vh' : 'none'
}))

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  imgError.value = false
}
watch(() => props.src, reset)
watch(() => props.svg, reset)

/** 以光标为锚点缩放：光标下的像素在缩放前后保持不动。 */
function onWheel(e: WheelEvent) {
  e.preventDefault()
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const cx = e.clientX - box.left - box.width / 2
  const cy = e.clientY - box.top - box.height / 2
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const next = Math.min(10, Math.max(0.2, scale.value * f))
  const k = next / scale.value
  tx.value = cx - (cx - tx.value) * k
  ty.value = cy - (cy - ty.value) * k
  scale.value = next
}

function retry() {
  imgError.value = false
  reloadKey.value++
}

let dragging = false
let sx = 0
let sy = 0
let ox = 0
let oy = 0

function onDown(e: MouseEvent) {
  dragging = true
  sx = e.clientX
  sy = e.clientY
  ox = tx.value
  oy = ty.value
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
function onMove(e: MouseEvent) {
  if (!dragging) return
  tx.value = ox + e.clientX - sx
  ty.value = oy + e.clientY - sy
}
function onUp() {
  dragging = false
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  onUp()
})
</script>

<template>
  <Teleport to="body">
    <div class="lightbox" @wheel="onWheel" @mousedown.prevent="onDown">
      <template v-if="src">
        <img
          v-if="!imgError"
          :key="reloadKey"
          class="lb-img"
          :src="src"
          alt=""
          draggable="false"
          :style="imgStyle"
          @error="imgError = true"
        />
        <div v-else class="lb-error">
          <p>{{ t('lb.loadFailed') }}</p>
          <button type="button" @click.stop="retry">{{ t('lb.retry') }}</button>
        </div>
        <div class="lb-tools">
          <button type="button" @click.stop="fitMode = fitMode === 'fit' ? 'actual' : 'fit'">
            {{ fitMode === 'fit' ? t('lb.actualSize') : t('lb.fitWindow') }}
          </button>
          <button type="button" @click.stop="reset">{{ t('lb.reset') }} 100%</button>
          <span v-if="/\.(gif|webp)$/i.test(src)" class="lb-tip">{{ t('lb.animatedTip') }}</span>
        </div>
      </template>
      <div
        v-else
        class="lb-holder"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        v-html="safeSvg"
      ></div>
      <button class="lb-close" :title="t('lb.close')" @click="emit('close')">✕</button>
    </div>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
}
.lightbox:active {
  cursor: grabbing;
}
/* 默认填满窗口：固定盒尺寸 + object-fit contain，小图放大、大图缩小，均保持比例 */
.lb-img {
  width: 92vw;
  height: 92vh;
  object-fit: contain;
  user-select: none;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
}
.lb-holder {
  width: 92vw;
  height: 92vh;
  padding: 24px;
  background: #fff;
  border-radius: 8px;
  user-select: none;
  display: flex;
  align-items: center;
  justify-content: center;
}
.lb-holder :deep(svg) {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  height: 100%;
}
.lb-close {
  position: fixed;
  top: 14px;
  right: 18px;
  z-index: 1;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  transition: background 0.15s;
  /* 黑色阴影：白色底图片放大时也能看清关闭按钮 */
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.6);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
.lb-close:hover {
  background: rgba(0, 0, 0, 0.75);
}
.lb-tools {
  position: fixed;
  left: 18px;
  bottom: 16px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}
.lb-tools button {
  padding: 5px 10px;
  border: 1px solid rgb(255 255 255 / 30%);
  border-radius: 6px;
  background: rgb(0 0 0 / 45%);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.lb-tools button:hover {
  background: rgb(0 0 0 / 70%);
}
.lb-tip {
  color: rgb(255 255 255 / 75%);
  font-size: 12px;
}
.lb-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  color: #fff;
}
.lb-error button {
  padding: 5px 12px;
  border: 1px solid rgb(255 255 255 / 40%);
  border-radius: 6px;
  background: transparent;
  color: #fff;
  cursor: pointer;
}
</style>
