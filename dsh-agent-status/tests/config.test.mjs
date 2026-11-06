import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, normalizeConfig, clientConfig } from '../lib/config.js'

test('normalizeConfig fills defaults and accepts a profile row', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, DEFAULTS)

  const row = normalizeConfig({
    token: '  abc  ',
    port: '17818',
    theme: 'mono',
    screenTheme: 'galaxy',
    position: 'top-right',
    visible: false,
    screenButton: false,
    screenLanding: 'screen',
    screenWindow: 'window',
    waitingAfterMs: 20_000,
    doneHoldMs: 3000,
    pollMs: 500,
  })
  assert.equal(row.token, 'abc')
  assert.equal(row.port, 17818)
  assert.equal(row.theme, 'mono')
  assert.equal(row.screenTheme, 'galaxy')
  assert.equal(row.position, 'top-right')
  assert.equal(row.visible, false)
  assert.equal(row.screenButton, false)
  assert.equal(row.screenLanding, 'screen')
  assert.equal(row.screenWindow, 'window')
  assert.equal(row.waitingAfterMs, 20_000)
})

test('normalizeConfig rejects malformed values instead of throwing', () => {
  const config = normalizeConfig({
    token: 42,
    port: -1,
    theme: 'rainbow',
    screenTheme: 'nebula',
    position: 'center',
    visible: 'maybe',
    screenButton: 'nope',
    screenLanding: 'chat',
    screenWindow: 'iframe',
    waitingAfterMs: 10,
    doneHoldMs: 'fast',
    pollMs: 1,
  })
  assert.equal(config.token, '')
  assert.equal(config.port, DEFAULTS.port)
  assert.equal(config.theme, DEFAULTS.theme)
  assert.equal(config.screenTheme, DEFAULTS.screenTheme)
  assert.equal(config.position, DEFAULTS.position)
  assert.equal(config.visible, DEFAULTS.visible)
  assert.equal(config.screenButton, DEFAULTS.screenButton)
  assert.equal(config.screenLanding, DEFAULTS.screenLanding)
  assert.equal(config.screenWindow, DEFAULTS.screenWindow)
  assert.equal(config.waitingAfterMs, DEFAULTS.waitingAfterMs)
  assert.equal(config.doneHoldMs, DEFAULTS.doneHoldMs)
  assert.equal(config.pollMs, DEFAULTS.pollMs)
})

test('clientConfig never exposes the install token', () => {
  const client = clientConfig(normalizeConfig({ token: 'secret-token' }))
  assert.equal('token' in client, false)
  assert.equal(JSON.stringify(client).includes('secret-token'), false)
})
