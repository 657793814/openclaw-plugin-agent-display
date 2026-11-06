import test from 'node:test'
import assert from 'node:assert/strict'

import {
  authorize,
  createToken,
  isLoopbackAddress,
  tokenFromRequest,
  tokenMatches,
} from '../lib/auth.js'

const loopback = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }

test('createToken produces URL-safe, non-repeating secrets', () => {
  const a = createToken()
  const b = createToken()
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.ok(a.length >= 30)
  assert.notEqual(a, b)
})

test('tokenFromRequest reads Bearer, custom header and query in that order', () => {
  assert.equal(
    tokenFromRequest({ headers: { authorization: 'Bearer abc123' } }, new URL('http://x/')),
    'abc123',
  )
  assert.equal(
    tokenFromRequest({ headers: { 'x-agent-status-token': 'hdr-token' } }, new URL('http://x/')),
    'hdr-token',
  )
  assert.equal(
    tokenFromRequest({ headers: {} }, new URL('http://x/?token=query-token')),
    'query-token',
  )
  assert.equal(tokenFromRequest({ headers: {} }, new URL('http://x/')), '')
  // Bearer wins over the query string.
  assert.equal(
    tokenFromRequest(
      { headers: { authorization: 'Bearer first' } },
      new URL('http://x/?token=second'),
    ),
    'first',
  )
})

test('tokenMatches is exact and never accepts empty values', () => {
  assert.equal(tokenMatches('abc', 'abc'), true)
  assert.equal(tokenMatches('abc', 'abd'), false)
  assert.equal(tokenMatches('abc', 'abcd'), false)
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches(undefined, 'abc'), false)
})

test('isLoopbackAddress accepts only local peers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.2'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.10'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('authorize accepts the install token and the per-boot ticket, rejects anonymous', () => {
  const secrets = ['install-token', 'boot-ticket']
  assert.equal(
    authorize(
      { headers: { authorization: 'Bearer install-token' }, socket: loopback.socket },
      new URL('http://x/'),
      secrets,
    ),
    true,
  )
  assert.equal(
    authorize({ headers: {}, socket: loopback.socket }, new URL('http://x/?token=boot-ticket'), secrets),
    true,
  )
  assert.equal(authorize({ headers: {}, socket: loopback.socket }, new URL('http://x/'), secrets), false)
  assert.equal(
    authorize({ headers: { authorization: 'Bearer wrong' }, socket: loopback.socket }, new URL('http://x/'), secrets),
    false,
  )
  // Non-loopback peers are rejected even with a valid token.
  assert.equal(
    authorize(
      { headers: { authorization: 'Bearer install-token' }, socket: { remoteAddress: '192.168.0.5' } },
      new URL('http://x/'),
      secrets,
    ),
    false,
  )
})
