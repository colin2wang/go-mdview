/**
 * markdown.ts 与 scripts/sanitize-check.mjs 共用的净化逻辑。
 * DOMPurify 配置仍唯一来自 sanitize-config.json；这里只放两侧必须逐字一致的
 * hook（远程 URL 拦截、良性 button / checkbox 保留）与 URL 判定，避免两处手抄漂移。
 * 本文件是普通 ESM JS（无 TS 语法），由 .d.ts 提供类型。
 */

let activeState = null
const hooked = new WeakSet()

/** 把配置拆成 DOMPurify 配置 + hook 需要的清单。 */
export function splitConfig(config) {
  const cfg = { ...config }
  const remoteAttrs = cfg.X_REMOTE_ATTRS ?? ['src', 'srcset', 'poster', 'data', 'background', 'xlink:href']
  const remoteHrefTags = cfg.X_REMOTE_HREF_TAGS ?? ['image', 'use']
  const inputAllowAttrs = cfg.X_INPUT_ALLOW_ATTRS ?? ['type', 'checked', 'disabled', 'name', 'id', 'class']
  const svgProfiles = cfg.X_SVG_USE_PROFILES ?? { svg: true, svgFilters: true }
  const svgForbidTags = cfg.X_SVG_FORBID_TAGS ?? ['script', 'foreignObject', 'style']
  for (const key of ['X_REMOTE_ATTRS', 'X_REMOTE_HREF_TAGS', 'X_INPUT_ALLOW_ATTRS', 'X_SVG_USE_PROFILES', 'X_SVG_FORBID_TAGS']) {
    delete cfg[key]
  }
  return { cfg, remoteAttrs, remoteHrefTags, inputAllowAttrs, svgProfiles, svgForbidTags }
}

/** 远程图片（http/https/协议相对）判定。 */
export function isRemoteSrc(href) {
  return /^(https?:)?\/\//i.test(String(href ?? '').trim())
}

/** 远程资源白名单：URL 通配符模式（* 任意串、? 单字符），多值每行一个，不区分大小写。 */
export function remoteAllowed(href, allow) {
  const patterns = (allow ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!patterns.length) return false
  return patterns.some((p) => {
    const re = new RegExp(
      '^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'
    )
    return re.test(href)
  })
}

/** srcset 里的 URL 列表（去掉描述符）。 */
function srcsetUrls(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean)
}

/**
 * 单次净化的上下文。JS 单线程且 DOMPurify.sanitize 是同步的，
 * 模块级 activeState 在 withState 内有效，不会被并发调用改写。
 */
export function createState(blockRemote, remoteAllow, placeholder, blockedLabel) {
  return { blockRemote: !!blockRemote, remoteAllow: remoteAllow ?? '', placeholder, blockedLabel: blockedLabel ?? '' }
}

export function withState(state, fn) {
  const prev = activeState
  activeState = state
  try {
    return fn()
  } finally {
    activeState = prev
  }
}

