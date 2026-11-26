// sanitizer 回归验证脚本：直接驱动 frontend/src 用的同一份 DOMPurify 配置
// 与同一份 hook（sanitize-common.js），jsdom 提供真实 DOM 解析。
// 除基础用例外，还覆盖已知绕过向量、良性控件保留与远程 URL 属性拦截。
// 输出为英文（构建期工具，受众是开发者与 CI 日志，不走 UI 的 i18n 词典）。
import { JSDOM } from 'jsdom'
import { createRequire } from 'module'
import {
  createState,
  mermaidSvgConfig,
  peleSvgConfig,
  remoteAllowed,
  sanitizeWith,
  splitConfig,
  stripSvgExternalRefs,
  stripSvgStyleUrls,
  svgConfig
} from '../src/sanitize-common.js'

// ---------- 环境与净化出口（与 src/markdown.ts sanitizeHtml 完全同一配置 + hook） ----------

const require = createRequire(import.meta.url)
const DOMPurifyPkg = require('dompurify')

// 配置唯一来源：src/sanitize-config.json（src/markdown.ts 同样引用它）
const sanitizeConfig = require('../src/sanitize-config.json')
const parts = splitConfig(sanitizeConfig)

const window = new JSDOM('').window
const DOMPurify = DOMPurifyPkg(window)
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function sanitizeHtml(html, blockRemote = true, remoteAllow = '') {
  return sanitizeWith(
    DOMPurify,
    parts,
    html,
    createState(blockRemote, remoteAllow, PLACEHOLDER, 'blocked')
  )
}

// ---------- 极简 runner：收集 PASS/FAIL，结束统一汇总 ----------

let passed = 0
const failures = []

