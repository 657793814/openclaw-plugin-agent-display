import test from 'node:test'
import assert from 'node:assert/strict'

import { createStore, toolDetail } from '../lib/state.js'

const agent = { id: 'a1', session: { id: 's1' } }
const session = { id: 's1' }

function makeStore() {
  const clock = { at: 1_700_000_000_000 }
  const store = createStore({ now: () => clock.at, doneHoldMs: 6000 })
  return { store, clock, advance: (ms) => (clock.at += ms) }
}

const primary = (store) => store.snapshot().agents[0]

test('idle → thinking keeps turn/step in sync', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  assert.equal(primary(store).phase, 'idle')

  store.agentStatus({ agent, status: 'running' })
  assert.equal(primary(store).phase, 'thinking')

  store.sessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
  store.sessionEvent(session, { type: 'step/start', data: { turn: 3, step: 2 } })
  const record = primary(store)
  assert.equal(record.turn, 3)
  assert.equal(record.step, 2)
  assert.equal(record.phase, 'thinking')
})

test('tool/call → tool, tool/result → thinking, label carries the tool name', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, {
    type: 'tool/call',
    data: {
      turn: 1,
      step: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{"command":"pnpm test"}',
    },
  })
  const record = primary(store)
  assert.equal(record.phase, 'tool')
  assert.equal(record.activeTool.name, 'bash')
  assert.equal(record.activeTool.detail, 'pnpm test')
  assert.equal(record.toolCalls, 1)
  assert.match(record.label, /bash/)

  store.sessionEvent(session, { type: 'tool/result', data: { turn: 1, step: 1 } })
  assert.equal(primary(store).phase, 'thinking')
  assert.equal(primary(store).activeTool, null)
})

test('turn/end completed holds DONE then falls back to awaiting input', () => {
  const { store, advance } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  store.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(primary(store).phase, 'done')

  // agent/status idle arriving inside the hold window must not erase DONE
  store.agentStatus({ agent, status: 'idle' })
  assert.equal(primary(store).phase, 'done')

  advance(7000)
  assert.equal(primary(store).phase, 'awaiting')
  assert.equal(primary(store).lastOutcome.phase, 'done')
})

test('turn/end completed → awaiting input until the user speaks again', () => {
  const { store, advance } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  store.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(primary(store).phase, 'done')

  advance(7000)
  assert.equal(primary(store).phase, 'awaiting')
  assert.match(primary(store).label, /等待输入/)

  store.sessionEvent(session, {
    type: 'user/message',
    data: { turn: 2, source: { kind: 'user' } },
  })
  assert.equal(primary(store).phase, 'thinking')
  assert.equal(primary(store).awaitingInput, false)
})

test('aborted turn also counts as awaiting input, not plain idle', () => {
  const { store, advance } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  store.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(primary(store).phase, 'awaiting')
  advance(10_000)
  assert.equal(primary(store).phase, 'awaiting')
})

test('a fresh agent without any turn stays idle', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.agentStatus({ agent, status: 'idle' })
  assert.equal(primary(store).phase, 'idle')
})

test('turn/end error → failed with a readable message', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, {
    type: 'turn/end',
    data: {
      turn: 2,
      reason: { kind: 'error', error: { name: 'provider', message: 'API key missing' } },
    },
  })
  const record = primary(store)
  assert.equal(record.phase, 'failed')
  assert.equal(record.error, 'API key missing')
})

test('approval/asked → waiting, approval/decided → thinking', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, { type: 'approval/asked', data: { id: 'ap1', toolName: 'bash' } })
  assert.equal(primary(store).phase, 'waiting')
  assert.match(primary(store).label, /确认/)

  store.sessionEvent(session, { type: 'approval/decided', data: { id: 'ap1', outcome: 'allow' } })
  assert.equal(primary(store).phase, 'thinking')
})

test('assistant stream frames and usage are counted without storing text', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.assistantStream({ agent, frame: { type: 'start' } })
  store.assistantStream({ agent, frame: { type: 'chunk' } })
  store.sessionEvent(session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 10, outputTokens: 4 }, stream: [] },
  })
  const record = primary(store)
  assert.equal(record.streamFrames, 2)
  assert.deepEqual(record.usage, { inputTokens: 10, outputTokens: 4 })
})

