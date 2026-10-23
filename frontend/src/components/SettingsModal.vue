<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { store, patchSettings, setViewMode, togglePin, toast } from '../store'
import { getApi } from '../api'
import { t, LANGS } from '../i18n'
import type { AssocState, ViewMode } from '../types'
import { defaultAssocState } from '../types'

const open = computed(() => store.settingsOpen)
const st = computed(() => store.settings)

const viewModes = computed<{ key: ViewMode; label: string }[]>(() => [
  { key: 'render', label: t('mode.render') },
  { key: 'source', label: t('mode.source') },
  { key: 'split', label: t('mode.split') }
])

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
function setLineNo(e: Event) {
  patchSettings({ lineNo: (e.target as HTMLInputElement).checked })
}
function setPinned() {
  // 走 togglePin：既写设置也立刻应用到窗口
  void togglePin()
}
function setViewModeEvt(v: ViewMode) {
  setViewMode(v)
}
// 切语言：走 patchSettings 持久化，applySettings 里的 setLang 让全界面即时生效
function setLangEvt(v: string) {
  patchSettings({ language: v })
}

// ---------- 重启 ----------
// Go 端先清空记住的窗口几何与侧栏宽度，再拉起新进程退出自己（新进程会恢复默认大小、位置与侧栏宽度）
async function restartApp() {
  try {
    const api = await getApi()
    await api.RestartApp()
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
  }
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
      toast(t('toast.assocUndone'))
    } else {
      await api.AssociateMd()
      toast(t('toast.assocDone'))
    }
  } catch (e) {
    toast(t('toast.opFailed', { e: String(e) }), 'error')
  } finally {
    await refreshAssoc()
    assocBusy.value = false
  }
}

const assocLabel = computed(() => {
  if (!assoc.value.supported) return t('assoc.unsupported')
  if (assocBusy.value) return t('assoc.busy')
  return assoc.value.associated ? t('assoc.unassociate') : t('assoc.associate')
})
const assocTip = computed(() => {
  if (assoc.value.associated) return t('assoc.tipRestore')
  return assoc.value.owner && assoc.value.owner !== t('assoc.ownerNone')
    ? t('assoc.tipOwner', { owner: assoc.value.owner })
    : t('assoc.tipSet')
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" data-testid="settings-mask" @click.self="close">
      <div class="modal" data-testid="settings-modal" @keydown.esc="close">
        <div class="modal-head">
          <h3>{{ t('set.title') }}</h3>
          <button class="modal-x" :title="t('tip.close')" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <section class="set-block">
            <h4 class="set-block-title">{{ t('set.appearance') }}</h4>
            <!-- 用 div 而非 label：label 会把点击转发给首个可关联控件，导致点“主题”二字误触发浅色 -->
            <div class="set-row">
              <span class="set-label">{{ t('set.theme') }}</span>
              <span class="set-seg" role="radiogroup">
                <button
                  class="seg-btn"
                  :class="{ on: st?.theme === 'light' }"
                  data-testid="theme-light"
                  @click="setThemeEvt('light')"
                >
                  {{ t('set.light') }}
                </button>
                <button
                  class="seg-btn"
                  :class="{ on: st?.theme === 'dark' }"
                  data-testid="theme-dark"
                  @click="setThemeEvt('dark')"
                >
                  {{ t('set.dark') }}
                </button>
              </span>
            </div>
            <div class="set-row">
              <span class="set-label">{{ t('set.language') }}</span>
              <span class="set-seg" role="radiogroup">
                <button
                  v-for="l in LANGS"
                  :key="l.key"
                  class="seg-btn"
                  :class="{ on: (st?.language ?? 'zh-CN') === l.key }"
                  :data-testid="'lang-' + l.key"
                  @click="setLangEvt(l.key)"
                >
                  {{ l.label }}
                </button>
              </span>
            </div>
            <div class="set-row">
              <span class="set-label">{{ t('set.fontSize') }}</span>
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
              <span class="set-label">{{ t('set.codeWrap') }}</span>
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
            <h4 class="set-block-title">{{ t('set.reading') }}</h4>
            <div class="set-row">
              <span class="set-label">{{ t('set.defaultView') }}</span>
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
            <p class="set-hint">{{ t('set.splitHint') }}</p>
            <div class="set-row">
              <span class="set-label">{{ t('set.lineNo') }}</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.lineNo ?? true"
                data-testid="lineNo-check"
                @change="setLineNo"
              />
            </div>
            <div class="set-row">
              <span class="set-label">{{ t('set.pin') }}</span>
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
            <h4 class="set-block-title">{{ t('set.window') }}</h4>
            <div class="set-row">
              <span class="set-label">{{ t('set.windowGeom') }}</span>
              <button class="set-btn" data-testid="restart-btn" @click="restartApp">
                {{ t('set.restart') }}
              </button>
            </div>
            <p class="set-hint">{{ t('set.restartHint') }}</p>
          </section>

          <section class="set-block">
            <h4 class="set-block-title">{{ t('set.assoc.title') }}</h4>
            <div class="set-row">
              <span class="set-label">
                {{ t('set.assoc.label') }}
                <em class="set-sub">{{ t('set.assoc.sub') }}</em>
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
              <span v-if="!assoc.supported">{{ assoc.message || t('assoc.unsupportedMsg') }}</span>
              <span v-else-if="assoc.associated">{{ t('assoc.stateAssociated') }}</span>
              <span v-else>{{ t('assoc.stateUnassociated', { owner: assoc.owner || t('assoc.ownerNone') }) }}</span>
            </p>
          </section>

          <div class="set-about">
            <p><b>mdview</b> · {{ t('set.about.desc') }}</p>
            <p class="sub">{{ t('set.about.hint') }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
