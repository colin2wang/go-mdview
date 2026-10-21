<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../store'

const items = computed(() => store.toc)
const minDepth = computed(() => items.value.reduce((m, x) => Math.min(m, x.depth), 6))

function jump(id: string) {
  const el = document.getElementById(id)
  const scroller = document.querySelector('.viewer-scroll')
  if (el && scroller) {
    // 用相对偏移，配合 scroll-margin-top 留白
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTo({ top: scroller.scrollTop + top - 8, behavior: 'smooth' })
  }
}
</script>

<template>
  <div class="panel" data-testid="toc-panel">
    <p v-if="!items.length" class="panel-empty">打开文档后显示大纲</p>
    <ul v-else class="toc-list">
      <li v-for="it in items" :key="it.id">
        <a
          class="toc-item"
          :class="{ active: store.activeHeading === it.id }"
          :style="{ paddingLeft: (it.depth - minDepth) * 14 + 8 + 'px' }"
          :title="it.text"
          :data-testid="'toc-' + it.id"
          @click="jump(it.id)"
          >{{ it.text }}</a
        >
      </li>
    </ul>
  </div>
</template>
