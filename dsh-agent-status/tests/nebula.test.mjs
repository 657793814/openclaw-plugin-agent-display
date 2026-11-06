import test from 'node:test'
import assert from 'node:assert/strict'

// Classic script: registers globalThis.__DSH_NEBULA_CORE__ on import.
import '../runtime/nebula-core.js'

const C = globalThis.__DSH_NEBULA_CORE__

const call = (over = {}) => ({
  id: over.callId || over.id || 'c1',
  callId: over.callId || over.id || 'c1',
  name: over.name || 'bash',
  detail: over.detail || 'ls',
  status: over.status || 'ok',
  startedAt: over.startedAt || 1000,
  endedAt: over.endedAt || 1200,
  durationMs: over.durationMs,
  result: over.result || 'ok',
})

const agent = (id, over = {}) => ({
  id,
  label: over.label || '空闲',
  phase: over.phase || 'idle',
  turn: over.turn || 1,
  step: over.step || 0,
  updatedAt: over.updatedAt || 1000,
  timeline: over.timeline || [],
})

test('phase palette reuses the original theme colours', () => {
  assert.equal(C.tint('tool'), '#ff6fae')
  assert.equal(C.tint('failed'), '#ff6b8b')
  assert.equal(C.tint('done'), '#6ff0c0')
  assert.equal(C.tint('nope'), '#9fd4ff')
  assert.ok(C.loadOf('tool') > C.loadOf('thinking'))
  assert.ok(C.loadOf('thinking') > C.loadOf('idle'))
})

test('slots are stable per agent id and capped at 12', () => {
  const first = C.assignSlots([agent('a'), agent('b'), agent('c')])
  assert.equal(first.slots[1].id, 'a')
  assert.equal(first.map.get('b'), 2)
  // Removing an agent must not reshuffle the others.
  const second = C.assignSlots([agent('b'), agent('c')], first.map)
  assert.equal(second.map.get('b'), 2)
  assert.equal(second.map.get('c'), 3)
  // A new agent takes the lowest free slot.
  const third = C.assignSlots([agent('b'), agent('c'), agent('d')], second.map)
  assert.equal(third.map.get('d'), 1)
  // 13 real agents → only 12 clouds.
  const many = Array.from({ length: 13 }, (_, i) => agent(`x${i}`))
  assert.equal(C.assignSlots(many).map.size, 12)
})

test('agent identity labels stay distinguishable for common id shapes', () => {
  assert.equal(C.shortLabel(agent('main-agent')), 'MAIN')
  assert.equal(C.shortLabel(agent('scout-agent')), 'SCOUT')
  assert.equal(C.shortLabel(agent('proof-agent')), 'PROOF')
  assert.equal(C.shortLabel(agent('sess-a1')), 'A1')
  assert.equal(C.shortLabel(agent('agent-7f3c9d')), '7F3C9D')
})

test('words follow the real timeline order (newest-first input → oldest-first slots)', () => {
  const timeline = [call({ id: 'c2', name: 'write' }), call({ id: 'c1', name: 'read' })]
  const words = C.wordsFor(agent('a', { timeline }), 1)
  assert.deepEqual(words.map((w) => w.name), ['read', 'write'])
  assert.equal(words[1].slot, 1)
})

test('only the last 14 calls survive (the theme has 14 word slots)', () => {
  // newest-first contract: c19 is the newest call.
  const timeline = Array.from({ length: 20 }, (_, i) => call({ id: `c${i}`, name: `t${i}` })).reverse()
  const words = C.wordsFor(agent('a', { timeline }), 1)
  assert.equal(words.length, 14)
  assert.equal(words[0].name, 't6')
  assert.equal(words[13].name, 't19')
  assert.equal(words[13].slot, 13)
})

test('word states mirror status and never invent a result', () => {
  const words = C.wordsFor(agent('a', { timeline: [call({ status: 'running' }), call({ status: 'error', callId: 'e2' })] }), 1)
  // newest-first input → reversed: error call first, running second.
  assert.equal(words[0].state, 'flag')
  assert.equal(words[1].state, 'read')
  const running = C.wordsFor(agent('a', { timeline: [call({ status: 'running' })] }), 1)
  assert.equal(running[0].state, 'read')
})

