// sanitizer 回归验证脚本：直接驱动 frontend/src 用的同一份 DOMPurify 配置
// （jsdom 提供真实 DOM 解析，与 WebView 内行为一致）。
// 除基础用例外，还覆盖 8 条已知绕过向量——这些 payload 曾绕过旧的正则版 sanitizer。
import { JSDOM } from 'jsdom'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const DOMPurifyPkg = require('dompurify')

// 与 src/markdown.ts sanitizeHtml 保持一致的配置
function sanitizeHtml(html) {
  const window = new JSDOM('').window
  const DOMPurify = DOMPurifyPkg(window)
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ['style', 'base', 'meta', 'form', 'input', 'button'],
    FORBID_ATTR: ['style']
  })
}

// 危险子串：输出中出现任何一条即视为失败
const DANGEROUS = ['<script', 'javascript:', 'onerror', 'onload', 'formaction', 'http-equiv', '<base', '<meta', '<style', '<iframe', 'url(']

let fail = 0

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
  ['<img src="https://evil.tld/track.png">', '远程追踪图片'],
]

for (const [input, name] of [...hostile, ...bypass]) {
  const got = sanitizeHtml(input)
  const hit = DANGEROUS.filter((d) => got.toLowerCase().includes(d))
  const ok = hit.length === 0
  if (!ok) fail++
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : `\n  in:  ${input}\n  got: ${got}\n  残留: ${hit.join(', ')}`))
}

// ---------- 正常内容不受影响 ----------
const benign = [
  ['<p title="good">正常 <em>内容</em> 保留</p>', 'title="good"', '正常内容保留'],
  ['<img src="/mdimg/abc.png">', '/mdimg/abc.png', '本地回放图片不受影响'],
  ['<a href="https://a.b" target="_blank">x</a>', 'https://a.b', '外链不受影响'],
]

for (const [input, needle, name] of benign) {
  const got = sanitizeHtml(input)
  const ok = got.toLowerCase().includes(needle.toLowerCase())
  if (!ok) fail++
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : `\n  in:  ${input}\n  got: ${got}`))
}

console.log(fail ? `\n${fail} 个用例失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