function check(ok, name, detail) {
  if (ok) {
    passed++
    console.log(`PASS  ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`FAIL  ${name}\n  ${detail}`)
  }
}

/** 断言净化输出不含任何危险子串，且不含指定域（默认 evil.tld）。 */
function checkBlocked(input, name, forbiddenDomains = ['evil.tld']) {
  const got = sanitizeHtml(input)
  const hit = DANGEROUS_SUBSTRINGS.filter((d) => got.toLowerCase().includes(d))
  const domainHit = forbiddenDomains.filter((d) => got.includes(d))
  const problems = [...hit, ...domainHit]
  check(problems.length === 0, name, `in: ${input}\n  got: ${got}\n  residual: ${problems.join(', ')}`)
}

/** 断言输出保留指定内容（防「净化过猛」）。 */
function checkPreserved(input, needle, name) {
  const got = sanitizeHtml(input)
  check(got.toLowerCase().includes(needle.toLowerCase()), name, `in: ${input}\n  got: ${got}`)
}

// ---------- 用例表 ----------

// 危险子串：输出中出现任何一条即视为失败
const DANGEROUS_SUBSTRINGS = [
  '<script', 'javascript:', 'onerror', 'onload', 'formaction',
  'http-equiv', '<base', '<meta', '<style', '<iframe', 'url('
]

// 恶意 payload：必须被清除
const HOSTILE_CASES = [
  ['<script>alert(1)</script>ok', 'script block removed'],
  ['<img src=x onerror=alert(1)>', 'unquoted onerror removed'],
  ['<img src="x" onerror="alert(1)">', 'double-quoted onerror removed'],
  ["<img src='x' onerror='alert(1)'>", 'single-quoted onerror removed'],
  ['<a href="javascript:alert(1)">c</a>', 'javascript: href removed'],
  ["<a href='vbscript:x'>c</a>", 'vbscript: href removed'],
  ['<svg onload=alert(1)></svg>', 'svg onload removed'],
  ['<iframe src="//evil"></iframe>', 'iframe removed']
]

// 绕过向量（旧正则实现全部放行）
const BYPASS_CASES = [
  ['<a href="&#106;avascript:alert(1)">click</a>', 'HTML entity decode bypass'],
  ['<a href="jav&#x09;ascript:alert(1)">click</a>', 'tab entity bypass'],
  ['<button formaction="javascript:alert(1)">go</button>', 'formaction bypass'],
  ['<meta http-equiv="refresh" content="0;url=https://evil.tld">', 'meta refresh redirect'],
  ['<base href="https://evil.tld/">', 'base hijack of relative URLs'],
  ['<style>body{background:url(https://evil.tld/beacon)}</style>', 'style url() beacon'],
  ['<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', 'svg animate protocol bypass'],
  ['<img src="https://evil.tld/track.png">', 'remote tracking img src blocked'],
  ['<img srcset="https://evil.tld/a.png 1x, /mdimg/abc.png 2x">', 'remote srcset blocked'],
  ['<video poster="https://evil.tld/p.png"></video>', 'remote poster blocked'],
  ['<object data="https://evil.tld/x.html"></object>', 'remote object[data] blocked'],
  ['<svg><image xlink:href="https://evil.tld/i.png"/></svg>', 'SVG xlink:href remote blocked'],
  ['<svg><use href="//evil.tld/i.svg#x"/></svg>', 'SVG use href remote blocked']
]

// 良性内容必须保留（此前 FORBID_TAGS 误杀 button/input）
const BENIGN_CASES = [
  ['<p title="good">正常 <em>内容</em> 保留</p>', 'title="good"', 'normal content preserved'],
  ['<img src="/mdimg/abc.png">', '/mdimg/abc.png', 'local replay image unaffected'],
  ['<a href="https://a.b" target="_blank">x</a>', 'https://a.b', 'external link unaffected'],
  ['<button type="button" class="code-copy" data-copy title="copy">C</button>', 'data-copy', 'renderer code-copy button preserved'],
  ['<button type="button" class="md-diagram-btn" data-toggle-src>S</button>', 'data-toggle-src', 'diagram source button preserved'],
  ['<li><input type="checkbox" checked>任务</li>', 'type="checkbox"', 'GFM task-list checkbox preserved'],
  ['<select class="md-diagram-engine" data-mm-engine><option value="pele">Pele</option></select>', 'data-mm-engine', 'diagram engine select preserved'],
  ['<pre><code class="hljs">const a = 1</code></pre>', '<code', 'code block preserved'],
  ['<h2 id="intro" data-sl="12">标题</h2>', 'data-sl="12"', 'block line anchor preserved']
]

// ---------- 执行 ----------

// 1. 恶意 payload 与绕过向量
for (const [input, name] of [...HOSTILE_CASES, ...BYPASS_CASES]) {
  checkBlocked(input, name)
}

// 2. 脚注旁路：脚注内容在整段 sanitize 之后追加，必须单独净化
const fnGot = sanitizeHtml('<p><img src=x onerror=alert(1)></p><style>url(https://evil.tld)</style>')
check(
  !fnGot.includes('onerror') && !fnGot.includes('<style') && !fnGot.includes('evil.tld'),
  'footnote content sanitized independently',
  `got: ${fnGot}`
)

// 3. 良性内容保留
for (const [input, needle, name] of BENIGN_CASES) {
  checkPreserved(input, needle, name)
}

// 恶意 input（非 checkbox）与带 on* 的 button 仍必须被拆掉
const badControls = sanitizeHtml('<input type="text" name="q"><button onclick="alert(1)">x</button>')
check(
  !badControls.includes('<input') && !badControls.includes('onclick'),
  'non-checkbox input / onclick button stripped',
  `got: ${badControls}`
)

// 4. 远程白名单：命中的 URL 不被替换，未命中的拒绝
const allowGot = sanitizeHtml('<img src="https://cdn.example.com/a.png">', true, 'https://cdn.example.com/*')
check(
  allowGot.includes('https://cdn.example.com/a.png'),
  'remote allowlist match passes through',
  `got: ${allowGot}`
)
check(
  !remoteAllowed('https://evil.tld/a.png', 'https://cdn.example.com/*'),
  'remote allowlist miss rejected'
)

// 5. SVG 清洗：远程与 data: 引用都清空，本地引用保留
const svgGot = stripSvgExternalRefs('<svg><image href="data:image/svg+xml,x"/><use xlink:href="https://evil.tld/a"/><image href="#local"/></svg>')
check(
  !svgGot.includes('data:') && !svgGot.includes('evil.tld') && svgGot.includes('#local'),
  'SVG remote/data: refs stripped',
  `got: ${svgGot}`
)
const svgCfg = svgConfig(parts)
check(
  Array.isArray(svgCfg.FORBID_TAGS) && svgCfg.FORBID_TAGS.includes('script'),
  'SVG config derived from single source'
)

// 6. Mermaid 节点文字：htmlLabels 放在 foreignObject 里，必须放行
const mmState = createState(true, '', () => '', '')
const mmLabel =
  '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="120" height="40">' +
  '<div xmlns="http://www.w3.org/1999/xhtml" class="label">接口节点</div></foreignObject></svg>'
const mmGot = sanitizeWith(DOMPurify, parts, mmLabel, mmState, mermaidSvgConfig(parts))
check(
  /<foreignObject[\s>]/i.test(mmGot) && mmGot.includes('接口节点'),
  'Mermaid foreignObject node labels preserved',
  `got: ${mmGot}`
)
const mmBad = sanitizeWith(
  DOMPurify,
  parts,
  '<svg><foreignObject><div onclick="alert(1)">安全文字</div></foreignObject>' +
    '<script>alert(1)</script><image href="https://evil.tld/x.png"/></svg>',
  mmState,
  mermaidSvgConfig(parts)
)
check(
  mmBad.includes('安全文字') && !mmBad.includes('<script') && !mmBad.includes('alert(1)') && !mmBad.includes('onclick') && !mmBad.includes('evil.tld'),
  'Mermaid config still blocks scripts, event handlers and remote refs',
  `got: ${mmBad}`
)

// 7. Pele 输出：classDef 内联配色保留，但脚本/事件属性/远程引用仍被拦截
const peleState = createState(true, '', () => '', '')
const peleGot = sanitizeWith(
  DOMPurify,
  parts,
  stripSvgExternalRefs(
    '<svg class="pele"><g style="fill:#f00;stroke:#00f" onclick="alert(1)"><rect/></g>' +
      '<script>alert(1)</script><image href="https://evil.tld/i.png"/></svg>'
  ),
  peleState,
  peleSvgConfig(parts)
)
check(
  peleGot.includes('fill:#f00') && peleGot.includes('stroke:#00f'),
  'Pele config keeps classDef inline style',
  `got: ${peleGot}`
)
check(
  !peleGot.includes('<script') &&
    !peleGot.includes('alert(1)') &&
    !peleGot.includes('onclick') &&
    !peleGot.includes('evil.tld'),
  'Pele config still blocks scripts, handlers and remote refs',
  `got: ${peleGot}`
)
// style 里的 url() 是 Pele 白名单之外的远程引用，派生配置放行 style 后仍需显式剥掉
const peleUrl = sanitizeWith(
  DOMPurify,
  parts,
  stripSvgStyleUrls('<svg class="pele"><rect style="fill:#f00;mask:url(https://evil.tld/m.png);stroke:#00f"/></svg>'),
  peleState,
  peleSvgConfig(parts)
)
check(
  peleUrl.includes('fill:#f00') && peleUrl.includes('stroke:#00f') && !peleUrl.includes('url('),
  'Pele inline style with url() is neutralized',
  `got: ${peleUrl}`
)

// ---------- 汇总 ----------

const total = passed + failures.length
if (failures.length) {
  console.log(`\n${failures.length}/${total} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${total} checks passed`)