/** 安装一次 hook（按 DOMPurify 实例去重）。 */
export function installHooks(DOMPurify, parts) {
  if (hooked.has(DOMPurify)) return
  hooked.add(DOMPurify)
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const state = activeState
    if (!state || !node || typeof node.getAttribute !== 'function') return
    const tag = String(node.tagName ?? '').toLowerCase()

    // 良性控件保留：input 仅放行 checkbox，button 剥掉 form* 危险属性。
    // 用户 HTML 里的恶意 button 仍会被 FORBID_ATTR(formaction 等) 拆解，无法提交表单。
    if (tag === 'input') {
      const type = String(node.getAttribute('type') ?? '').toLowerCase()
      if (type !== 'checkbox') {
        node.parentNode?.removeChild?.(node)
        return
      }
      for (const a of Array.from(node.attributes ?? [])) {
        const name = a.name.toLowerCase()
        if (!parts.inputAllowAttrs.includes(name) && !name.startsWith('data-') && !name.startsWith('aria-')) {
          node.removeAttribute(a.name)
        }
      }
    } else if (tag === 'button') {
      for (const a of Array.from(node.attributes ?? [])) {
        const name = a.name.toLowerCase()
        if (name.startsWith('form') || name.startsWith('on')) node.removeAttribute(a.name)
      }
    }

    if (!state.blockRemote) return
    const blocked = (attr) => {
      const val = node.getAttribute(attr)
      if (!val) return
      const urls = attr === 'srcset' ? srcsetUrls(val) : [String(val).trim()]
      if (!urls.length) return
      if (urls.every((u) => !isRemoteSrc(u) || remoteAllowed(u, state.remoteAllow))) return
      node.setAttribute(attr, typeof state.placeholder === 'function' ? state.placeholder() : String(state.placeholder ?? ''))
      if (state.blockedLabel && node.hasAttribute('alt')) node.setAttribute('alt', state.blockedLabel)
      else if (state.blockedLabel && tag === 'img') node.setAttribute('alt', state.blockedLabel)
    }
    for (const attr of parts.remoteAttrs) blocked(attr)
    // <a href> 是点击导航、不是自动请求，保持外链可用；SVG 内的 href 会把资源加载进来。
    if (parts.remoteHrefTags.includes(tag) || node.namespaceURI === 'http://www.w3.org/2000/svg') {
      for (const attr of ['href', 'xlink:href']) blocked(attr)
    }
  })
}

/** 统一净化出口：配置 + hook 均由共用模块提供。 */
export function sanitizeWith(DOMPurify, parts, html, state, overrides) {
  installHooks(DOMPurify, parts)
  return withState(state, () =>
    DOMPurify.sanitize(html, overrides ? { ...parts.cfg, ...overrides } : parts.cfg)
  )
}

/** SVG 专用配置（从唯一配置源派生，不再手抄第二份）。 */
export function svgConfig(parts, allowStyle = false) {
  const forbid = allowStyle ? parts.svgForbidTags.filter((x) => x !== 'style') : parts.svgForbidTags
  return {
    USE_PROFILES: parts.svgProfiles,
    FORBID_TAGS: forbid,
    FORBID_ATTR: parts.cfg.FORBID_ATTR ?? ['style']
  }
}

/**
 * Mermaid 输出专用配置：节点文字在 securityLevel:'strict' 下仍渲染于
 * <foreignObject>（htmlLabels），SVG profile 不含它和内部的 HTML 标签，
 * 全部放行文字才会显示。仅用于 mermaid.render 的产物（strict 已转义标签内容，
 * 且仍过 DOMPurify + hook），用户手写的内联 SVG 保持 svgConfig 的严格口径。
 */
export function mermaidSvgConfig(parts) {
  // DOMPurify 先查 FORBID_TAGS，ADD_TAGS 盖不掉禁表里的 foreignObject；
  // 留在禁表里会连同节点文字一起删除，图上只剩空框。
  const forbid = parts.svgForbidTags.filter((tag) => !/^(style|foreignobject)$/i.test(String(tag)))
  return {
    ...svgConfig(parts, true),
    FORBID_TAGS: forbid,
    ADD_TAGS: ['foreignObject', 'div', 'span', 'p', 'br', 'b', 'i', 'em', 'strong', 'code', 'table', 'tr', 'td', 'th'],
    // foreignObject 内的标签是 HTML 命名空间，DOMPurify 默认只在 annotation-xml
    // 里允许 HTML；不登记 foreignObject 会把 div 等连带文字一起删掉。
    // 配置必须是小写键的对象（数组会变成 {'0': ...} 而失效）。
    HTML_INTEGRATION_POINTS: { 'annotation-xml': true, foreignobject: true }
    // 不要覆盖 FORBID_CONTENTS：保留 DOMPurify 对 script 等危险内容的默认处理。
  }
}

/** 原始 SVG 字符串里的远程 / data: 引用先清空（纵深防御，DOMPurify hook 再兜底）。 */
export function stripSvgExternalRefs(code) {
  return String(code ?? '')
    .replace(/\s(xlink:href|href|src)\s*=\s*(["'])(?:https?:)?\/\/[^"']*\2/gi, ' $1=""')
    .replace(/\s(xlink:href|href|src)\s*=\s*(["'])data:[^"']*\2/gi, ' $1=""')
}
