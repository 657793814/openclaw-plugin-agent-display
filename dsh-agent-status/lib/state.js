/**
 * DSH agent-status store — turns cordis/agent events into one small snapshot.
 *
 * Pure and host-free: `apply(ctx)` feeds it, tests feed it directly, and the
 * HTTP layer only serializes `snapshot()`. No module-level state.
 */

/** @typedef {'idle'|'thinking'|'tool'|'waiting'|'awaiting'|'done'|'failed'} Phase */

const DEFAULT_TOOL_DETAIL_KEYS = [
  'description',
  'command',
  'file_path',
  'path',
  'query',
  'url',
  'pattern',
  'name',
]

function truncate(value, max) {
  const text = String(value).replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function errorText(error) {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const record = /** @type {Record<string, unknown>} */ (error)
    if (typeof record.message === 'string') return record.message
    if (typeof record.code === 'string') return record.code
  }
  return 'unknown error'
}

/**
 * Short, body-free summary of a tool result. Never returns raw arguments or
 * full tool output — the screen only needs a one-line hint.
 * @param {any} data tool/result payload
 * @returns {string}
 */
function resultSummary(data) {
  if (data?.error) return truncate(errorText(data.error), 80)
  const raw = data?.result ?? data?.output ?? data?.content
  if (typeof raw === 'string') return truncate(raw, 80)
  if (typeof raw === 'object' && raw !== null) {
    const record = /** @type {Record<string, unknown>} */ (raw)
    for (const key of ['summary', 'message', 'text', 'content']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return truncate(value, 80)
    }
    if (Array.isArray(record)) return ''
  }
  return ''
}

/**
 * Show what a tool is doing without dumping raw arguments.
 * @param {unknown} raw
 * @returns {string}
 */
function toolDetail(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return truncate(raw, 90)
  }
  if (typeof parsed !== 'object' || parsed === null) return truncate(raw, 90)
  for (const key of DEFAULT_TOOL_DETAIL_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (parsed)[key]
    if (typeof value === 'string' && value.trim() !== '') return truncate(value, 90)
  }
  return ''
}

const PHASE_LABELS = {
  idle: '空闲',
  thinking: '思考中',
  tool: '调用工具',
  waiting: '等待确认',
  awaiting: '等待输入',
  done: '完成',
  failed: '失败',
}

/**
 * @param {{ now?: () => number, doneHoldMs?: number, maxEvents?: number }} [options]
 */
