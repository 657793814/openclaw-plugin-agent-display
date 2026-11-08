const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createLiveSource } = require('../lib/live-source')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workspace(root, id, record) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'execution.json'), JSON.stringify(record))
  return path.join(dir, 'execution.json')
}

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-live-'))
  const cmdRoot = path.join(root, 'commands')
  const logRoot = path.join(root, 'logs')
  fs.mkdirSync(cmdRoot, { recursive: true })
  fs.mkdirSync(logRoot, { recursive: true })
  const events = []
  const statuses = []
  let clock = Date.now()
  const source = createLiveSource({
    cmdRoot,
    logRoot,
    pollMs: 250,
    now: () => clock,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
  })
  return {
    root,
    cmdRoot,
    events,
    statuses,
    source,
    advance(ms) {
      clock += ms
    },
    lastStatus() {
      return statuses[statuses.length - 1]
    },
  }
}

test('a running execution emits one call and never duplicates on later polls', async () => {
  const h = harness()
  const at = Date.now() - 1000
  workspace(h.cmdRoot, 'exec-1', {
    status: 'running',
    cwd: '/work/demo',
    pid: 123,
    createdAtMs: at,
    startedAtMs: at,
  })
  h.source.start()
  await sleep(400)
  await sleep(400)
  h.source.stop()

  const calls = h.events.filter((event) => event.kind === 'tool.call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].taskId, 'ws:/work/demo')
  assert.equal(h.lastStatus().state, 'live')
})

test('a vanished running record is closed with a failed result and drops out of live', async () => {
  const h = harness()
  const at = Date.now() - 500
  const file = workspace(h.cmdRoot, 'exec-2', {
    status: 'running',
    cwd: '/work/vanished',
    pid: 234,
    createdAtMs: at,
    startedAtMs: at,
  })
  h.source.start()
  await sleep(400)
  assert.equal(h.events.some((event) => event.kind === 'tool.call'), true)

  fs.rmSync(file)
  h.advance(5000)
  await sleep(400)
  h.advance(4000)
  await sleep(400)
  const result = h.events.find((event) => event.kind === 'tool.result')
  assert.equal(result !== undefined, true)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'execution record unavailable')

  h.advance(40_000)
  await sleep(400)
  assert.equal(h.lastStatus().state, 'silent')
  h.source.stop()
})

test('sinceMs suppresses history so a hub fallback does not replay old events', async () => {
  const h = harness()
  const old = Date.now() - 5 * 60_000
  workspace(h.cmdRoot, 'exec-old', {
    status: 'exited',
    cwd: '/work/old',
    exitCode: 0,
    createdAtMs: old,
    startedAtMs: old,
    finishedAtMs: old + 1000,
  })
  const since = Date.now() - 10_000
  const source = createLiveSource({
    cmdRoot: h.cmdRoot,
    logRoot: path.join(h.root, 'logs'),
    pollMs: 250,
    sinceMs: since,
    onEvent: (event) => h.events.push(event),
    onStatus: (status) => h.statuses.push(status),
  })
  source.start()
  await sleep(400)
  source.stop()
  assert.equal(h.events.length, 0)
})
