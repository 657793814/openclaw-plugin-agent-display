const assert = require('node:assert/strict')
const test = require('node:test')

const { createStore } = require('../lib/store')

function clock(start = 1000) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
    },
  }
}

test('tool.call → tool phase, tool.result → thinking, then done → idle', () => {
  const c = clock()
  const store = createStore({ now: c.now, doneHoldMs: 6000, idleAfterMs: 20000 })
  store.sessionStart({ at: c.now(), taskId: 'task-a', sessionId: 's1', model: 'deepseek', turn: 3 })
  let snap = store.snapshot()
  assert.equal(snap.agents[0].phase, 'thinking')
  assert.equal(snap.agents[0].turn, 3)

  store.toolCall({ at: c.now(), taskId: 'task-a', callId: 'c1', name: 'Edit', detail: 'TagService.java' })
  snap = store.snapshot()
  assert.equal(snap.agents[0].phase, 'tool')
  assert.equal(snap.agents[0].label, '调用工具 · Edit')
  assert.equal(snap.agents[0].timeline[0].status, 'running')
  assert.equal(snap.agents[0].timeline[0].detail, 'TagService.java')

  c.advance(1500)
  store.toolResult({ at: c.now(), taskId: 'task-a', callId: 'c1', ok: true })
  snap = store.snapshot()
  assert.equal(snap.agents[0].phase, 'thinking')
  assert.equal(snap.agents[0].timeline[0].status, 'ok')
  assert.equal(snap.agents[0].timeline[0].durationMs, 1500)

  store.turnEnd({ at: c.now(), taskId: 'task-a', reason: 'completed' })
  assert.equal(store.snapshot().agents[0].phase, 'done')

  c.advance(7000)
  assert.equal(store.snapshot().agents[0].phase, 'idle')
})

test('duplicate calls with the same callId never duplicate the timeline', () => {
  const store = createStore({ now: () => 1000 })
  store.toolCall({ at: 1000, taskId: 't', callId: 'dup', name: 'Grep', detail: 'src' })
  store.toolCall({ at: 1000, taskId: 't', callId: 'dup', name: 'Grep', detail: 'src' })
  store.toolResult({ at: 1100, taskId: 't', callId: 'dup', ok: true })
  store.toolResult({ at: 1200, taskId: 't', callId: 'dup', ok: true })
  const agent = store.snapshot().agents[0]
  assert.equal(agent.timeline.length, 1)
  assert.equal(agent.toolCalls, 1)
  assert.equal(agent.timeline[0].status, 'ok')
})

test('failed result sets error and keeps the timeline entry flagged', () => {
  const store = createStore({ now: () => 1000 })
  store.toolCall({ at: 1000, taskId: 't', callId: 'x', name: 'Shell', detail: '运行测试' })
  store.toolResult({ at: 1400, taskId: 't', callId: 'x', ok: false, error: 'exit 1' })
  const agent = store.snapshot().agents[0]
  assert.equal(agent.timeline[0].status, 'error')
  assert.equal(agent.timeline[0].result, 'exit 1')
  assert.equal(agent.error, 'exit 1')
})

test('usage replaces (not accumulates) the current turn counters', () => {
  const store = createStore({ now: () => 1000 })
  store.sessionStart({ at: 1000, taskId: 't', model: 'deepseek' })
  store.usage({ at: 1000, taskId: 't', inputTokens: 100, outputTokens: 10 })
  store.usage({ at: 1000, taskId: 't', inputTokens: 140, outputTokens: 30 })
  assert.deepEqual(store.snapshot().agents[0].usage, { inputTokens: 140, outputTokens: 30 })
})

test('queue begin shows a queue label; a tool call clears it', () => {
  const store = createStore({ now: () => 1000 })
  store.sessionStart({ at: 1000, taskId: 't' })
  store.queue({ at: 1000, taskId: 't', status: 'begin', position: 2 })
  assert.equal(store.snapshot().agents[0].label, '排队中 · #2')
  store.toolCall({ at: 1000, taskId: 't', callId: 'q', name: 'Read', detail: 'a.ts' })
  assert.equal(store.snapshot().agents[0].label, '调用工具 · Read')
})

test('sweep turns a silent active task into done', () => {
  const c = clock()
  const store = createStore({ now: c.now, idleAfterMs: 20000 })
  store.toolCall({ at: c.now(), taskId: 't', callId: 'slow', name: 'Shell', detail: 'build' })
  c.advance(25000)
  store.sweep()
  assert.equal(store.snapshot().agents[0].phase, 'done')
})

test('snapshot keeps the dsh contract fields used by NEBULA', () => {
  const store = createStore({ now: () => 1000 })
  store.sessionStart({ at: 1000, taskId: 't', sessionId: 's', model: 'm', turn: 1 })
  store.toolCall({ at: 1000, taskId: 't', callId: 'c', name: 'Read', detail: 'a.ts' })
  const snap = store.snapshot()
  assert.equal(snap.version, 1)
  assert.ok(Array.isArray(snap.agents))
  assert.ok(Array.isArray(snap.events))
  assert.equal(typeof snap.primary, 'string')
  for (const key of [
    'id', 'sessionId', 'model', 'phase', 'label', 'since', 'updatedAt', 'elapsedMs',
    'turnStartedAt', 'turnEndedAt', 'turnElapsedMs', 'turn', 'step', 'toolCalls',
    'toolMs', 'activeTool', 'usage', 'error', 'lastOutcome', 'awaitingInput', 'timeline',
  ]) {
    assert.ok(key in snap.agents[0], `missing ${key}`)
  }
  assert.equal(snap.agents[0].awaitingInput, false)
})
