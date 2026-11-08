/**
 * NEBULA 作战大屏 —— 本地 HTTP 服务（agent 插件版）。
 *
 * - 只绑定 127.0.0.1
 * - 页面 / API / SSE 都需要 token（query 或 X-Agent-Status-Token 头）
 * - 数据源：hub_event_cache（最近 15 分钟有写入时）或本地实时源
 *   （command-execution + renderer.log），没有新活动时如实报 silent
 * - 渲染层直接复用现有 nebula 资源，不改视觉
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import {
  VERSION,
  PREFIX,
  LEGACY_PREFIX,
  LOG_FILE,
  ensureRuntimeDir,
  writeState,
  clearState,
  newToken,
  authorized,
  isLoopback,
  readAsset,
} from './runtime.mjs'

const require = createRequire(import.meta.url)
const { createStore } = require('../lib/store.js')
const { createHubCacheSource, DEFAULT_ROOT } = require('../lib/hub-cache.js')
const { createLiveSource, DEFAULT_CMD_ROOT, DEFAULT_LOG_ROOT } = require('../lib/live-source.js')

const HOST = '127.0.0.1'
const PORT_START = Number(process.env.NEBULA_PORT) || 41730
const PORT_TRIES = 40

ensureRuntimeDir()
const token = newToken()
const startedAt = Date.now()

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志不可写时静默 */
  }
}

// ---------------------------------------------------------------- 数据源

const store = createStore({})
let sourceStatus = { state: 'starting', kind: 'hub_cache', note: '正在扫描数据源…', files: 0, lastAppendAt: null }
let dirty = true

function applyEvent(event) {
  switch (event.kind) {
    case 'session.start':
      store.sessionStart(event)
      return
    case 'tool.call':
      store.toolCall(event)
      return
    case 'tool.result':
      store.toolResult(event)
      return
    case 'usage':
      store.usage(event)
      return
    case 'queue':
      store.queue(event)
      return
    case 'step.note':
      store.note(event)
      return
    case 'turn.end':
      store.turnEnd(event)
      return
    default:
      return
  }
}

// `NEBULA_HUB_ROOT` exists so tests can point at a synthetic cache; the
// default remains the real read-only Trae cache.
const HUB_ROOT = process.env.NEBULA_HUB_ROOT || DEFAULT_ROOT
const LIVE_CMD_ROOT = process.env.NEBULA_LIVE_CMD_ROOT || DEFAULT_CMD_ROOT
const LIVE_LOG_ROOT = process.env.NEBULA_LIVE_LOG_ROOT || DEFAULT_LOG_ROOT

// A hub file older than this no longer counts as a live source. Startup used
// to accept "written today", which locked a dead cache in place after the Hub
// bridge stopped; the window and the periodic re-check below fix that.
const HUB_STALE_MS = Math.max(5_000, Number(process.env.NEBULA_HUB_STALE_MS) || 15 * 60_000)
const SOURCE_RECHECK_MS = Math.max(5_000, Number(process.env.NEBULA_SOURCE_RECHECK_MS) || 30_000)
const FORCED_MODE = (() => {
  const wanted = String(process.env.NEBULA_SOURCE || 'auto').toLowerCase()
  return wanted === 'hub' || wanted === 'live' ? wanted : ''
})()

/** Newest `.jsonl` mtime under the hub cache, or 0 when nothing was written. */
function latestHubWriteMs(root) {
  let newest = 0
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs)
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root, 0)
  return newest
}

function pickSourceMode() {
  if (FORCED_MODE !== '') return FORCED_MODE
  const last = latestHubWriteMs(HUB_ROOT)
  return last !== 0 && Date.now() - last <= HUB_STALE_MS ? 'hub' : 'live'
}

let sourceMode = pickSourceMode()
let source = null
// Set when we deliberately fall back from hub to live: it is surfaced in
// `source.note` so the screen never silently changes what it is reading.
let degradeNote = ''

function onSourceEvent(event) {
  applyEvent(event)
  dirty = true
}

function statusSink(kind) {
  return (status) => {
    sourceStatus = {
      state: String(status.state || 'starting'),
      kind,
      note: [degradeNote, String(status.note || '')].filter(Boolean).join(' · '),
      files: Number(status.files) || 0,
      lastAppendAt: Number(status.lastAppendAt) || null,
      roots: status.roots || null,
    }
    dirty = true
  }
}

