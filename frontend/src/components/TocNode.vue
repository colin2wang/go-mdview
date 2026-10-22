<script setup lang="ts">
import type { TocEntry } from '../types'

defineProps<{ item: TocEntry; activeId: string }>()
defineEmits<{ (e: 'jump', id: string): void }>()
</script>

<template>
  <li>
    <a
      class="toc-item"
      :class="{ active: activeId === item.id }"
      :title="item.text"
      :data-testid="'toc-' + item.id"
      @click="$emit('jump', item.id)"
      >{{ item.text }}</a
    >
    <ul v-if="item.children.length" class="toc-branch">
      <TocNode
        v-for="c in item.children"
        :key="c.id"
        :item="c"
        :active-id="activeId"
        @jump="$emit('jump', $event)"
      />
    </ul>
  </li>
</template>