test('counters and success rate come from real statuses', () => {
  const sections = [
    { words: [{ status: 'ok' }, { status: 'error' }] },
    { words: [{ status: 'running' }] },
  ]
  const counts = C.countWords(sections)
  assert.deepEqual(counts, { calls: 3, running: 1, ok: 1, error: 1 })
  assert.equal(C.successRate(counts), 50)
  assert.equal(C.successRate({ ok: 0, error: 0 }), 0)
})

test('focus prefers the agent with the newest running tool', () => {
  const slots = Array(13).fill(null)
  slots[1] = agent('idle-one', { phase: 'done', updatedAt: 500 })
  slots[2] = agent('worker', { phase: 'tool', timeline: [call({ status: 'running', startedAt: 3000 })] })
  slots[3] = agent('thinker', { phase: 'thinking', updatedAt: 2000 })
  assert.equal(C.focusSlot(slots, 'idle-one'), 2)
  // No running tool → newest non-idle.
  slots[2] = agent('worker', { phase: 'done', updatedAt: 1000 })
  assert.equal(C.focusSlot(slots, 'idle-one'), 3)
})

test('event verbs only map real snapshot phases', () => {
  assert.equal(C.eventVerb({ phase: 'failed' }), 'flag')
  assert.equal(C.eventVerb({ phase: 'waiting' }), 'ask')
  assert.equal(C.eventVerb({ phase: 'tool' }), 'crawl')
  assert.equal(C.eventVerb({ phase: 'done' }), 'fix')
  assert.equal(C.eventVerb({ phase: 'thinking' }), 'read')
})

test('empty harness produces an explicit empty plan, not fake clouds', () => {
  const plan = C.planSnapshot({ agents: [], events: [], at: 0, primary: null })
  assert.equal(plan.sections.length, 0)
  assert.equal(plan.counts.calls, 0)
  assert.equal(plan.rate, 0)
  assert.equal(plan.idle, true)
  assert.equal(plan.focus, 0)
})

test('one real agent → one section, one cloud, no extra words', () => {
  const snapshot = {
    agents: [
      agent('sess-a1', {
        phase: 'tool',
        label: '调用工具 · bash',
        timeline: [call({ callId: 'k1', status: 'running' })],
      }),
    ],
    events: [{ at: 1100, agentId: 'sess-a1', phase: 'tool', text: 'bash ls' }],
    at: 1200,
    primary: 'sess-a1',
  }
  const plan = C.planSnapshot(snapshot)
  assert.equal(plan.sections.length, 1)
  assert.equal(plan.sections[0].words.length, 1)
  assert.equal(plan.sections[0].words[0].state, 'read')
  assert.equal(plan.focus, 1)
  assert.equal(plan.agents[0].tint, '#ff6fae')
  // Missing clouds stay neutral and empty.
  for (let i = 1; i < 12; i += 1) assert.equal(plan.agents[i].empty, true)
})

test('an agent without tool calls still gets a section with zero words', () => {
  const plan = C.planSnapshot({ agents: [agent('sess-z', { phase: 'idle' })], events: [] })
  assert.equal(plan.sections.length, 1)
  assert.equal(plan.sections[0].words.length, 0)
  assert.equal(plan.counts.calls, 0)
})

test('radar values are bounded and derived from real counts', () => {
  const plan = C.planSnapshot({
    agents: [agent('a', { phase: 'tool', timeline: [call({ status: 'ok' }), call({ status: 'error' })] })],
    events: [{ at: 1, agentId: 'a', phase: 'tool', text: 'x' }],
  })
  const values = C.radarValues(plan)
  assert.equal(values.length, 7)
  for (const value of values) assert.ok(value >= 0.06 && value <= 1)
})

test('previous states are preserved so a call is not re-read', () => {
  const snapshot = { agents: [agent('a', { phase: 'done', timeline: [call({ callId: 'k1' })] })], events: [] }
  const plan = C.planSnapshot(snapshot, { states: new Map([['k1', 'fix']]) })
  assert.equal(plan.sections[0].words[0].state, 'fix')
})
