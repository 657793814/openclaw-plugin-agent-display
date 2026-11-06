import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderScreenHtml, screenUrl } from '../lib/screen.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

test('screenUrl uses the live page origin and encodes the token', () => {
  assert.equal(
    screenUrl('http://127.0.0.1:54321', '/dsh-agent-status', 'tok/with space'),
    'http://127.0.0.1:54321/dsh-agent-status/screen?token=tok%2Fwith%20space',
  )
  assert.equal(
    screenUrl('http://127.0.0.1:54321/', '/dsh-agent-status/', 'abc'),
    'http://127.0.0.1:54321/dsh-agent-status/screen?token=abc',
  )
  // The port is whatever the caller passed; the helper never invents one.
  assert.match(screenUrl('http://localhost:9999', '/p', 't'), /localhost:9999/u)
})

test('renderScreenHtml fills every placeholder and keeps config JSON-safe', () => {
  const html = renderScreenHtml({
    template: '<style>__SCREEN_CSS__</style><script>__SCREEN_JS__</script><i>__SCREEN_CONFIG__</i>',
    css: '.a{color:#45e6f5}',
    js: 'globalThis.x=1',
    config: { prefix: '/dsh-agent-status', note: '</script><script>alert(1)' },
  })
  assert.equal(html.includes('__SCREEN_CSS__'), false)
  assert.equal(html.includes('__SCREEN_JS__'), false)
  assert.equal(html.includes('__SCREEN_CONFIG__'), false)
  assert.equal(html.includes('.a{color:#45e6f5}'), true)
  assert.equal(html.includes('globalThis.x=1'), true)
  // `</script>` must be escaped so the inline config cannot break out.
  assert.equal(html.includes('</script><script>alert(1)'), false)
  assert.equal(html.includes('\\u003c/script>'), true)
})

test('the real page has no token by default and no leftover placeholders', () => {
  const template = fs.readFileSync(path.join(root, 'runtime/screen.html'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'runtime/screen.css'), 'utf8')
  const js = fs.readFileSync(path.join(root, 'runtime/screen.js'), 'utf8')
  const core = fs.readFileSync(path.join(root, 'runtime/nebula-core.js'), 'utf8')
  const theme = fs.readFileSync(path.join(root, 'runtime/nebula/theme.js'), 'utf8')
  const nebulaTemplate = fs.readFileSync(path.join(root, 'runtime/nebula/template.html'), 'utf8')
  const html = renderScreenHtml({
    template,
    css,
    js: [core, theme, 'globalThis.DSHNebulaMount = mountNebula;', js].join('\n'),
    config: {
      prefix: '/dsh-agent-status',
      version: '1.3.0',
      pollMs: 800,
      screenTheme: 'galaxy',
      nebulaTemplate,
    },
  })
  assert.equal(/__SCREEN_(CSS|JS|CONFIG)__/u.test(html), false)
  assert.match(html, /"prefix":"\/dsh-agent-status"/u)
  assert.match(html, /"screenTheme":"galaxy"/u)
  assert.match(html, /"nebulaTemplate":"/u)
  // The page talks to the host over its own origin only.
  assert.match(js, /location\.search/u)
  assert.match(js, /EventSource/u)
  assert.match(js, /\/screen/u)
  assert.match(css, /@media \(max-width: 1100px\)/u)
  // The original theme-05 renderer is inlined verbatim, after the pure adapter.
  assert.ok(html.indexOf('__DSH_NEBULA_CORE__') < html.indexOf('function mountNebula'))
  assert.match(theme, /function mountNebula/u)
  assert.match(theme, /new THREE.WebGLRenderer/u)
  assert.match(theme, /UnrealBloomPass/u)
  assert.match(nebulaTemplate, /id="gl"/u)
  assert.match(nebulaTemplate, /NEBULA CRAWLER|星核蜘蛛/u)
  assert.match(css, /html\[data-theme="galaxy"\]/u)
  assert.match(css, /\.nebula-host/u)
})
