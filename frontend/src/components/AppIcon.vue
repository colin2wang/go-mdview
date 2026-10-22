<script lang="ts">
// 模块级计数器：保证同页面多个实例拿到的渐变 id 不重复
let iconSeq = 0
</script>

<script setup lang="ts">
import { computed } from 'vue'

// mdview 图标（与 assets/mdview-icon.svg 同形）：蓝色圆角方块 + 白色粗体 M。
// M 用描边折线绘制，避免依赖系统字体。
const props = withDefaults(defineProps<{ size?: number }>(), { size: 16 })

const gradId = computed(() => `mdv-icon-bg-${++iconSeq}`)
const px = computed(() => `${props.size}px`)
</script>

<template>
  <svg class="app-icon" :width="px" :height="px" viewBox="0 0 1024 1024" aria-hidden="true">
    <defs>
      <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3474F4" />
        <stop offset="0.5" stop-color="#3474F4" />
        <stop offset="0.5" stop-color="#2B64E6" />
        <stop offset="1" stop-color="#2B64E6" />
      </linearGradient>
    </defs>
    <rect x="28" y="28" width="968" height="968" rx="200" ry="200" :fill="`url(#${gradId})`" />
    <path
      d="M250 690V330L512 640L774 330V690"
      fill="none"
      stroke="#fff"
      stroke-width="148"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: none;
}
</style>