function buildSource(mode, sinceMs = 0) {
  if (mode === 'hub') {
    return createHubCacheSource({
      root: HUB_ROOT,
      onEvent: onSourceEvent,
      onStatus: statusSink('hub_cache'),
    })
  }
  return createLiveSource({
    cmdRoot: LIVE_CMD_ROOT,
    logRoot: LIVE_LOG_ROOT,
    sinceMs,
    onEvent: onSourceEvent,
    onStatus: statusSink('live_local'),
  })
}

function startSource(mode, sinceMs = 0) {
  sourceMode = mode
  source = buildSource(mode, sinceMs)
  source.start()
  log(
    mode === 'hub'
      ? `hub cache watching: ${HUB_ROOT}`
      : `local live source watching: ${LIVE_CMD_ROOT} + ${LIVE_LOG_ROOT}`,
  )
}

startSource(sourceMode)

function degradeToLive(reason) {
  if (sourceMode !== 'live') {
    try {
      source.stop()
    } catch {
      /* ignore */
    }
    const ageText =
      HUB_STALE_MS < 60_000
        ? `${Math.round(HUB_STALE_MS / 1000)} 秒`
        : `${Math.round(HUB_STALE_MS / 60_000)} 分钟`
    degradeNote = `hub 缓存超过 ${ageText}无写入，已降级本地实时源`
    log(`${degradeNote} (${reason})`)
    // Start at "now": replaying 15 minutes of local history here would
    // duplicate events the hub already delivered.
    startSource('live', Date.now())
    dirty = true
  }
}

setInterval(() => {
  if (FORCED_MODE === 'hub' || sourceMode !== 'hub') return
  const last = latestHubWriteMs(HUB_ROOT)
  if (last === 0) {
    degradeToLive('no hub files')
  } else if (Date.now() - last > HUB_STALE_MS) {
    degradeToLive(`last hub write ${new Date(last).toISOString()}`)
  }
}, SOURCE_RECHECK_MS).unref()


function snapshotPayload(group = null) {
  return { ...store.snapshot({ group }), version: VERSION, source: sourceStatus }
}

// ---------------------------------------------------------------- HTML

const VENDOR = [
  'three.min.js',
  'CopyShader.js',
  'LuminosityHighPassShader.js',
  'EffectComposer.js',
  'RenderPass.js',
  'ShaderPass.js',
  'UnrealBloomPass.js',
]

