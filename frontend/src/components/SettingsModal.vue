<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { store, patchSettings, setViewMode, togglePin, toast } from '../store'
import { getApi } from '../api'
import type { AssocState, ViewMode } from '../types'
import { defaultAssocState } from '../types'

const open = computed(() => store.settingsOpen)
const st = computed(() => store.settings)

const viewModes: { key: ViewMode; label: string }[] = [
  { key: 'render', label: '渲染' },
  { key: 'source', label: '源码' },
  { key: 'split', label: '对照' }
]

function close() {
  store.settingsOpen = false
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
// 弹窗打开期间接管 Esc；关闭时摘掉监听
watch(open, (v) => {
  if (v) {
    window.addEventListener('keydown', onKey)
    void refreshAssoc()
  } else {
    window.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function setThemeEvt(v: string) {
  patchSettings({ theme: v })
}
function setFs(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) patchSettings({ fontSize: v })
}
function setWrap(e: Event) {
  patchSettings({ codeWrap: (e.target as HTMLInputElement).checked })
}
function setPinned() {
  // 走 togglePin：既写设置也立刻应用到窗口
  void togglePin()
}
function setViewModeEvt(v: ViewMode) {
  setViewMode(v)
}

// ---------- 文件关联 ----------
const assoc = ref<AssocState>({ ...defaultAssocState })
const assocBusy = ref(false)

async function refreshAssoc() {
  try {
    const api = await getApi()
    assoc.value = await api.GetAssocState()
  } catch (e) {
    assoc.value = { ...defaultAssocState, message: String(e) }
  }
}

async function toggleAssoc() {
  if (assocBusy.value || !assoc.value.supported) return
  assocBusy.value = true
  try {
    const api = await getApi()
    if (assoc.value.associated) {
      await api.UnassociateMd()
      toast('已取消 .md 文件关联')
    } else {
      await api.AssociateMd()
      toast('已将 .md 关联到 mdview')
    }
  } catch (e) {
    toast(`操作失败：${String(e)}`, 'error')
  } finally {
    await refreshAssoc()
    assocBusy.value = false
  }
}

const assocLabel = computed(() => {
  if (!assoc.value.supported) return '当前系统不支持'
  if (assocBusy.value) return '处理中…'
  return assoc.value.associated ? '取消关联' : '关联到 mdview'
})
const assocTip = computed(() => {
  if (assoc.value.associated) return '还原为关联前的默认程序'
  return assoc.value.owner && assoc.value.owner !== '（未设置）'
    ? `当前默认打开方式：${assoc.value.owner}`
    : '把 .md / .markdown 的默认打开方式设为 mdview'
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" data-testid="settings-mask" @click.self="close">
      <div class="modal" data-testid="settings-modal" @keydown.esc="close">
        <div class="modal-head">
          <h3>设置</h3>
          <button class="modal-x" title="关闭" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <section class="set-block">
            <h4 class="set-block-title">外观</h4>
            <!-- 用 div 而非 label：label 会把点击转发给首个可关联控件，导致点“主题”二字误触发浅色 -->
            <div class="set-row">
              <span class="set-label">主题</span>
              <span class="set-seg" role="radiogroup">
                <button
                  class="seg-btn"
                  :class="{ on: st?.theme === 'light' }"
                  data-testid="theme-light"
                  @click="setThemeEvt('light')"
                >
                  浅色
                </button>
                <button
                  class="seg-btn"
                  :class="{ on: st?.theme === 'dark' }"
                  data-testid="theme-dark"
                  @click="setThemeEvt('dark')"
                >
                  深色
                </button>
              </span>
            </div>
            <div class="set-row">
              <span class="set-label">正文字号</span>
              <span class="set-val">
                <input
                  type="range"
                  min="12"
                  max="28"
                  step="1"
                  :value="st?.fontSize ?? 16"
                  data-testid="font-range"
                  @input="setFs"
                />
                <b class="fs-num" data-testid="font-num">{{ st?.fontSize ?? 16 }}px</b>
              </span>
            </div>
            <div class="set-row">
              <span class="set-label">代码块自动换行</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.codeWrap ?? false"
                data-testid="wrap-check"
                @change="setWrap"
              />
            </div>
          </section>

          <section class="set-block">
            <h4 class="set-block-title">阅读</h4>
            <div class="set-row">
              <span class="set-label">默认视图</span>
              <span class="set-seg" role="radiogroup">
                <button
                  v-for="m in viewModes"
                  :key="m.key"
                  class="seg-btn"
                  :class="{ on: (st?.viewMode ?? 'render') === m.key }"
                  :data-testid="'view-' + m.key"
                  @click="setViewModeEvt(m.key)"
                >
                  {{ m.label }}
                </button>
              </span>
            </div>
            <p class="set-hint">「对照」为左右分栏：左侧 Markdown 源码、右侧渲染结果，可拖拽中缝调整比例。</p>
            <div class="set-row">
              <span class="set-label">窗口置顶</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.pinned ?? false"
                data-testid="pin-check"
                @change="setPinned"
              />
            </div>
          </section>

          <section class="set-block">
            <h4 class="set-block-title">文件关联</h4>
            <div class="set-row">
              <span class="set-label">
                .md / .markdown 默认用 mdview 打开
                <em class="set-sub">（同时设置文件图标，可随时取消）</em>
              </span>
              <button
                class="set-btn"
                :class="{ danger: assoc.associated }"
                :disabled="!assoc.supported || assocBusy"
                :title="assocTip"
                data-testid="assoc-btn"
                @click="toggleAssoc"
              >
                {{ assocLabel }}
              </button>
            </div>
            <p class="set-hint" data-testid="assoc-state">
              <span v-if="!assoc.supported">{{ assoc.message || '当前系统不支持文件关联' }}</span>
              <span v-else-if="assoc.associated">已关联：双击 .md 文件会用 mdview 打开（图标取自 mdview.exe）</span>
              <span v-else>未关联 · 当前默认打开方式：{{ assoc.owner || '（未设置）' }}</span>
            </p>
          </section>

          <div class="set-about">
            <p><b>mdview</b> · Go + Wails 构建的轻量 Markdown 阅读器</p>
            <p class="sub">拖拽 .md 进窗口即可打开；右键菜单可切换主题、导出 HTML；标题栏可切换渲染/源码/对照。</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
