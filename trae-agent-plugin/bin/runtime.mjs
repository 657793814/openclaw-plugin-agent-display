import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const RUNTIME_DIR = path.join(PLUGIN_ROOT, '.runtime')
export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json')
export const LOG_FILE = path.join(RUNTIME_DIR, 'server.log')

function pluginVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.trae-plugin', 'plugin.json'), 'utf8'))
    return String(manifest.version || '')
  } catch {
    return ''
  }
}

export const VERSION = pluginVersion() || '0.1.0'
export const PREFIX = '/nebula-screen'
// Kept so previously bookmarked `/dsh-agent-status/...` links still resolve.
export const LEGACY_PREFIX = '/dsh-agent-status'

export function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function writeState(state) {
  ensureRuntimeDir()
  // The file carries the token and the full URL; keep it private to this user
  // (an existing 0644 file from an older install is corrected too).
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(STATE_FILE, 0o600)
  } catch {
    /* best effort */
  }
}

export function clearState() {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {
    /* 已不存在 */
  }
}

export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex')
}

export function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

export function isLoopback(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '')
  const okAddr = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  const host = String(req.headers.host || '').split(':')[0]
  const okHost = host === '127.0.0.1' || host === 'localhost'
  return okAddr && okHost
}

export function authorized(req, urlObj, token) {
  if (!isLoopback(req)) return false
  const fromQuery = urlObj.searchParams.get('token') || ''
  const fromHeader = String(req.headers['x-agent-status-token'] || '')
  return sameToken(fromQuery, token) || sameToken(fromHeader, token)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function health(port, timeoutMs = 900) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export function readAsset(relative) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', relative), 'utf8')
}
