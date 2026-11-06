/**
 * dsh-agent-status — host half of the agent work-state HUD.
 *
 * Read-only by design: it subscribes to public host events
 * (`agent/status`, `agent/assistant-stream`, `agent/error`, `session/event`),
 * folds them into a tiny snapshot, then
 *   - serves `GET /dsh-agent-status/api/state` (JSON, authenticated)
 *   - serves `GET /dsh-agent-status/stream` (SSE, authenticated)
 *   - injects one script row through `webserver/index-inject` that renders the
 *     HUD inside the existing DSH page.
 *
 * Auth model:
 *   - the install token comes from the profile config row (`token`), so any
 *     local client must present it as `Authorization: Bearer`, `X-Agent-Status-Token`
 *     or `?token=`;
 *   - the injected page only receives a per-boot ticket, so the long-lived
 *     token is never embedded in HTML. The ticket dies with the host process.
 *   - routes reject non-loopback peers, missing tokens and wrong tokens with 401.
 *
 * No harness source is patched; nothing is written to disk.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { authorize, createToken } from './lib/auth.js'
import { normalizeConfig } from './lib/config.js'
import { renderScreenHtml } from './lib/screen.js'
import { createStore } from './lib/state.js'

export const name = 'agent-status'
export const inject = []

const PREFIX = '/dsh-agent-status'
const HEARTBEAT_MS = 15_000

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const VERSION = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
).version

function readAsset(relative) {
  return fs.readFileSync(path.join(packageRoot, relative), 'utf8')
}

function toInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

function requestUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('/', 'http://127.0.0.1')
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} [rawConfig] profile row config (`config:` in cordis.patch.yml)
 */