test('snapshot is JSON-safe and never carries conversation content', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, {
    type: 'assistant/message',
    data: { message: { text: 'SECRET CONTENT' }, stream: [] },
  })
  const text = JSON.stringify(store.snapshot())
  assert.equal(text.includes('SECRET CONTENT'), false)
})

test('toolDetail prefers readable fields and truncates raw payloads', () => {
  assert.equal(toolDetail('{"description":"列目录","command":"ls"}'), '列目录')
  assert.equal(toolDetail('{"file_path":"/tmp/x.ts"}'), '/tmp/x.ts')
  assert.equal(toolDetail('not json'), 'not json')
  assert.equal(toolDetail(undefined), '')
  assert.equal(toolDetail(JSON.stringify({ command: 'x'.repeat(200) })).length, 90)
})

test('timeline tracks a running call and resolves it by callId with a summary', () => {
  const { store, advance } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, {
    type: 'tool/call',
    data: {
      turn: 2,
      step: 1,
      callId: 'call-1',
      name: 'bash',
      arguments: JSON.stringify({ command: 'pnpm test', token: 'must-not-leak' }),
    },
  })
  let entry = primary(store).timeline[0]
  assert.equal(entry.status, 'running')
  assert.equal(entry.callId, 'call-1')
  assert.equal(entry.detail, 'pnpm test')
  assert.equal(JSON.stringify(entry).includes('must-not-leak'), false)

  advance(1200)
  store.sessionEvent(session, {
    type: 'tool/result',
    data: { turn: 2, step: 1, callId: 'call-1', result: 'r'.repeat(200) },
  })
  entry = primary(store).timeline[0]
  assert.equal(entry.status, 'ok')
  assert.equal(entry.durationMs, 1200)
  assert.equal(entry.result.length, 80)
})

test('timeline matches the right call when several are in flight and marks errors', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  const call = (callId, name) =>
    store.sessionEvent(session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name, arguments: '{}' },
    })
  call('a', 'bash')
  call('b', 'read_file')

  store.sessionEvent(session, {
    type: 'tool/result',
    data: { callId: 'a', result: 'ok', error: null },
  })
  // Snapshot is newest first: b is still running, a is done.
  const [newest, oldest] = primary(store).timeline
  assert.equal(newest.callId, 'b')
  assert.equal(newest.status, 'running')
  assert.equal(oldest.callId, 'a')
  assert.equal(oldest.status, 'ok')

  store.sessionEvent(session, {
    type: 'tool/result',
    data: { callId: 'b', error: { message: 'ENOENT' } },
  })
  assert.equal(primary(store).timeline[0].status, 'error')
  assert.equal(primary(store).timeline[0].result, 'ENOENT')
})

test('timeline keeps the most recent 20 calls and exposes lastEventAt', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  for (let index = 1; index <= 25; index += 1) {
    store.sessionEvent(session, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: `c${index}`, name: 'bash', arguments: '{}' },
    })
  }
  const timeline = primary(store).timeline
  assert.equal(timeline.length, 20)
  assert.equal(timeline[0].callId, 'c25')
  assert.equal(timeline[19].callId, 'c6')
  assert.equal(typeof store.snapshot().lastEventAt, 'number')
})

test('turn elapsed time starts at turn/start and freezes at turn/end', () => {
  const { store, advance } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, { type: 'turn/start', data: { turn: 3 } })
  assert.equal(typeof primary(store).turnStartedAt, 'number')
  assert.equal(primary(store).turnElapsedMs, 0)
  advance(5000)
  store.sessionEvent(session, {
    type: 'turn/end',
    data: { turn: 3, reason: { kind: 'completed' } },
  })
  assert.equal(primary(store).turnElapsedMs, 5000)
  advance(5000)
  assert.equal(primary(store).turnElapsedMs, 5000)
})

test('timeline summaries never expose the full tool output', () => {
  const { store } = makeStore()
  store.agentCreated({ agent })
  store.sessionEvent(session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'read_file', arguments: '{}' },
  })
  store.sessionEvent(session, {
    type: 'tool/result',
    data: {
      callId: 'c1',
      result: { summary: 'line count: 12', content: 'SECRET BODY'.repeat(50) },
    },
  })
  const text = JSON.stringify(store.snapshot())
  assert.equal(text.includes('SECRET BODY'), false)
  assert.equal(primary(store).timeline[0].result, 'line count: 12')
})
