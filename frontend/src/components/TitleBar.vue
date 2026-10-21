<script setup lang="ts">
import { computed } from 'vue'
import { store, togglePin, toggleSource } from '../store'
import { getApi } from '../api'

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
        <svg viewBox="0 0 24 24" width="16" height="16">
          <rect x="1" y="1" width="22" height="22" rx="5" fill="#2563eb" />
          <path
            d="M6 17V7.2c0-.4.5-.6.8-.3l3.7 4.4c.3.3.7.3 1 0l3.7-4.4c.3-.3.8-.1.8.3V17"
            stroke="#fff"
            stroke-width="2.1"
            fill="none"
            stroke-linecap="round"
          />
        </svg>
      </span>
      <span class="tb-title" :title="title" data-testid="win-title">{{ title }}</span>
    </div>
    <div class="tb-btns">
      <button
        class="tb-btn"
        :class="{ on: store.showSource }"
        :disabled="!store.current"
        :title="store.showSource ? '返回渲染视图' : '显示源码'"
        data-testid="btn-source"
        @click="toggleSource"
      >
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path
            d="M6 4 2.5 8 6 12M10 4l3.5 4-3.5 4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="tb-btn" title="设置" data-testid="btn-settings" @click="openSettings">
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
      <button class="tb-btn" title="全屏" data-testid="btn-fullscreen" @click="fullscreen">
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path
            fill="currentColor"
            d="M2 5.5V2.75C2 2.34 2.34 2 2.75 2H5.5a.5.5 0 0 1 0 1H3v2.5a.5.5 0 0 1-1 0Zm12 0V2.75c0-.41-.34-.75-.75-.75H10.5a.5.5 0 0 0 0 1H13v2.5a.5.5 0 0 0 1 0ZM2 10.5v2.75c0 .41.34.75.75.75H5.5a.5.5 0 0 0 0-1H3v-2.5a.5.5 0 0 0-1 0Zm12 0v2.75c0 .41-.34.75-.75.75H10.5a.5.5 0 0 1 0-1H13v-2.5a.5.5 0 0 1 1 0Z"
          />
        </svg>
      </button>
      <button
        class="tb-btn"
        :class="{ on: store.settings?.pinned }"
        title="置顶"
        data-testid="btn-pin"
        @click="pin"
      >
        <svg viewBox="0 0 16 16" width="15" height="15">
          <path
            fill="currentColor"
            d="M9.5 1.5a.5.5 0 0 0-1 0v4.02L5.07 7.34c-.35.15-.57.5-.57.88v.28c0 .28.22.5.5.5h2.5v3.1l-1.1 1.6a.5.5 0 0 0 .4.8h2.9a.5.5 0 0 0 .4-.8l-1.1-1.6V9h2.5c.28 0 .5-.22.5-.5v-.28c0-.38-.22-.73-.57-.88L7.5 5.52V1.5h2Z"
            transform="translate(0.5 0)"
          />
        </svg>
      </button>
      <span class="tb-sep"></span>
      <button class="tb-btn" title="最小化" data-testid="btn-min" @click="min">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <rect x="1.5" y="5.4" width="9" height="1.2" rx="0.6" fill="currentColor" />
        </svg>
      </button>
      <button class="tb-btn" title="最大化/还原" data-testid="btn-max" @click="maxToggle">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <rect x="2" y="2" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button class="tb-btn tb-close" title="关闭" data-testid="btn-close" @click="close">
        <svg viewBox="0 0 12 12" width="12" height="12">
          <path d="M2.3 2.3l7.4 7.4M9.7 2.3l-7.4 7.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </header>
</template>
