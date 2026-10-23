<script setup lang="ts">
/**
 * 底部状态栏（借鉴 mdeditor 的 footer.statusbar）：
 * 左侧文件名 + 编码/体积，右侧「原始字数 / 预览字数 / 行数 / 行,列」。
 * 数据由 Viewer 写入 status.ts，这里只做展示。
 */
import { computed } from 'vue'
import { store } from '../store'
import { status } from '../status'
import { t } from '../i18n'

const leftText = computed(() => {
  const c = store.current
  if (!c) return t('status.ready')
  return status.summary ? `${c.name} · ${status.summary}` : c.name
})
</script>

<template>
  <footer class="statusbar" data-testid="statusbar">
    <span class="status-left" :title="store.current?.path ?? ''">{{ leftText }}</span>
    <div class="statusbar-right">
      <span data-testid="stat-chars">{{ t('status.chars') }}: {{ status.chars }}</span>
      <span data-testid="stat-preview">{{ t('status.previewChars') }}: {{ status.previewChars }}</span>
      <span data-testid="stat-lines">{{ t('status.lines') }}: {{ status.lines }}</span>
      <span v-if="status.editing" data-testid="stat-caret">
        {{ t('status.cursor', { line: status.caretLine, col: status.caretCol }) }}
      </span>
    </div>
  </footer>
</template>