export function createStore(options = {}) {
  const now = options.now ?? (() => Date.now())
  const doneHoldMs = options.doneHoldMs ?? 6000
  const maxEvents = options.maxEvents ?? 40
  const maxTimeline = options.maxTimeline ?? 40

  /** @type {Map<string, ReturnType<typeof newRecord>>} */
  const agents = new Map()
  /** @type {Array<{ at: number, phase: Phase, text: string, agentId: string }>} */
  const events = []
  let eventSeq = 0
  let toolSeq = 0

  function newRecord(agent) {
    return {
      id: String(agent?.id ?? 'agent'),
      sessionId: String(agent?.session?.id ?? ''),
      model: '',
      phase: /** @type {Phase} */ ('idle'),
      since: now(),
      updatedAt: now(),
      turn: 0,
      step: 0,
      turnStartedAt: /** @type {number|null} */ (null),
      turnEndedAt: /** @type {number|null} */ (null),
      toolCalls: 0,
      toolMs: 0,
      streamFrames: 0,
      activeTool: /** @type {null | { name: string, detail: string, startedAt: number }} */ (null),
      usage: /** @type {null | { inputTokens: number, outputTokens: number }} */ (null),
      error: /** @type {null | string} */ (null),
      lastOutcome: /** @type {null | { phase: Phase, at: number }} */ (null),
      awaiting: '',
      // True after a turn ends normally and the user has not sent anything new.
      awaitingInput: false,
      // Recent tool calls for the big screen: summaries only, no raw payloads.
      timeline: /** @type {Array<{ id: number, callId: string, name: string, detail: string, status: 'running'|'ok'|'error', startedAt: number, endedAt: number|null, result: string, turn: number, step: number }>} */ ([]),
    }
  }

  function pushEvent(record, phase, text) {
    eventSeq += 1
    events.push({ at: now(), phase, text, agentId: record.id })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  function recordFor(agent) {
    const id = String(agent?.id ?? 'agent')
    let record = agents.get(id)
    if (record === undefined) {
      record = newRecord(agent)
      agents.set(id, record)
    }
    if (record.sessionId === '' && agent?.session?.id) record.sessionId = String(agent.session.id)
    return record
  }

  function recordForSession(session) {
    const sessionId = String(session?.id ?? '')
    for (const record of agents.values()) {
      if (record.sessionId === sessionId && sessionId !== '') return record
    }
    return recordFor({ id: sessionId === '' ? 'session' : sessionId, session })
  }

  /**
   * Move to a phase; returns true when the phase actually changed.
   * @param {ReturnType<typeof newRecord>} record
   * @param {Phase} phase
   */
  function setPhase(record, phase) {
    record.updatedAt = now()
    if (record.phase === phase) return false
    record.phase = phase
    record.since = record.updatedAt
    if (phase === 'done' || phase === 'failed') record.lastOutcome = { phase, at: record.since }
    if (phase === 'done' || phase === 'failed' || phase === 'idle') {
      record.activeTool = null
      record.awaiting = ''
    }
    return true
  }

  function finishTool(record, outcome) {
    if (record.activeTool !== null) {
      record.toolMs += now() - record.activeTool.startedAt
      record.activeTool = null
    }
    pushEvent(record, 'thinking', outcome)
  }

  const store = {
    /** @param {{ agent: any }} payload */
    agentCreated({ agent }) {
      const record = recordFor(agent)
      record.awaitingInput = false
      setPhase(record, 'idle')
      pushEvent(record, 'idle', 'Agent 已就绪')
    },

    /** @param {{ agent: any }} payload */
    agentDisposed({ agent }) {
      const record = agents.get(String(agent?.id ?? 'agent'))
      if (record === undefined) return
      record.awaitingInput = false
      setPhase(record, 'idle')
      record.sessionId = ''
      pushEvent(record, 'idle', 'Agent 已释放')
    },

    /** @param {{ agent: any, status: 'idle'|'running' }} payload */
    agentStatus({ agent, status }) {
      const record = recordFor(agent)
      if (status === 'running') {
        record.awaitingInput = false
        setPhase(record, record.phase === 'tool' ? 'tool' : 'thinking')
        record.updatedAt = now()
        return
      }
      const hold =
        record.lastOutcome !== null && now() - record.lastOutcome.at < doneHoldMs
      setPhase(record, hold ? record.lastOutcome.phase : 'idle')
    },

    /** @param {{ agent: any, error: unknown }} payload */
    agentError({ agent, error }) {
      const record = recordFor(agent)
      record.error = errorText(error)
      record.awaitingInput = false
      setPhase(record, 'failed')
      pushEvent(record, 'failed', `出错了：${truncate(record.error, 80)}`)
    },

    /** @param {{ agent: any, frame: any }} payload */
    assistantStream({ agent, frame }) {
      const record = recordFor(agent)
      record.streamFrames += 1
      if (frame?.type === 'start') {
        record.awaitingInput = false
        setPhase(record, 'thinking')
        record.awaiting = ''
      }
      if (frame?.type === 'end' && frame?.outcome?.kind === 'abandoned') {
        pushEvent(record, 'thinking', '流已中断')
      }
    },

    /**
     * `session/event` carries every durable log fact, including tool calls,
     * approvals and turn boundaries.
     * @param {any} session
     * @param {any} event
     */
    sessionEvent(session, event) {
      if (!event || typeof event.type !== 'string') return
      const record = recordForSession(session)
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          record.turn = Number(data.turn ?? record.turn)
          record.step = 0
          record.turnStartedAt = now()
          record.turnEndedAt = null
          record.error = null
          record.awaitingInput = false
          setPhase(record, 'thinking')
          pushEvent(record, 'thinking', `第 ${record.turn} 轮开始`)
          return
        case 'step/start':
          record.turn = Number(data.turn ?? record.turn)
          record.step = Number(data.step ?? record.step)
          record.awaitingInput = false
          setPhase(record, 'thinking')
          pushEvent(record, 'thinking', `步骤 ${record.step} 开始`)
          return
        case 'step/end':
          record.step = Number(data.step ?? record.step)
          setPhase(record, 'thinking')
          return
        case 'request/header': {
          const config = data.header?.config
          if (typeof config?.model === 'string') {
            record.model = config.provider
              ? `${config.provider}/${config.model}`
              : config.model
          }
          return
        }
        case 'tool/call': {
          const name = String(data.name ?? 'tool')
          const detail = toolDetail(data.arguments)
          const callId = String(data.callId ?? `${name}-${toolSeq + 1}`)
          const startedAt = now()
          record.toolCalls += 1
          record.activeTool = { name, detail, startedAt }
          record.turn = Number(data.turn ?? record.turn)
          record.step = Number(data.step ?? record.step)
          toolSeq += 1
          record.timeline.push({
            id: toolSeq,
            callId,
            name,
            detail,
            status: 'running',
            startedAt,
            endedAt: null,
            result: '',
            turn: record.turn,
            step: record.step,
          })
          if (record.timeline.length > maxTimeline) {
            record.timeline.splice(0, record.timeline.length - maxTimeline)
          }
          setPhase(record, 'tool')
          pushEvent(record, 'tool', detail ? `${name} · ${detail}` : name)
          return
        }
        case 'tool/result': {
          const summary = resultSummary(data)
          let entry = null
          if (data.callId !== undefined) {
            for (let index = record.timeline.length - 1; index >= 0; index -= 1) {
              const candidate = record.timeline[index]
              if (candidate.status === 'running' && candidate.callId === String(data.callId)) {
                entry = candidate
                break
              }
            }
          }
          if (entry === null) {
            for (let index = record.timeline.length - 1; index >= 0; index -= 1) {
              if (record.timeline[index].status === 'running') {
                entry = record.timeline[index]
                break
              }
            }
          }
          if (entry !== null) {
            entry.status = data.error ? 'error' : 'ok'
            entry.endedAt = now()
            entry.result = summary
          }
          const name = record.activeTool?.name ?? ''
          if (data.error) {
            finishTool(record, `${name || '工具'} 报错：${truncate(errorText(data.error), 60)}`)
          } else {
            finishTool(record, `${name || '工具'} 已返回`)
          }
          setPhase(record, 'thinking')
          return
        }
        case 'assistant/message': {
          const usage = data.usage
          if (usage && Number.isFinite(usage.inputTokens)) {
            const prev = record.usage
            record.usage = {
              inputTokens: (prev?.inputTokens ?? 0) + Number(usage.inputTokens ?? 0),
              outputTokens: (prev?.outputTokens ?? 0) + Number(usage.outputTokens ?? 0),
            }
          }
          return
        }
        case 'approval/asked':
          record.awaiting = `确认 ${String(data.toolName ?? '操作')}`
          record.awaitingInput = false
          setPhase(record, 'waiting')
          pushEvent(record, 'waiting', `等待确认 · ${String(data.toolName ?? '操作')}`)
          return
        case 'approval/decided':
          record.awaiting = ''
          record.awaitingInput = false
          setPhase(record, 'thinking')
          pushEvent(record, 'thinking', '确认已处理')
          return
        case 'llm/retry':
          setPhase(record, 'thinking')
          pushEvent(record, 'thinking', '模型请求重试')
          return
        case 'compaction/start':
          setPhase(record, 'thinking')
          pushEvent(record, 'thinking', '压缩上下文')
          return
        case 'user/message':
          if (data.source?.kind === 'user') {
            record.awaitingInput = false
            setPhase(record, 'thinking')
            record.error = null
            pushEvent(record, 'thinking', '收到用户消息')
          }
          return
        case 'turn/end': {
          record.turnEndedAt = now()
          const kind = String(data.reason?.kind ?? 'completed')
          if (kind === 'completed') {
            record.awaitingInput = true
            setPhase(record, 'done')
            pushEvent(record, 'done', `第 ${record.turn} 轮完成`)
          } else if (kind === 'error') {
            record.awaitingInput = false
            record.error = errorText(data.reason?.error)
            setPhase(record, 'failed')
            pushEvent(record, 'failed', `第 ${record.turn} 轮失败`)
          } else {
            // aborted / interrupted / blocked / forked / max-tokens: the turn is
            // over but the session stays open, so the user can send more input.
            record.awaitingInput = kind !== 'forked'
            setPhase(record, kind === 'max-tokens' ? 'done' : 'idle')
            pushEvent(record, kind === 'max-tokens' ? 'done' : 'idle', `轮次结束：${kind}`)
          }
          return
        }
        default:
          return
      }
    },

    /** @returns {Record<string, any>} */
    snapshot() {
      const at = now()
      const list = [...agents.values()]
        .filter((record) => record.sessionId !== '' || record.updatedAt > at - 86_400_000)
        .map((record) => {
          const expired =
            (record.phase === 'done' || record.phase === 'failed') &&
            at - record.since > doneHoldMs
          let phase = expired ? 'idle' : record.phase
          // A finished turn with no follow-up means the agent is waiting for the
          // user. `turn/end` is the strongest signal the host gives us; there is
          // no dedicated "awaiting user input" event.
          if (phase === 'idle' && record.awaitingInput && record.sessionId !== '') {
            phase = 'awaiting'
          }
          const label =
            phase === 'tool' && record.activeTool !== null
              ? `${PHASE_LABELS.tool} · ${record.activeTool.name}`
              : phase === 'waiting' && record.awaiting !== ''
                ? `${PHASE_LABELS.waiting} · ${record.awaiting}`
                : PHASE_LABELS[phase]
          return {
            id: record.id,
            sessionId: record.sessionId,
            model: record.model,
            phase,
            label,
            since: record.since,
            updatedAt: record.updatedAt,
            elapsedMs: Math.max(0, at - record.since),
            turnStartedAt: record.turnStartedAt,
            turnEndedAt: record.turnEndedAt,
            turnElapsedMs:
              record.turnStartedAt === null
                ? 0
                : Math.max(0, (record.turnEndedAt ?? at) - record.turnStartedAt),
            turn: record.turn,
            step: record.step,
            toolCalls: record.toolCalls,
            toolMs: record.toolMs,
            streamFrames: record.streamFrames,
            activeTool:
              record.activeTool === null
                ? null
                : {
                    name: record.activeTool.name,
                    detail: record.activeTool.detail,
                    elapsedMs: Math.max(0, at - record.activeTool.startedAt),
                  },
            usage: record.usage,
            error: record.error,
            lastOutcome: record.lastOutcome,
            awaitingInput: record.awaitingInput,
            timeline: record.timeline
              .slice(-20)
              .reverse()
              .map((entry) => ({
                id: entry.id,
                callId: entry.callId,
                name: entry.name,
                detail: entry.detail,
                status: entry.status,
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                durationMs: Math.max(0, (entry.endedAt ?? at) - entry.startedAt),
                result: entry.result,
                turn: entry.turn,
                step: entry.step,
              })),
          }
        })
        .sort((a, b) => {
          const aActive = a.phase !== 'idle' ? 0 : 1
          const bActive = b.phase !== 'idle' ? 0 : 1
          if (aActive !== bActive) return aActive - bActive
          return b.updatedAt - a.updatedAt
        })

      const latest = events.slice(-12).reverse()
      const lastEventAt = list.reduce(
        (max, agent) => Math.max(max, agent.updatedAt, agent.lastOutcome?.at ?? 0),
        0,
      )
      return {
        version: 1,
        at,
        lastEventAt: lastEventAt || null,
        primary: list[0]?.id ?? null,
        agents: list,
        events: latest,
      }
    },

    /** Test/debug introspection without cloning. */
    size() {
      return agents.size
    },
  }

  return store
}

export { PHASE_LABELS, toolDetail }
