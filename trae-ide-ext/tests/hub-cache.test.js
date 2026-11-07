const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { parseLine, createHubCacheSource } = require('../lib/hub-cache')

function planRow({ seq = 1, taskId = 'task-a', id = 'pi_1', name = 'Edit', params = {}, result = {} }) {
  return JSON.stringify({
    task_id: taskId,
    seq,
    type: 'plan_item',
    data: JSON.stringify({
      id,
      task_id: taskId,
      reasoning_content: 'PRIVATE-REASONING',
      thought: 'PRIVATE-THOUGHT',
      timing: { generated_at_ms: 1793860597340 },
      tool_call_info: { id, name, params, result },
      agent_id: 'solo_agent',
      agent_status: { status: 'running', run_mode: 'foreground' },
    }),
  })
}

test('plan_item without result emits only a tool.call', () => {
  const events = parseLine(planRow({}), { observedAt: 1000 })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'tool.call')
  assert.equal(events[0].name, 'Edit')
  assert.equal(events[0].detail, '')
  assert.equal(events[0].at, 1793860597340)
})

test('duplicate rows: result is emitted once, start only once', () => {
  const seenResults = new Set()
  const seenCalls = new Set()
  const seenLines = new Set()
  const first = parseLine(planRow({ seq: 1, params: { file_path: '/src/TagService.java' } }), {
    observedAt: 1000,
    seenResults,
    seenCalls,
    seenLines,
  })
  const second = parseLine(
    planRow({
      seq: 2,
      params: { file_path: '/src/TagService.java' },
      result: { status: 'success', error_message: '' },
    }),
    { observedAt: 1000, seenResults, seenCalls, seenLines },
  )
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'tool.call')
  assert.equal(second.length, 1)
  assert.equal(second[0].kind, 'tool.result')
  assert.equal(second[0].ok, true)

  const third = parseLine(
    planRow({
      seq: 3,
      params: { file_path: '/src/TagService.java' },
      result: { status: 'success', error_message: '' },
    }),
    { observedAt: 1000, seenResults, seenCalls, seenLines },
  )
  assert.deepEqual(third, [])
})

test('failed tool result carries a truncated error', () => {
  const events = parseLine(
    planRow({
      result: { status: 'failed', error_message: 'boom '.repeat(40) },
    }),
    { observedAt: 2000, live: true },
  )
  const result = events.find((event) => event.kind === 'tool.result')
  assert.equal(result.ok, false)
  assert.ok(result.error.length <= 80)
})

