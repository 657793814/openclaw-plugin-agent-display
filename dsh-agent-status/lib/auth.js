/**
 * Token helpers for the dsh-agent-status HTTP surface.
 *
 * The host webServer is reachable from any local process, so every route must
 * be authenticated. Two kinds of secrets are accepted:
 *   - the install token from the profile config (for curl / external clients);
 *   - a per-boot ticket embedded in the injected HUD script (short-lived: it
 *     dies with the host process and never touches disk).
 *
 * Pure and host-free so the checks can be unit-tested.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const TOKEN_HEADER = 'x-agent-status-token'

/** @returns {string} 32 chars of URL-safe entropy. */
export function createToken() {
  return randomBytes(24).toString('base64url')
}

/**
 * Read a candidate secret from `Authorization: Bearer`, `X-Agent-Status-Token`
 * or `?token=` (EventSource cannot set headers).
 * @param {{ headers?: Record<string, any> }} req
 * @param {URL} [url]
 * @returns {string}
 */
export function tokenFromRequest(req, url) {
  const headers = req?.headers ?? {}
  const authorization = headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim())
    if (match !== null) return match[1].trim()
  }
  const header = headers[TOKEN_HEADER]
  if (typeof header === 'string' && header.trim() !== '') return header.trim()
  const query = url?.searchParams?.get('token')
  return typeof query === 'string' ? query.trim() : ''
}

/**
 * Constant-time comparison; empty strings never match.
 * @param {string} candidate
 * @param {string} expected
 * @returns {boolean}
 */
export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  if (candidate === '' || expected === '') return false
  const left = Buffer.from(candidate, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Accept only loopback peers. The host already binds localhost, this is a
 * second fence for proxied / tunnelled setups.
 * @param {string | undefined} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  if (address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('127.')) return true
  if (address === 'localhost') return true
  return false
}

/**
 * @param {{ headers?: Record<string, any>, socket?: { remoteAddress?: string } }} req
 * @param {URL} url
 * @param {string[]} expected one or more accepted secrets
 * @returns {boolean}
 */
export function authorize(req, url, expected) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const candidate = tokenFromRequest(req, url)
  return expected.some((secret) => tokenMatches(candidate, secret))
}
