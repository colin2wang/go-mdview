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
  { key: 'split', label: t('mode.split') },
  { key: 'mindmap', label: t('mode.mindmap') }
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
    void refreshBuildInfo()
  } else {
    window.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// 编译信息（build.ps1 经 ldflags 注入；开发态显示 dev）
const buildInfo = ref('')
const buildLabel = computed(() => {
  if (!buildInfo.value) return ''
  // ISO 串转显示格式：2026-11-01T14:14:23Z → 2026-11-01 14:14:23
  return buildInfo.value.replace('T', ' ').replace(/Z$/, '')
})
async function refreshBuildInfo() {
  try {
    const api = await getApi()
    buildInfo.value = await api.BuildInfo()
  } catch {
    buildInfo.value = ''
  }
}

function setThemeEvt(v: string) {
  patchSettings({ theme: v })
}
// 滑块拖动（@input）只更新本地显示，松手（@change）才写盘——
// 一次拖动几十格，原来每格都触发 patchSettings → Go 端原子写
const fsLocal = ref<number | null>(null)
const mmLocal = ref<number | null>(null)
function setFsInput(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) fsLocal.value = v
}
function setFs(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) patchSettings({ fontSize: v })
}
// 思维导图节点/备注单行最大字符数（Go 端 8–60 校验，超界回落默认 20）
function setMmMaxLenInput(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) mmLocal.value = v
}
function setMmMaxLen(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!Number.isNaN(v)) patchSettings({ mmMaxLen: v })
}
function setWrap(e: Event) {
  patchSettings({ codeWrap: (e.target as HTMLInputElement).checked })
}
function setLineNo(e: Event) {
  patchSettings({ lineNo: (e.target as HTMLInputElement).checked })
}
function setAutoReload(e: Event) {
  patchSettings({ autoReload: (e.target as HTMLInputElement).checked })
}
function setBlockRemote(e: Event) {
  patchSettings({ blockRemote: (e.target as HTMLInputElement).checked })
}
function setRemoteAllow(e: Event) {
  const v = (e.target as HTMLTextAreaElement).value
  // 每行一个通配符模式；去掉行尾空白
  patchSettings({ remoteAllow: v.split(/\r?\n/).map((s) => s.replace(/\s+$/, '')).join('\n') })
}
// 启用 yml 配置源：SaveSettings 检测到 useYaml 且文件缺失时会创建带英文注释的
// mdview.yml（exe 同目录），此后读写都走 yml，settings.json 冻结不再更新
function setUseYaml(e: Event) {
  patchSettings({ useYaml: (e.target as HTMLInputElement).checked })
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
          <div class="set-col">
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
                  :value="fsLocal ?? st?.fontSize ?? 16"
                  data-testid="font-range"
                  @input="setFsInput"
                  @change="setFs"
                />
                <b class="fs-num" data-testid="font-num">{{ fsLocal ?? st?.fontSize ?? 16 }}px</b>
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
          </section>

          <section class="set-block">
            <h4 class="set-block-title">{{ t('set.window') }}</h4>
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
          </div>

          <div class="set-col">
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
              <span class="set-label">
                {{ t('set.mmMaxLen') }}
                <em class="set-sub">{{ t('set.mmMaxLenHint') }}</em>
              </span>
              <span class="set-val">
                <input
                  type="range"
                  min="8"
                  max="60"
                  step="1"
                  :value="mmLocal ?? st?.mmMaxLen ?? 20"
                  data-testid="mmmaxlen-range"
                  @input="setMmMaxLenInput"
                  @change="setMmMaxLen"
                />
                <b class="fs-num" data-testid="mmmaxlen-num">{{ mmLocal ?? st?.mmMaxLen ?? 20 }}</b>
              </span>
            </div>
            <div class="set-row">
              <span class="set-label">{{ t('set.autoReload') }}</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.autoReload ?? true"
                data-testid="autoReload-check"
                @change="setAutoReload"
              />
            </div>
            <p class="set-hint">{{ t('set.autoReloadHint') }}</p>
          </section>

          <section class="set-block">
            <h4 class="set-block-title">{{ t('set.network') }}</h4>
            <div class="set-row">
              <span class="set-label">{{ t('set.blockRemote') }}</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.blockRemote ?? true"
                data-testid="blockRemote-check"
                @change="setBlockRemote"
              />
            </div>
            <p class="set-hint">{{ t('set.blockRemoteHint') }}</p>
            <template v-if="st?.blockRemote ?? true">
              <div class="set-row">
                <span class="set-label">{{ t('set.remoteAllow') }}</span>
              </div>
              <textarea
                class="set-textarea"
                rows="4"
                :value="st?.remoteAllow ?? ''"
                data-testid="remoteAllow-text"
                :placeholder="t('set.remoteAllowHint')"
                spellcheck="false"
                @change="setRemoteAllow"
              ></textarea>
              <p class="set-hint">{{ t('set.remoteAllowHint') }}</p>
            </template>
            <div class="set-row">
              <span class="set-label">{{ t('set.useYaml') }}</span>
              <input
                type="checkbox"
                class="set-switch"
                :checked="st?.useYaml ?? false"
                data-testid="useYaml-check"
                @change="setUseYaml"
              />
            </div>
            <p class="set-hint">{{ t('set.useYamlHint') }}</p>
          </section>
          </div>

          <div class="set-about">
            <p><b>mdview</b> · {{ t('set.about.desc') }} <span v-if="buildLabel" class="build-info">(build {{ buildLabel }})</span></p>
            <p class="sub">{{ t('set.about.hint') }}</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
