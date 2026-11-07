/**
 * NEBULA 作战大屏 —— 本地 HTTP 服务（agent 插件版）。
 *
 * - 只绑定 127.0.0.1
 * - 页面 / API / SSE 都需要一次性 token（query 或 X-Agent-Status-Token 头）
 * - 数据源：hub_event_cache（若今日有写入）或本地实时源（command-execution
 *   + renderer.log），没有新活动时如实报 silent
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

/**
 * The hub cache directory is created by the native Hub bridge even when it
 * never writes (plain local installs), so "directory exists" is not enough.
 * `auto` only prefers it when it actually has a file written today.
 */
function hubHasFreshData(root) {
  const cutoff = new Date()
  cutoff.setHours(0, 0, 0, 0)
  const walk = (dir, depth) => {
    if (depth > 3) return false
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (walk(full, depth + 1)) return true
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(full).mtimeMs >= cutoff.getTime()) return true
        } catch {
          /* ignore */
        }
      }
    }
    return false
  }
  return walk(root, 0)
}

function pickSourceMode() {
  const wanted = String(process.env.NEBULA_SOURCE || 'auto').toLowerCase()
  if (wanted === 'hub' || wanted === 'live') return wanted
  return hubHasFreshData(HUB_ROOT) ? 'hub' : 'live'
}

const SOURCE_MODE = pickSourceMode()
const SOURCE_KIND = SOURCE_MODE === 'hub' ? 'hub_cache' : 'live_local'
sourceStatus.kind = SOURCE_KIND

const source = SOURCE_MODE === 'hub'
  ? createHubCacheSource({
      root: HUB_ROOT,
      onEvent: (event) => {
        applyEvent(event)
        dirty = true
      },
      onStatus: (status) => {
        sourceStatus = {
          state: String(status.state || 'starting'),
          kind: SOURCE_KIND,
          note: String(status.note || ''),
          files: Number(status.files) || 0,
          lastAppendAt: Number(status.lastAppendAt) || null,
        }
        dirty = true
      },
    })
  : createLiveSource({
      cmdRoot: LIVE_CMD_ROOT,
      logRoot: LIVE_LOG_ROOT,
      onEvent: (event) => {
        applyEvent(event)
        dirty = true
      },
      onStatus: (status) => {
        sourceStatus = {
          state: String(status.state || 'starting'),
          kind: String(status.kind || SOURCE_KIND),
          note: String(status.note || ''),
          files: Number(status.files) || 0,
          lastAppendAt: Number(status.lastAppendAt) || null,
          roots: status.roots || null,
        }
        dirty = true
      },
    })

source.start()
log(
  SOURCE_MODE === 'hub'
    ? `hub cache watching: ${HUB_ROOT}`
    : `local live source watching: ${LIVE_CMD_ROOT} + ${LIVE_LOG_ROOT}`,
)

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

function handle(req, res) {
  const urlObj = new URL(req.url, `http://${HOST}`)

  if (urlObj.pathname === '/healthz') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false })
    return sendJson(res, 200, { ok: true, pid: process.pid, port: currentPort, version: VERSION, uptimeMs: Date.now() - startedAt })
  }

  if (urlObj.pathname === '/') {
    if (!authorized(req, urlObj, token)) return sendJson(res, 401, { error: 'token required' })
    res.writeHead(302, { location: `${PREFIX}/screen?token=${encodeURIComponent(token)}` })
    return res.end()
  }

  // Old DeepSeek-Harness-era prefix: keep bookmarks working, never serve there.
  if (urlObj.pathname === LEGACY_PREFIX || urlObj.pathname.startsWith(`${LEGACY_PREFIX}/`)) {
    const rest = urlObj.pathname.slice(LEGACY_PREFIX.length) || '/screen'
    res.writeHead(302, { location: `${PREFIX}${rest}${urlObj.search}` })
    return res.end()
  }

  if (!authorized(req, urlObj, token)) {
    log(`401 ${urlObj.pathname} from ${req.socket.remoteAddress}`)
    return sendJson(res, 401, { error: 'unauthorized' })
  }

  if (urlObj.pathname === `${PREFIX}/screen`) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
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
