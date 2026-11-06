import test from 'node:test'
import assert from 'node:assert/strict'

import {
  hasPatchBlock,
  mergeProfilePackage,
  readPatchBlock,
  removePatch,
  removeProfilePackage,
  renderPatchBlock,
  upsertPatch,
} from '../lib/install.js'

const base = {
  token: 'tok-123',
  port: 0,
  theme: 'neon',
  screenTheme: 'galaxy',
  position: 'bottom-right',
  visible: true,
  screenButton: true,
  screenLanding: 'hud',
  screenWindow: 'tab',
  waitingAfterMs: 15_000,
  doneHoldMs: 6000,
  pollMs: 800,
}

test('upsertPatch inserts a managed row into an empty or [] patch layer', () => {
  for (const empty of ['', '\n', '[]\n', '# comment only\n']) {
    const next = upsertPatch(empty, base)
    assert.equal(hasPatchBlock(next), true)
    assert.match(next, /- id: dsh-agent-status/u)
    assert.match(next, /token: "tok-123"/u)
    assert.doesNotMatch(next, /\n\[\]/u)
  }
})

test('upsertPatch is idempotent: same config twice yields the same text', () => {
  const once = upsertPatch('[]\n', base)
  const twice = upsertPatch(once, base)
  assert.equal(twice, once)
  assert.equal(once.match(/>>> dsh-agent-status:managed/gu).length, 1)
})

test('upsertPatch preserves the user entries above the managed block', () => {
  const user = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n'
  const next = upsertPatch(user, base)
  assert.ok(next.startsWith(user.trimEnd()))
  assert.equal(hasPatchBlock(next), true)
})

test('upsertPatch replaces values but keeps a single block', () => {
  const first = upsertPatch('[]\n', base)
  const next = upsertPatch(first, { ...base, token: 'rotated', position: 'top-right' })
  assert.equal(next.match(/>>> dsh-agent-status:managed/gu).length, 1)
  assert.match(next, /token: "rotated"/u)
  assert.match(next, /position: "top-right"/u)
})

test('readPatchBlock round-trips the managed config', () => {
  const text = renderPatchBlock(base)
  const parsed = readPatchBlock(text)
  assert.equal(parsed.token, 'tok-123')
  assert.equal(parsed.screenTheme, 'galaxy')
  assert.equal(parsed.port, 0)
  assert.equal(parsed.visible, true)
  assert.equal(parsed.position, 'bottom-right')
  assert.equal(parsed.screenButton, true)
  assert.equal(parsed.screenLanding, 'hud')
  assert.equal(parsed.screenWindow, 'tab')
  assert.equal(parsed.waitingAfterMs, 15_000)
})

test('the managed block can disable the screen button and switch the landing page', () => {
  const text = renderPatchBlock({
    ...base,
    screenButton: false,
    screenLanding: 'screen',
    screenWindow: 'window',
    waitingAfterMs: 20_000,
  })
  const parsed = readPatchBlock(text)
  assert.equal(parsed.screenButton, false)
  assert.equal(parsed.screenLanding, 'screen')
  assert.equal(parsed.screenWindow, 'window')
  assert.equal(parsed.waitingAfterMs, 20_000)
})

test('removePatch removes the block and leaves a valid empty document', () => {
  assert.equal(removePatch(upsertPatch('[]\n', base)), '[]\n')
  const user = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n'
  const removed = removePatch(upsertPatch(user, base))
  assert.equal(hasPatchBlock(removed), false)
  assert.match(removed, /ui-chat/u)
})

test('mergeProfilePackage adds link dependency and bundle once', () => {
  const pkg = {
    dependencies: { existing: '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }
  const first = mergeProfilePackage(pkg, { linkSpec: 'link:../../pkg' })
  assert.equal(first.changed, true)
  assert.equal(first.json.dependencies['dsh-agent-status'], 'link:../../pkg')
  assert.ok(first.json.dsh.profile.bundles.includes('dsh-agent-status'))
  const second = mergeProfilePackage(first.json, { linkSpec: 'link:../../pkg' })
  assert.equal(second.changed, false)
  assert.equal(second.json.dsh.profile.bundles.length, 2)
})

test('removeProfilePackage reverses the merge', () => {
  const pkg = {
    dependencies: { existing: '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }
  const merged = mergeProfilePackage(pkg, { linkSpec: 'link:../../pkg' }).json
  const removed = removeProfilePackage(merged)
  assert.equal(removed.changed, true)
  assert.equal('dsh-agent-status' in removed.json.dependencies, false)
  assert.deepEqual(removed.json.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
})
