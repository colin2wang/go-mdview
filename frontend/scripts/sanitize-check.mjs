// sanitizer 回归验证脚本：直接驱动 frontend/src 用的同一份 DOMPurify 配置
// 与同一份 hook（sanitize-common.js），jsdom 提供真实 DOM 解析。
// 除基础用例外，还覆盖已知绕过向量、良性控件保留与远程 URL 属性拦截。
import { JSDOM } from 'jsdom'
import { createRequire } from 'module'
import {
  createState,
  remoteAllowed,
  sanitizeWith,
  splitConfig,
  stripSvgExternalRefs,
  svgConfig
} from '../src/sanitize-common.js'

const require = createRequire(import.meta.url)
const DOMPurifyPkg = require('dompurify')

// 配置唯一来源：src/sanitize-config.json（src/markdown.ts 同样引用它）
const sanitizeConfig = require('../src/sanitize-config.json')
const parts = splitConfig(sanitizeConfig)
const window = new JSDOM('').window
const DOMPurify = DOMPurifyPkg(window)
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// 与 src/markdown.ts sanitizeHtml 完全同一出口（配置 + hook 共用）
function sanitizeHtml(html, blockRemote = true, remoteAllow = '') {
  return sanitizeWith(
    DOMPurify,
    parts,
    html,
    createState(blockRemote, remoteAllow, PLACEHOLDER, 'blocked')
  )
}

// 危险子串：输出中出现任何一条即视为失败
const DANGEROUS = ['<script', 'javascript:', 'onerror', 'onload', 'formaction', 'http-equiv', '<base', '<meta', '<style', '<iframe', 'url(']

let fail = 0

function check(ok, name, detail) {
  if (!ok) fail++
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : `\n  ${detail}`))
}

// ---------- 基础用例：恶意 payload 必须被清除 ----------
const hostile = [
  ['<script>alert(1)</script>ok', 'script 块删除'],
  ['<img src=x onerror=alert(1)>', '无引号 onerror 删除'],
  ['<img src="x" onerror="alert(1)">', '双引号 onerror 删除'],
  ["<img src='x' onerror='alert(1)'>", '单引号 onerror 删除'],
  ['<a href="javascript:alert(1)">c</a>', 'javascript: href 删除'],
  ["<a href='vbscript:x'>c</a>", 'vbscript: href 删除'],
  ['<svg onload=alert(1)></svg>', 'svg onload 删除'],
  ['<iframe src="//evil"></iframe>', 'iframe 删除'],
]

// ---------- 绕过向量（旧正则实现全部放行）----------
const bypass = [
  ['<a href="&#106;avascript:alert(1)">click</a>', 'HTML 实体解码绕过'],
  ['<a href="jav&#x09;ascript:alert(1)">click</a>', '制表符实体绕过'],
  ['<button formaction="javascript:alert(1)">go</button>', 'formaction 绕过'],
  ['<meta http-equiv="refresh" content="0;url=https://evil.tld">', 'meta refresh 跳转'],
  ['<base href="https://evil.tld/">', 'base 劫持相对路径'],
  ['<style>body{background:url(https://evil.tld/beacon)}</style>', 'style url() 外发请求'],
  ['<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', 'svg animate 协议绕过'],
  ['<img src="https://evil.tld/track.png">', '远程追踪图片 src 拦截'],
  ['<img srcset="https://evil.tld/a.png 1x, /mdimg/abc.png 2x">', '远程 srcset 拦截'],
  ['<video poster="https://evil.tld/p.png"></video>', '远程 poster 拦截'],
  ['<object data="https://evil.tld/x.html"></object>', '远程 object[data] 拦截'],
  ['<svg><image xlink:href="https://evil.tld/i.png"/></svg>', 'SVG xlink:href 远程拦截'],
  ['<svg><use href="//evil.tld/i.svg#x"/></svg>', 'SVG use href 远程拦截'],
]

for (const [input, name] of [...hostile, ...bypass]) {
  const got = sanitizeHtml(input)
  const hit = DANGEROUS.filter((d) => got.toLowerCase().includes(d))
  check(hit.length === 0 && !got.includes('evil.tld'), name, `in: ${input}\n  got: ${got}\n  残留: ${hit.join(', ')}`)
}

// ---------- 脚注旁路：脚注内容在整段 sanitize 之后追加，必须单独净化 ----------
const fnPayload = '<p><img src=x onerror=alert(1)></p><style>url(https://evil.tld)</style>'
const fnGot = sanitizeHtml(fnPayload)
check(!fnGot.includes('onerror') && !fnGot.includes('<style') && !fnGot.includes('evil.tld'), '脚注内容单独净化', `got: ${fnGot}`)

// ---------- 良性内容必须保留（此前 FORBID_TAGS 误杀 button/input）----------
const benign = [
  ['<p title="good">正常 <em>内容</em> 保留</p>', 'title="good"', '正常内容保留'],
  ['<img src="/mdimg/abc.png">', '/mdimg/abc.png', '本地回放图片不受影响'],
  ['<a href="https://a.b" target="_blank">x</a>', 'https://a.b', '外链不受影响'],
  ['<button type="button" class="code-copy" data-copy title="copy">C</button>', 'data-copy', '渲染器自产复制按钮保留'],
  ['<button type="button" class="md-diagram-btn" data-toggle-src>S</button>', 'data-toggle-src', '图形卡片源码按钮保留'],
  ['<li><input type="checkbox" checked>任务</li>', 'type="checkbox"', 'GFM 任务列表 checkbox 保留'],
  ['<pre><code class="hljs">const a = 1</code></pre>', '<code', '代码块保留'],
]

for (const [input, needle, name] of benign) {
  const got = sanitizeHtml(input)
  check(got.toLowerCase().includes(needle.toLowerCase()), name, `in: ${input}\n  got: ${got}`)
}

// 恶意 input（非 checkbox）与带 on* 的 button 仍必须被拆掉
const badControls = sanitizeHtml('<input type="text" name="q"><button onclick="alert(1)">x</button>')
check(!badControls.includes('<input') && !badControls.includes('onclick'), '非 checkbox input / onclick button 清除', `got: ${badControls}`)

// ---------- 白名单：命中远程白名单的 URL 不被替换 ----------
const allowGot = sanitizeHtml('<img src="https://cdn.example.com/a.png">', true, 'https://cdn.example.com/*')
check(allowGot.includes('https://cdn.example.com/a.png'), '远程白名单命中放行', `got: ${allowGot}`)
check(!remoteAllowed('https://evil.tld/a.png', 'https://cdn.example.com/*'), '远程白名单未命中拒绝')

// ---------- SVG 清洗：远程与 data: 引用都清空，本地引用保留 ----------
const svgGot = stripSvgExternalRefs('<svg><image href="data:image/svg+xml,x"/><use xlink:href="https://evil.tld/a"/><image href="#local"/></svg>')
check(!svgGot.includes('data:') && !svgGot.includes('evil.tld') && svgGot.includes('#local'), 'SVG 远程/data: 引用剥离', `got: ${svgGot}`)
const svgCfg = svgConfig(parts)
check(Array.isArray(svgCfg.FORBID_TAGS) && svgCfg.FORBID_TAGS.includes('script'), 'SVG 配置从唯一源派生')

console.log(fail ? `\n${fail} 个用例失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
