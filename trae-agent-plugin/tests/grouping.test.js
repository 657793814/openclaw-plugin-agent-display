const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createHubCacheSource } = require('../lib/hub-cache')
const { createStore } = require('../lib/store')

function metadataRow({ taskId, sessionId, agentName = 'solo_agent', at }) {
  return JSON.stringify({
    task_id: taskId,
    seq: 1,
    type: 'metadata',
    data: JSON.stringify({
      session_id: sessionId,
      message_index: 1,
      agent_name: agentName,
      created_at: at,
    }),
  })
}

function planRow({ taskId, seq = 1, id = 'pi_1', name = 'Edit', at }) {
  return JSON.stringify({
    task_id: taskId,
    seq,
    type: 'plan_item',
    data: JSON.stringify({
      id,
      task_id: taskId,
      timing: { generated_at_ms: at },
      tool_call_info: { id, name, params: { file_path: '/src/App.ts' }, result: {} },
      agent_id: 'solo_agent',
      agent_status: { status: 'running', run_mode: 'foreground' },
    }),
  })
}

function feed(store) {
  return (event) => {
    switch (event.kind) {
      case 'session.start':
        return store.sessionStart(event)
      case 'tool.call':
        return store.toolCall(event)
      case 'tool.result':
        return store.toolResult(event)
      case 'usage':
        return store.usage(event)
      case 'queue':
        return store.queue(event)
      case 'note':
        return store.note(event)
      case 'turn.end':
        return store.turnEnd(event)
      default:
        return undefined
    }
  }
}

function fixture(hubs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-groups-'))
  const cache = path.join(root, 'TraeCode')
  for (const [hubId, rows] of Object.entries(hubs)) {
    const dir = path.join(cache, hubId)
    fs.mkdirSync(dir, { recursive: true })
    for (const [index, row] of rows.entries()) {
      fs.writeFileSync(path.join(dir, `m${index}.jsonl`), `${row}\n`)
    }
  }
  return cache
}

test('two hub directories stay two groups and every event carries hubId', () => {
  const at = Date.now() - 1000
  const cache = fixture({
    'hub-a': [metadataRow({ taskId: 'task-a', sessionId: 'sess-a', at }), planRow({ taskId: 'task-a', at })],
    'hub-b': [metadataRow({ taskId: 'task-b', sessionId: 'sess-b', at }), planRow({ taskId: 'task-b', id: 'pi_2', at })],
  })

  const store = createStore({})
  const source = createHubCacheSource({ root: cache, onEvent: feed(store) })
  source.scan()
  source.stop()

  const snapshot = store.snapshot()
  assert.equal(snapshot.agents.length, 2)
  assert.equal(snapshot.sessions.length, 2)
  assert.deepEqual(
    snapshot.sessions.map((session) => session.id).sort(),
    ['sess-a', 'sess-b'],
  )

  const groupA = snapshot.agents.find((agent) => agent.id === 'task-a')
  assert.equal(groupA.groupId, 'sess-a')
  assert.equal(groupA.hubId, 'hub-a')
  assert.equal(snapshot.events.every((event) => typeof event.groupId === 'string'), true)
  assert.equal(snapshot.events.filter((event) => event.groupId === 'sess-a').length > 0, true)
  assert.equal(snapshot.events.filter((event) => event.groupId === 'sess-b').length > 0, true)

  const onlyB = store.snapshot({ group: 'sess-b' })
  assert.equal(onlyB.agents.length, 1)
  assert.equal(onlyB.agents[0].id, 'task-b')
  assert.equal(onlyB.events.every((event) => event.groupId === 'sess-b'), true)
  assert.equal(onlyB.primary, 'task-b')
  // The unfiltered session list must survive filtering so the UI can switch.
  assert.equal(onlyB.sessions.length, 2)
})

test('without chat metadata the hub directory id is the fallback group', () => {
  const at = Date.now() - 1000
  const cache = fixture({
    'hub-only': [planRow({ taskId: 'task-x', at })],
  })

  const store = createStore({})
  const source = createHubCacheSource({ root: cache, onEvent: feed(store) })
  source.scan()
  source.stop()

  const snapshot = store.snapshot()
  assert.equal(snapshot.agents.length, 1)
  assert.equal(snapshot.agents[0].groupId, 'hub-only')
  assert.equal(snapshot.sessions[0].id, 'hub-only')
  assert.equal(snapshot.sessions[0].sessionId, '')
})

test('task ids never merge into one timeline across sessions', () => {
  const at = Date.now() - 1000
  const cache = fixture({
    'hub-a': [metadataRow({ taskId: 'task-a', sessionId: 'sess-a', at }), planRow({ taskId: 'task-a', seq: 1, at })],
    'hub-b': [metadataRow({ taskId: 'task-b', sessionId: 'sess-b', at }), planRow({ taskId: 'task-b', seq: 1, id: 'pi_2', at })],
  })

  const store = createStore({})
  const source = createHubCacheSource({ root: cache, onEvent: feed(store) })
  source.scan()
  source.stop()

  const snapshot = store.snapshot()
  const a = snapshot.agents.find((agent) => agent.id === 'task-a')
  const b = snapshot.agents.find((agent) => agent.id === 'task-b')
  assert.equal(a.timeline.length, 1)
  assert.equal(b.timeline.length, 1)
  assert.equal(a.timeline[0].callId !== b.timeline[0].callId, true)
})
