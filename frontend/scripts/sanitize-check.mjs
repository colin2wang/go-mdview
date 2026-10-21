// 与 frontend/src/markdown.ts 中 sanitizeHtml 保持一致的验证脚本
function sanitizeHtml(html) {
  return html
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|action|xlink:href)\s*=\s*("\s*(javascript|vbscript):[^"]*"|'\s*(javascript|vbscript):[^']*')/gi, '')
    .replace(/\s(href|src|action|xlink:href)\s*=\s*(javascript|vbscript):[^\s>]*/gi, '')
}

const cases = [
  ['<script>alert(1)</script>ok', 'ok', 'script 块删除'],
  ['<img src=x onerror=alert(1)>', '<img src=x>', '无引号 onerror 删除'],
  ['<img src="x" onerror="alert(1)">', '<img src="x">', '双引号 onerror 删除'],
  ["<img src='x' onerror='alert(1)'>", "<img src='x'>", '单引号 onerror 删除'],
  ['<a href="javascript:alert(1)">c</a>', '<a>c</a>', 'javascript: href 删除'],
  ["<a href='vbscript:x'>c</a>", '<a>c</a>', 'vbscript: href 删除'],
  ['<svg onload=alert(1)></svg>', '<svg></svg>', 'svg onload 删除'],
  ['<iframe src="//evil"></iframe>', '', 'iframe 删除'],
  ['<p title="good">正常 <em>内容</em> 保留</p>', '<p title="good">正常 <em>内容</em> 保留</p>', '正常内容不受影响'],
  ['<img src="/mdimg/abc.png">', '<img src="/mdimg/abc.png">', '本地回放图片不受影响'],
  ['<a href="https://a.b" target="_blank">x</a>', '<a href="https://a.b" target="_blank">x</a>', '外链不受影响'],
]

let fail = 0
for (const [input, expect, name] of cases) {
  const got = sanitizeHtml(input)
  const ok = got === expect
  if (!ok) fail++
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : `\n  in:     ${input}\n  expect: ${expect}\n  got:    ${got}`))
}
process.exit(fail ? 1 : 0)
