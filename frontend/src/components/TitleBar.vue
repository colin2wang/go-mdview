<script setup lang="ts">
import { computed } from 'vue'
import { store, togglePin, setViewMode } from '../store'
import { getApi } from '../api'
import { t } from '../i18n'
import type { ViewMode } from '../types'
import AppIcon from './AppIcon.vue'

const modes = computed<{ key: ViewMode; label: string; title: string }[]>(() => [
  { key: 'source', label: t('mode.source'), title: t('mode.source.tip') },
  { key: 'render', label: t('mode.render'), title: t('mode.render.tip') },
  { key: 'split', label: t('mode.split'), title: t('mode.split.tip') }
])

const title = computed(() => {
  if (store.current) return `${store.current.path} - mdview`
  return 'mdview'
})

async function min() {
  if (store.desktop) (await getApi()).WindowMin()
}
async function maxToggle() {
  if (store.desktop) (await getApi()).WindowMaxToggle()
}
async function close() {
  if (store.desktop) (await getApi()).WindowClose()
}
async function fullscreen() {
  if (store.desktop) (await getApi()).WindowFullscreenToggle()
}
async function pin() {
  await togglePin()
}
function openSettings() {
  store.settingsOpen = true
}
function dblMax() {
  if (store.desktop) maxToggle()
}
</script>

<template>
  <header class="titlebar" data-testid="titlebar" @dblclick="dblMax">
    <div class="tb-left">
      <span class="tb-icon" aria-hidden="true">
        <AppIcon :size="17" />
      </span>
      <span class="tb-title" :title="title" data-testid="win-title">{{ title }}</span>
    </div>
    <div class="tb-btns">
      <span class="tb-mode" role="radiogroup" :aria-label="t('aria.viewMode')">
        <button
          v-for="m in modes"
          :key="m.key"
          class="tb-mode-btn"
          :class="{ on: store.viewMode === m.key }"
          :disabled="!store.current"
          :title="m.title"
          :data-testid="'btn-mode-' + m.key"
          @click="setViewMode(m.key)"
        >
          {{ m.label }}
        </button>
      </span>
      <button class="tb-btn" :title="t('tip.settings')" data-testid="btn-settings" @click="openSettings">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path
            fill="currentColor"
            d="M8 4.75a3.25 3.25 0 1 0 0 6.5 3.25 3.25 0 0 0 0-6.5ZM6.25 8a1.75 1.75 0 1 1 3.5 0 1.75 1.75 0 0 1-3.5 0Z"
          />
          <path
            fill="currentColor"
            d="M7.94 1.5c-.4 0-.74.28-.82.66l-.24 1.1a5.6 5.6 0 0 0-1.3.75l-1.08-.34a.83.83 0 0 0-.97.38l-1.06 1.83c-.2.35-.12.8.19 1.05l.85.7a5.7 5.7 0 0 0 0 1.5l-.85.7c-.31.25-.4.7-.19 1.05l1.06 1.83c.2.35.62.5.97.38l1.08-.34c.4.3.84.56 1.3.75l.24 1.1c.08.38.43.66.82.66h2.12c.4 0 .74-.28.82-.66l.24-1.1a5.6 5.6 0 0 0 1.3-.75l1.08.34c.35.12.77-.03.97-.38l1.06-1.83c.2-.35.12-.8-.19-1.05l-.85-.7a5.7 5.7 0 0 0 0-1.5l.85-.7c.31-.25.4-.7.19-1.05l-1.06-1.83a.83.83 0 0 0-.97-.38l-1.08.34a5.6 5.6 0 0 0-1.3-.75l-.24-1.1a.83.83 0 0 0-.82-.66H7.94Zm.06 8.75A2.25 2.25 0 1 1 8 5.75a2.25 2.25 0 0 1 0 4.5Z"
          />
        </svg>
      </button>
      <button class="tb-btn" :title="t('tip.fullscreen')" data-testid="btn-fullscreen" @click="fullscreen">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path
            fill="currentColor"
            d="M2 5.5V2.75C2 2.34 2.34 2 2.75 2H5.5a.5.5 0 0 1 0 1H3v2.5a.5.5 0 0 1-1 0Zm12 0V2.75c0-.41-.34-.75-.75-.75H10.5a.5.5 0 0 0 0 1H13v2.5a.5.5 0 0 0 1 0ZM2 10.5v2.75c0 .41.34.75.75.75H5.5a.5.5 0 0 0 0-1H3v-2.5a.5.5 0 0 0-1 0Zm12 0v2.75c0 .41-.34.75-.75.75H10.5a.5.5 0 0 1 0-1H13v-2.5a.5.5 0 0 1 1 0Z"
          />
        </svg>
      </button>
      <button
        class="tb-btn"
        :class="{ 'pin-on': store.settings?.pinned }"
        :title="store.settings?.pinned ? t('tip.unpin') : t('tip.pin')"
        data-testid="btn-pin"
        @click="pin"
      >
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path
            fill="currentColor"
            d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H18v-2c-1.66 0-3-1.34-3-3z"
          />
        </svg>
      </button>
      <span class="tb-sep"></span>
      <button class="tb-btn" :title="t('tip.min')" data-testid="btn-min" @click="min">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <rect x="1.5" y="5.4" width="9" height="1.2" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      <button class="tb-btn" :title="t('tip.max')" data-testid="btn-max" @click="maxToggle">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button class="tb-btn tb-close" :title="t('tip.close')" data-testid="btn-close" @click="close">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path d="M2.3 2.3l7.4 7.4M9.7 2.3l-7.4 7.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </header>
</template>