test('privacy: reasoning, thought and diff bodies never leave the parser', () => {
  const line = planRow({
    name: 'Edit',
    params: { file_path: '/secret/src/Foo.ts', old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' },
    result: { status: 'success', changes: [{ old_content: 'SECRET-OLD', new_content: 'SECRET-NEW' }] },
  })
  const serialized = JSON.stringify(parseLine(line, { observedAt: 1, live: true }))
  assert.equal(serialized.includes('PRIVATE-REASONING'), false)
  assert.equal(serialized.includes('PRIVATE-THOUGHT'), false)
  assert.equal(serialized.includes('SECRET-OLD'), false)
  assert.equal(serialized.includes('SECRET-NEW'), false)
  assert.equal(serialized.includes('Foo.ts'), true)
})

test('Shell uses the description, never the raw command', () => {
  const events = parseLine(
    planRow({
      name: 'Shell',
      params: { command: 'rm -rf SECRET-COMMAND', cwd: '/work/agent-display', description: '运行测试' },
    }),
    { observedAt: 1 },
  )
  assert.equal(events[0].detail, '运行测试')
  assert.equal(JSON.stringify(events).includes('SECRET-COMMAND'), false)
})

test('conversation rows never produce events (no chat text on the big screen)', () => {
  for (const type of ['user_message', 'append_input', 'context_usage', 'timing_events', 'notification']) {
    const line = JSON.stringify({
      task_id: 'task-1',
      seq: 9,
      type,
      data: JSON.stringify({ content: 'PRIVATE-CHAT-TEXT', message: 'PRIVATE-CHAT-TEXT' }),
    })
    assert.deepEqual(parseLine(line, { observedAt: 1 }), [], `${type} must stay invisible`)
  }
})

test('Read detail is basename + line range', () => {
  const events = parseLine(
    planRow({ name: 'Read', params: { file_path: '/a/b/Store.ts', offset: 9, limit: 20 } }),
    { observedAt: 1 },
  )
  assert.equal(events[0].detail, 'Store.ts:10-29')
})

test('bad JSON lines and unknown types are ignored', () => {
  assert.deepEqual(parseLine('{not json', {}), [])
  assert.deepEqual(parseLine(JSON.stringify({ task_id: 't', seq: 1, type: 'user_message', data: '{"content":"PRIVATE"}' }), {}), [])
  assert.deepEqual(parseLine(JSON.stringify({ task_id: 't', seq: 2, type: 'timing_events', data: '{}' }), {}), [])
})

test('token_usage and queuing map to usage/queue events', () => {
  const usage = parseLine(
    JSON.stringify({
      task_id: 't',
      seq: 5,
      type: 'token_usage',
      data: JSON.stringify({ prompt_tokens: 120, completion_tokens: 30 }),
    }),
    { observedAt: 7 },
  )
  assert.equal(usage[0].kind, 'usage')
  assert.equal(usage[0].inputTokens, 120)
  assert.equal(usage[0].outputTokens, 30)

  const queue = parseLine(
    JSON.stringify({
      task_id: 't',
      seq: 6,
      type: 'queuing',
      data: JSON.stringify({ queue_status: 'begin', position: 2 }),
    }),
    { observedAt: 8 },
  )
  assert.equal(queue[0].kind, 'queue')
  assert.equal(queue[0].status, 'begin')
  assert.equal(queue[0].position, 2)
})

test('out-of-order seq: no ordering assumption, duplicates deduped', () => {
  const seenResults = new Set()
  const seenCalls = new Set()
  const seenLines = new Set()
  const late = parseLine(planRow({ seq: 9, id: 'pi_x', result: { status: 'success' } }), {
    observedAt: 100,
    seenResults,
    seenCalls,
    seenLines,
  })
  const early = parseLine(planRow({ seq: 4, id: 'pi_x' }), {
    observedAt: 100,
    seenResults,
    seenCalls,
    seenLines,
  })
  assert.equal(late.length, 2)
  assert.equal(late[0].kind, 'tool.call')
  assert.equal(late[1].kind, 'tool.result')
  // A late duplicate start row is suppressed; seq order is never assumed.
  assert.deepEqual(early, [])
})

test('tail source: half lines stay unread until the newline arrives', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cache-'))
  const hubDir = path.join(root, 'TraeCode', 'hub-1')
  fs.mkdirSync(hubDir, { recursive: true })
  const file = path.join(hubDir, 'm1.jsonl')

  const events = []
  const statuses = []
  const source = createHubCacheSource({
    root: path.join(root, 'TraeCode'),
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
  })

  const row = planRow({ seq: 1, id: 'pi_half', params: { file_path: '/a/B.ts' } })
  fs.writeFileSync(file, row.slice(0, 40))
  source.scan()
  assert.equal(events.length, 0)

  fs.appendFileSync(file, `${row.slice(40)}\n`)
  source.scan()
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'tool.call')
  assert.equal(statuses.at(-1).state, 'live')

  fs.appendFileSync(
    file,
    `${planRow({ seq: 2, id: 'pi_half', params: { file_path: '/a/B.ts' }, result: { status: 'success' } })}\n`,
  )
  source.scan()
  assert.equal(events.length, 2)
  assert.equal(events[1].kind, 'tool.result')
  source.stop()
})

test('real hub cache (when present) yields real tool names', () => {
  const osHome = os.homedir()
  const root = path.join(osHome, '.trae-cn', 'hub_event_cache', 'TraeCode')
  if (!fs.existsSync(root)) {
    test.skip('no hub cache on this machine')
    return
  }
  const events = []
  const source = createHubCacheSource({ root, onEvent: (event) => events.push(event) })
  source.scan()
  source.stop()
  if (events.length === 0) {
    test.skip('hub cache is empty')
    return
  }
  const names = events.filter((event) => event.kind === 'tool.call').map((event) => event.name)
  assert.ok(names.length > 0)
  const hasKnown = ['Read', 'Edit', 'Grep', 'Shell'].some((name) => names.includes(name))
  assert.equal(hasKnown, true)
  // File tools only ever expose basenames; no absolute path may appear.
  for (const event of events) {
    if (event.kind !== 'tool.call') continue
    assert.equal(String(event.detail).includes('/Users/'), false)
    if (['Read', 'Edit', 'Grep', 'Write'].includes(event.name)) {
      assert.equal(String(event.detail).includes('/'), false)
    }
  }
})
