<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 全屏图片灯箱：滚轮缩放、拖拽平移，ESC / 右上角 ✕ 关闭。
 * src 为图片地址；svg 为内联 SVG 文本（Mermaid / SVG 图形卡片双击时使用）。
 */
const props = defineProps<{ src?: string; svg?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}
watch(() => props.src, reset)
watch(() => props.svg, reset)

function onWheel(e: WheelEvent) {
  e.preventDefault()
  const f = e.deltaY < 0 ? 1.15 : 1 / 1.15
  scale.value = Math.min(10, Math.max(0.2, scale.value * f))
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
      <img
        v-if="src"
        class="lb-img"
        :src="src"
        alt=""
        draggable="false"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
      />
      <div
        v-else
        class="lb-holder"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        v-html="svg"
      ></div>
      <button class="lb-close" title="关闭 (Esc)" @click="emit('close')">✕</button>
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
.lb-img {
  max-width: 92vw;
  max-height: 92vh;
  user-select: none;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
}
.lb-holder {
  max-width: 92vw;
  max-height: 92vh;
  padding: 24px;
  background: #fff;
  border-radius: 8px;
  user-select: none;
}
.lb-holder :deep(svg) {
  max-width: 86vw;
  max-height: 86vh;
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
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  transition: background 0.15s;
}
.lb-close:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>