export function apply(ctx, rawConfig) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[agent-status] ${message}`)
    } catch {
      /* logging must never break the host */
    }
  }

  const config = normalizeConfig(rawConfig, {
    envToken: process.env.DSH_AGENT_STATUS_TOKEN,
  })
  // Without a configured token the plugin still refuses anonymous access:
  // fall back to an ephemeral secret for this process only.
  if (config.token === '') {
    warn('config.token is empty; using an ephemeral per-boot token (run scripts/install.mjs to persist one)')
  }
  const installToken = config.token === '' ? createToken() : config.token
  // Short-lived ticket handed to the injected HUD; never written to disk.
  const ticket = createToken()
  const secrets = installToken === ticket ? [installToken] : [installToken, ticket]

  const store = createStore({ doneHoldMs: config.doneHoldMs })
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()
  let flushTimer = null

  /** @returns {string} */
  const payload = () => JSON.stringify({ ...store.snapshot(), version: VERSION, prefix: PREFIX })

  const broadcast = () => {
    if (clients.size === 0) return
    const frame = `event: state\ndata: ${payload()}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  const schedule = () => {
    if (clients.size === 0 || flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      broadcast()
    }, config.sseFlushMs)
    flushTimer.unref?.()
  }

  /**
   * Every subscription is isolated: a malformed payload must not reject into
   * the host's event bus.
   * @param {string} event
   * @param {(payload: any) => void} handler
   */
  const listen = (event, handler) => {
    try {
      ctx.on(
        event,
        (payload) => {
          try {
            handler(payload)
            schedule()
          } catch (error) {
            warn(`${event} handler failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
        { global: true },
      )
    } catch (error) {
      warn(`cannot subscribe ${event}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  listen('agent/created', (payload) => store.agentCreated(payload))
  listen('agent/disposed', (payload) => store.agentDisposed(payload))
  listen('agent/status', (payload) => store.agentStatus(payload))
  listen('agent/error', (payload) => store.agentError(payload))
  listen('agent/assistant-stream', (payload) => store.assistantStream(payload))

  // `session/event` has two arguments; register it directly instead of via listen().
  try {
    ctx.on(
      'session/event',
      (session, event) => {
        try {
          store.sessionEvent(session, event)
          schedule()
        } catch (error) {
          warn(`session/event handler failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
      { global: true },
    )
  } catch (error) {
    warn(`cannot subscribe session/event: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Synchronous injection subscription: the desktop shell snapshots once at boot.
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    try {
      const css = readAsset('runtime/hud.css')
      const js = readAsset('runtime/hud.js')
      const client = {
        prefix: PREFIX,
        version: VERSION,
        css,
        pollMs: config.pollMs,
        theme: config.theme,
        position: config.position,
        visible: config.visible,
        screenButton: config.screenButton,
        screenLanding: config.screenLanding,
        screenWindow: config.screenWindow,
        waitingAfterMs: config.waitingAfterMs,
        // Per-boot ticket, not the persisted install token.
        ticket,
      }
      table.push({
        kind: 'script',
        placement: 'body',
        text: `globalThis.__DSH_AGENT_STATUS__=${toInlineJson(client)};\n${js}`,
      })
    } catch (error) {
      warn(`index injection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /**
   * Assemble the big-screen page per request from `runtime/screen.*`, so
   * front-end fixes for the standalone page do not require a host restart.
   * The page never receives the install token; it reads the ticket from the
   * URL that the HUD builds from `location.origin`.
   */
  function screenPage() {
    // Vendor scripts are inlined (no CDN, no extra route) so the theme works
    // offline inside the Electron shell. They are the exact three@0.147 files
    // the original index.html loads from jsDelivr.
    const vendor = [
      'three.min.js',
      'CopyShader.js',
      'LuminosityHighPassShader.js',
      'EffectComposer.js',
      'RenderPass.js',
      'ShaderPass.js',
      'UnrealBloomPass.js',
    ]
      .map((name) => readAsset(`runtime/nebula/vendor/${name}`))
      .join('\n;\n')
    return renderScreenHtml({
      template: readAsset('runtime/screen.html'),
      css: readAsset('runtime/screen.css'),
      // Order matters: real-data core → three.js → original NEBULA renderer → page controller.
      js: [
        readAsset('runtime/nebula-core.js'),
        vendor,
        readAsset('runtime/nebula/theme.js'),
        '\nglobalThis.DSHNebulaMount = mountNebula;\n;\n',
        readAsset('runtime/screen.js'),
      ].join('\n'),
      config: {
        prefix: PREFIX,
        version: VERSION,
        theme: config.theme,
        screenTheme: config.screenTheme,
        pollMs: config.pollMs,
        waitingAfterMs: config.waitingAfterMs,
        // Original theme-05 markup + CSS, mounted verbatim into a Shadow DOM.
        nebulaTemplate: readAsset('runtime/nebula/template.html'),
      },
    })
  }

  /** Shared HTTP surface: host webServer routes and the optional standalone port. */
  function handle(req, res) {
    const url = requestUrl(req)
    const pathname = url.pathname
    if (
      pathname !== `${PREFIX}/api/state` &&
      pathname !== `${PREFIX}/stream` &&
      pathname !== `${PREFIX}/screen`
    ) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found', prefix: PREFIX }))
      return
    }

    if (!authorize(req, url, secrets)) {
      const text = JSON.stringify({
        error: 'unauthorized',
        hint:
          'pass the token from the profile config: Authorization: Bearer <token>, ?token=<token>, or the ticket injected into the HUD',
      })
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
        'WWW-Authenticate': 'Bearer realm="dsh-agent-status"',
      })
      res.end(text)
      return
    }

    if (pathname === `${PREFIX}/screen`) {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        res.writeHead(405, { Allow: 'GET' })
        res.end()
        return
      }
      let html
      try {
        html = screenPage()
      } catch (error) {
        warn(`screen render failed: ${error instanceof Error ? error.message : String(error)}`)
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('screen render failed')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      res.end(html)
      return
    }

    if (pathname === `${PREFIX}/api/state`) {
      if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
        res.writeHead(405, { Allow: 'GET' })
        res.end()
        return
      }
      const text = payload()
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
      })
      res.end(text)
      return
    }

    // SSE: EventSource-compatible; the client also has a polling fallback.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    res.write(`event: state\ndata: ${payload()}\n\n`)
    clients.add(res)
    req.on('close', () => {
      clients.delete(res)
    })
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = []
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/api/state`,
          handler: handle,
        }),
      )
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/stream`,
          handler: handle,
        }),
      )
      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: `${PREFIX}/screen`,
          handler: handle,
        }),
      )

      const heartbeat = setInterval(() => {
        for (const res of clients) {
          try {
            res.write(': ping\n\n')
          } catch {
            clients.delete(res)
          }
        }
      }, HEARTBEAT_MS)
      heartbeat.unref?.()

      return () => {
        for (const dispose of disposers) dispose?.()
        clearInterval(heartbeat)
        for (const res of clients) {
          try {
            res.end()
          } catch {
            /* client already gone */
          }
        }
        clients.clear()
        if (flushTimer !== null) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
      }
    })
  })

  // Optional dedicated loopback listener. 0 = reuse the host webServer only.
  if (config.port > 0) {
    ctx.effect(() => {
      const server = http.createServer(handle)
      server.on('error', (error) => {
        warn(`standalone listener on 127.0.0.1:${config.port} failed: ${error.message}`)
      })
      server.listen(config.port, '127.0.0.1', () => {
        try {
          ctx.logger?.info?.(`[agent-status] standalone listener: http://127.0.0.1:${config.port}${PREFIX}/api/state`)
        } catch {
          /* logging is never fatal */
        }
      })
      return () => server.close()
    })
  }
}
