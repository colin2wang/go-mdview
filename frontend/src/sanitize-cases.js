/**
 * 净化回归用例的纯数据源：scripts/sanitize-check.mjs（构建期）与
 * src/__tests__/core.test.ts（Vitest）共享，避免两份用例表漂移。
 * 这里只放数据，不依赖 DOM / DOMPurify / 渲染代码。
 */

// 输出中出现任意一条即视为失败
export const DANGEROUS_SUBSTRINGS = [
  '<script', 'javascript:', 'onerror', 'onload', 'formaction',
  'http-equiv', '<base', '<meta', '<style', '<iframe', 'url('
]

// 恶意 payload：必须被清除
export const HOSTILE_CASES = [
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
export const BYPASS_CASES = [
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
export const BENIGN_CASES = [
  ['<p title="good">正常 <em>内容</em> 保留</p>', 'title="good"', 'normal content preserved'],
  ['<img src="/mdimg/abc.png">', '/mdimg/abc.png', 'local replay image unaffected'],
  ['<a href="https://a.b" target="_blank">x</a>', 'https://a.b', 'external link unaffected'],
  ['<button type="button" class="code-copy" data-copy title="copy">C</button>', 'data-copy', 'renderer code-copy button preserved'],
  ['<button type="button" class="md-diagram-btn" data-toggle-src>S</button>', 'data-toggle-src', 'diagram source button preserved'],
  ['<li><input type="checkbox" checked>任务</li>', 'type="checkbox"', 'GFM task-list checkbox preserved'],
  ['<select class="md-diagram-engine" data-mm-engine><option value="pele">Pele</option></select>', 'data-mm-engine', 'diagram engine select preserved'],
  ['<pre><code class="hljs">const a = 1</code></pre>', '<code', 'code block preserved'],
  ['<h2 id="intro" data-sl="12">标题</h2>', 'data-sl="12"', 'block line anchor preserved'],
  ['<svg><rect width="10" height="10"><animate attributeName="opacity" values="0.3;1;0.3" from="0" to="1" dur="1.5s" begin="0.5s" repeatCount="indefinite" keyTimes="0;0.5;1"/></rect><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="3s" repeatCount="indefinite"/><set attributeName="opacity" to="1" begin="1s"/></svg>', '<animate', 'SMIL animation preserved'],
  ['<svg><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="3s"/></svg>', 'type="rotate"', 'SMIL animateTransform attrs preserved']
]

// 远程白名单边界：`*` 匹配任意串、`?` 匹配单字符；整串锚定，不解析 URL 凭据。
// 后三条是文档列出的绕过向量，必须拒绝，避免 `@` / 后缀拼接 / query 干扰。
export const REMOTE_PATTERN_CASES = [
  ['https://cdn.example.com/a.png', 'https://cdn.example.com/*', true, 'simple wildcard match'],
  ['https://evil.tld/a.png', 'https://cdn.example.com/*', false, 'simple wildcard miss'],
  ['https://cdn.example.com@evil.com/x.png', 'https://cdn.example.com/*', false, 'userinfo @ bypass rejected'],
  ['https://cdn.example.com.evil.com/x.png', 'https://cdn.example.com/*', false, 'suffix concatenation rejected'],
  ['https://evil.com/?q=.cdn.example.com', 'https://cdn.example.com/*', false, 'query interference rejected'],
  ['https://cdn.example.com/a1.png', 'https://cdn.example.com/a?png', false, 'single ? does not match slash'],
  ['https://cdn.example.com/a1', 'https://cdn.example.com/a?', true, 'single ? matches one char'],
  ['https://CDN.EXAMPLE.COM/a.png', 'https://cdn.example.com/*', true, 'pattern matching is case-insensitive']
]