function buildHtml() {
  const nonce = newToken()
  const css = readAsset('screen.css')
  const vendor = VENDOR.map((name) => readAsset(`nebula/vendor/${name}`)).join('\n;\n')
  const config = {
    version: VERSION,
    theme: 'galaxy',
    screenTheme: 'galaxy',
    waitingAfterMs: 15_000,
    mode: 'webview',
    prefix: PREFIX,
    nebulaTemplate: readAsset('nebula/template.html'),
  }
  const js = [
    readAsset('nebula-core.js'),
    vendor,
    readAsset('nebula/theme.js'),
    '\nglobalThis.DSHNebulaMount = mountNebula;\n;\n',
    // Plugin-owned client: HTTP/SSE transport + per-session filter bar.
    // `screen.js` stays untouched as the IDE-webview variant.
    readAsset('screen-http.js'),
  ].join('\n')
  const csp =
    `default-src 'none'; img-src data:; font-src data:; ` +
    `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
    `connect-src 'self'; base-uri 'none'; form-action 'none';`
  return readAsset('screen.html')
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .split('__SCREEN_CSS__')
    .join(css)
    .split('__SCREEN_JS__')
    .join(js)
    .split('__SCREEN_CONFIG__')
    .join(JSON.stringify(config).replace(/</g, '\\u003c'))
    .split('__CSP_NONCE__')
    .join(nonce)
}

const pageHtml = buildHtml()

// ---------------------------------------------------------------- HTTP

const clients = new Set()

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Browser-facing 401: explains how to get a fresh link, never echo the token. */
function sendTokenPage(res) {
  res.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(
    '<!doctype html><meta charset="utf-8"><title>NEBULA · token</title>' +
      '<body style="font:14px/1.6 ui-monospace,Menlo,monospace;background:#0b0f1a;color:#cfe0ff;padding:40px">' +
      '<h1 style="font-size:18px">需要有效的 token</h1>' +
      '<p>本页链接里的 token 已失效（服务重启会生成新 token）。</p>' +
      '<p>请重新执行 <code>node bin/start.mjs --open</code>，用输出的完整 URL 打开。</p></body>',
  )
}

function handle(req, res) {
  const urlObj = new URL(req.url, `http://${HOST}`)

  // Browsers ask for these automatically; answering 204 keeps the 401 log
  // from filling with noise.
  if (urlObj.pathname === '/favicon.ico' || urlObj.pathname === '/robots.txt') {
    res.writeHead(204, { 'cache-control': 'no-store' })
    return res.end()
  }

  if (urlObj.pathname === '/healthz') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false })
    return sendJson(res, 200, { ok: true })
  }

  if (urlObj.pathname === '/') {
    if (!authorized(req, urlObj, token)) return sendTokenPage(res)
    res.writeHead(302, { 'location': `${PREFIX}/screen?token=${encodeURIComponent(token)}` })
    return res.end()
  }

  // Old DeepSeek-Harness-era prefix: keep bookmarks working, never serve there.
  // Re-issue the *current* token instead of forwarding whatever was in the old
  // query, so a stale bookmark cannot keep propagating an old secret.
  if (urlObj.pathname === LEGACY_PREFIX || urlObj.pathname.startsWith(`${LEGACY_PREFIX}/`)) {
    const rest = urlObj.pathname.slice(LEGACY_PREFIX.length) || '/screen'
    const theme = urlObj.searchParams.get('theme')
    const suffix = theme === null ? '' : `&theme=${encodeURIComponent(theme)}`
    res.writeHead(302, {
      'location': `${PREFIX}${rest}?token=${encodeURIComponent(token)}${suffix}`,
    })
    return res.end()
  }

  if (!authorized(req, urlObj, token)) {
    log(`401 ${urlObj.pathname} from ${req.socket.remoteAddress}`)
    if (urlObj.pathname === `${PREFIX}/screen`) return sendTokenPage(res)
    return sendJson(res, 401, { error: 'unauthorized' })
  }

  if (urlObj.pathname === `${PREFIX}/screen`) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      // The page URL carries the token; never leak it as a Referer.
      'referrer-policy': 'no-referrer',
    })
    return res.end(pageHtml)
  }

  if (urlObj.pathname === `${PREFIX}/api/state`) {
    // Optional `?group=<sessionId|hubId|taskId>` narrows agents/events to one
    // session. `sessions[]` stays complete so a caller can build a switcher.
    return sendJson(res, 200, snapshotPayload(urlObj.searchParams.get('group')))
  }

  if (urlObj.pathname === `${PREFIX}/stream`) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`event: state\ndata: ${JSON.stringify(snapshotPayload())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  return sendJson(res, 404, { error: 'not found' })
}

let currentPort = PORT_START

const server = http.createServer(handle)

function tryListen(port, triesLeft) {
  server.once('error', (error) => {
    if (error && error.code === 'EADDRINUSE' && triesLeft > 0) {
      log(`port ${port} busy, trying ${port + 1}`)
      tryListen(port + 1, triesLeft - 1)
      return
    }
    log(`listen failed: ${error && error.message}`)
    process.exit(1)
  })
  server.listen(port, HOST, () => {
    currentPort = port
    writeState({
      pid: process.pid,
      port,
      token,
      url: `http://${HOST}:${port}${PREFIX}/screen?token=${encodeURIComponent(token)}`,
      startedAt,
      version: VERSION,
    })
    log(`listening on ${HOST}:${port}`)
  })
}

tryListen(PORT_START, PORT_TRIES)

setInterval(() => {
  if (!dirty) return
  dirty = false
  const payload = JSON.stringify(snapshotPayload())
  for (const res of clients) {
    try {
      res.write(`event: state\ndata: ${payload}\n\n`)
    } catch {
      clients.delete(res)
    }
  }
}, 1000).unref()

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n')
    } catch {
      clients.delete(res)
    }
  }
}, 15_000).unref()

function shutdown(signal) {
  log(`shutting down (${signal})`)
  try {
    clearState()
  } catch {
    /* ignore */
  }
  try {
    server.close()
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 200).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (error) => {
  log(`uncaught: ${error && error.stack}`)
})
