/**
 * Agent-status store — Trae events in, one small snapshot out.
 *
 * The snapshot contract is identical to `trae-ide-ext/lib/state.js`
 * (`agents[] / events[] / primary / lastEventAt`), because the NEBULA renderer
 * and `media/nebula-core.js` consume it unchanged. Only the input differs: Trae
 * events come from the hub event cache instead of Harness event-bus hooks.
 *
 * Honesty rules baked in:
 *   - no `waiting`/`awaiting` phases (Trae exposes no approval signal);
 *   - tool durations come from observation timestamps, never fabricated;
 *   - silence is surfaced as `done`/`idle`, not as activity.
 */

const PHASE_LABELS = {
  idle: '空闲',
  thinking: '思考中',
  tool: '调用工具',
  done: '完成',
  failed: '失败',
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * @param {{ now?: () => number, doneHoldMs?: number, idleAfterMs?: number,
 *           maxEvents?: number, maxTimeline?: number }} [options]
 */
function createStore(options = {}) {
  const now = options.now ?? (() => Date.now())
  const doneHoldMs = options.doneHoldMs ?? 6000
  const idleAfterMs = options.idleAfterMs ?? 20000
  const maxEvents = options.maxEvents ?? 40
  const maxTimeline = options.maxTimeline ?? 40

  /** @type {Map<string, any>} */
  const agents = new Map()
  /** @type {Array<{ at: number, phase: string, text: string, agentId: string }>} */
  const events = []
  let eventSeq = 0
  let toolSeq = 0
  let lastEventAt = 0

  function newRecord(taskId, hubId, meta) {
    const at = now()
    const explicit = meta && meta.groupId ? String(meta.groupId) : ''
    return {
      id: String(taskId || 'task'),
      // `hubId` is the per-session directory under hub_event_cache/TraeCode/.
      // It is not a project id; it is the fallback grouping key when a task has
      // no chat metadata yet.
      hubId: String(hubId || ''),
      groupId: explicit || String(hubId || taskId || 'task'),
      // Local sources hand the store an explicit group (e.g. a workspace path)
      // together with a display label; the label is never invented here.
      groupLabel: meta && meta.groupLabel ? String(meta.groupLabel) : '',
      groupPinned: explicit !== '',
      sessionId: '',
      agentName: '',
      model: '',
      phase: 'idle',
      since: at,
      updatedAt: at,
      turn: 0,
      step: 0,
      turnStartedAt: /** @type {number|null} */ (null),
      turnEndedAt: /** @type {number|null} */ (null),
      toolCalls: 0,
      toolMs: 0,
      activeTool: /** @type {null | { name: string, detail: string, startedAt: number }} */ (null),
      usage: /** @type {null | { inputTokens: number, outputTokens: number }} */ (null),
      error: /** @type {null | string} */ (null),
      lastOutcome: /** @type {null | { phase: string, at: number }} */ (null),
      queuePosition: /** @type {number|null} */ (null),
      timeline: /** @type {Array<any>} */ ([]),
    }
  }

  function recordFor(taskId, hubId, meta) {
    const id = String(taskId || 'task')
    let record = agents.get(id)
    if (record === undefined) {
      record = newRecord(id, hubId, meta)
      agents.set(id, record)
    } else if (record.hubId === '' && hubId) {
      record.hubId = String(hubId)
      refreshGroup(record)
    }
    return record
  }

  /**
   * Group precedence: chat session id → hub directory id → task id.
   * Project/workspace attribution is NOT available in the cache, so we never
   * invent one. A source that does carry a real group (local workspace path)
   * pins it, and later metadata cannot overwrite it.
   */
  function refreshGroup(record) {
    if (record.groupPinned) return
    record.groupId = record.sessionId || record.hubId || record.id
  }

  function pushEvent(record, phase, text, at) {
    eventSeq += 1
    const stamp = Number(at) || now()
    events.push({ at: stamp, phase, text, agentId: record.id })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
    lastEventAt = Math.max(lastEventAt, stamp)
  }

  function setPhase(record, phase, at) {
    record.updatedAt = Number(at) || now()
    if (record.phase === phase) return false
    record.phase = phase
    record.since = record.updatedAt
    if (phase === 'done' || phase === 'failed') record.lastOutcome = { phase, at: record.since }
    if (phase === 'done' || phase === 'failed' || phase === 'idle') {
      record.activeTool = null
      record.queuePosition = null
    }
    return true
  }

  function activePhase(record) {
    return record.phase === 'thinking' || record.phase === 'tool'
  }

  const store = {
    /**
     * @param {{ at?: number, taskId: string, sessionId?: string, model?: string,
     *           turn?: number, agentName?: string }} event
     */
    sessionStart(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId, event)
      if (event.sessionId) record.sessionId = String(event.sessionId)
      if (event.agentName) record.agentName = String(event.agentName)
      refreshGroup(record)
      if (event.model) record.model = String(event.model)
      if (Number(event.turn) > 0) record.turn = Number(event.turn)
      record.error = null
      record.queuePosition = null
      // Turn clocks are observation-based: event timestamps can be days old
      // when the file is hydrated, and must not inflate "elapsed" on screen.
      record.turnStartedAt = record.turnStartedAt ?? now()
      record.turnEndedAt = null
      const fresh = record.toolCalls === 0 && record.timeline.length === 0
      setPhase(record, 'thinking', at)
      if (fresh) pushEvent(record, 'thinking', '任务开始', at)
      return
    },

    /** @param {{ at?: number, taskId: string, callId: string, name: string, detail?: string }} event */
    toolCall(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId)
      const callId = String(event.callId || `${event.name}-${toolSeq + 1}`)
      const existing = record.timeline.find((entry) => entry.callId === callId)
      if (existing !== undefined) {
        // Duplicate plan_item rows carry the same call id; only the first one is
        // the actual start. Later rows are result updates (handled below).
        return
      }
      toolSeq += 1
      record.toolCalls += 1
      record.step += 1
      record.activeTool = {
        name: String(event.name || 'tool'),
        detail: truncate(event.detail || '', 90),
        startedAt: at,
      }
      record.queuePosition = null
      record.error = null
      record.turnStartedAt = record.turnStartedAt ?? now()
      record.turnEndedAt = null
      record.timeline.push({
        id: toolSeq,
        callId,
        name: String(event.name || 'tool'),
        detail: truncate(event.detail || '', 90),
        status: 'running',
        startedAt: at,
        endedAt: null,
        result: '',
        turn: record.turn,
        step: record.step,
      })
      if (record.timeline.length > maxTimeline) {
        record.timeline.splice(0, record.timeline.length - maxTimeline)
      }
      setPhase(record, 'tool', at)
      const detail = truncate(event.detail || '', 90)
      pushEvent(record, 'tool', detail ? `${event.name} · ${detail}` : String(event.name || 'tool'), at)
    },

    /**
     * @param {{ at?: number, taskId: string, callId: string, ok: boolean,
     *           error?: string }} event
     */
    toolResult(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId)
      const entry = record.timeline.find((item) => item.callId === String(event.callId))
      if (entry === undefined) return
      if (entry.status !== 'running') return
      entry.status = event.ok ? 'ok' : 'error'
      entry.endedAt = at
      entry.result = event.ok ? '' : truncate(event.error || '工具报错', 80)
      if (record.activeTool !== null) {
        record.toolMs += Math.max(0, at - record.activeTool.startedAt)
        record.activeTool = null
      }
      if (!event.ok) record.error = truncate(event.error || '工具报错', 80)
      record.updatedAt = at
      setPhase(record, 'thinking', at)
      pushEvent(
        record,
        event.ok ? 'thinking' : 'failed',
        event.ok ? `${entry.name} 已返回` : `${entry.name} 报错：${truncate(event.error || '', 60)}`,
        at,
      )
    },

    /** @param {{ at?: number, taskId: string, inputTokens?: number, outputTokens?: number }} event */
    usage(event) {
      const record = recordFor(event.taskId, event.hubId)
      record.usage = {
        inputTokens: Number(event.inputTokens) || 0,
        outputTokens: Number(event.outputTokens) || 0,
      }
      record.updatedAt = Number(event.at) || now()
    },

    /** @param {{ at?: number, taskId: string, status: string, position?: number }} event */
    queue(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId)
      if (event.status === 'begin') {
        record.queuePosition = Number(event.position) || 0
        setPhase(record, 'thinking', at)
        pushEvent(record, 'thinking', `排队等待模型 · #${record.queuePosition}`, at)
        return
      }
      record.queuePosition = null
      record.updatedAt = at
    },

    /** @param {{ at?: number, taskId: string, text: string, phase?: string }} event */
    note(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId)
      setPhase(record, String(event.phase || 'thinking'), at)
      pushEvent(record, String(event.phase || 'thinking'), String(event.text || ''), at)
    },

    /** @param {{ at?: number, taskId: string, reason?: string }} event */
    turnEnd(event) {
      const at = Number(event.at) || now()
      const record = recordFor(event.taskId, event.hubId)
      record.turnEndedAt = at
      if (String(event.reason || 'completed') === 'failed') {
        setPhase(record, 'failed', at)
        pushEvent(record, 'failed', '任务失败', at)
      } else {
        setPhase(record, 'done', at)
        pushEvent(record, 'done', '本轮完成', at)
      }
    },

    /**
     * Close every still-active task. Used when a mock replay reaches EOF: the
     * replay is over, so leaving tasks "thinking" would misrepresent the data.
     * @param {string} [note]
     * @param {number} [at]
     */
    markAllDone(note = '回放结束 · 视为本轮结束', at = now()) {
      for (const record of agents.values()) {
        if (!activePhase(record)) continue
        setPhase(record, 'done', at)
        record.activeTool = null
        record.turnEndedAt = at
        pushEvent(record, 'done', note, at)
      }
    },

    /**
     * Transition a quiet active task to done. Called on a host timer so the
     * screen does not stay "running" forever after the JSONL stops appending.
     * @param {number} [at]
     */
    sweep(at = now()) {
      for (const record of agents.values()) {
        if (!activePhase(record)) continue
        if (at - record.updatedAt < idleAfterMs) continue
        setPhase(record, 'done', at)
        record.activeTool = null
        record.turnEndedAt = at
        pushEvent(record, 'done', `静默 ${Math.round(idleAfterMs / 1000)}s · 视为本轮结束`, at)
      }
    },

    /**
     * @param {{ group?: string | null }} [options] `group` narrows agents/events
     *   to one session; `sessions` always lists every group so the UI can switch.
     * @returns {any}
     */
    snapshot(options = {}) {
      const at = now()
      // Snapshot only shows 7 days, so older records are unreachable: drop
      // them here instead of letting the Map grow for the process lifetime.
      const cutoff = at - 7 * 86_400_000
      for (const [id, record] of agents) {
        if (record.updatedAt <= cutoff) agents.delete(id)
      }
      const list = [...agents.values()]
        // Seven days: old hub files are still useful history, and the renderer
        // needs a stable slot for each task.
        .filter((record) => record.updatedAt > cutoff)
        .map((record) => {
          const expired =
            (record.phase === 'done' || record.phase === 'failed') &&
            at - record.since > doneHoldMs
          const phase = expired ? 'idle' : record.phase
          let label = PHASE_LABELS[phase] || PHASE_LABELS.idle
          if (phase === 'tool' && record.activeTool !== null) {
            label = `${PHASE_LABELS.tool} · ${record.activeTool.name}`
          } else if (record.queuePosition !== null && phase === 'thinking') {
            label = `排队中 · #${record.queuePosition}`
          }
          return {
            id: record.id,
            sessionId: record.sessionId,
            groupId: record.groupId,
            groupLabel: record.groupLabel,
            hubId: record.hubId,
            agentName: record.agentName,
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
            streamFrames: 0,
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
            awaitingInput: false,
            timeline: record.timeline
              .slice(-20)
              .reverse()
              .map((entry) => {
                const liveEntry = record.phase === 'tool' || record.phase === 'thinking'
                const end = entry.endedAt ?? (liveEntry ? at : entry.startedAt)
                return {
                  id: entry.id,
                  callId: entry.callId,
                  name: entry.name,
                  detail: entry.detail,
                  status: entry.status,
                  startedAt: entry.startedAt,
                  endedAt: entry.endedAt,
                  durationMs: Math.max(0, end - entry.startedAt),
                  result: entry.result,
                  turn: entry.turn,
                  step: entry.step,
                }
              }),
          }
        })
        .sort((a, b) => {
          const aActive = a.phase !== 'idle' ? 0 : 1
          const bActive = b.phase !== 'idle' ? 0 : 1
          if (aActive !== bActive) return aActive - bActive
          return b.updatedAt - a.updatedAt
        })

      const group =
        options.group === undefined || options.group === null || options.group === ''
          ? null
          : String(options.group)

      // Session summaries are always computed from the full list, so switching
      // the filter does not lose the parallel sessions.
      const sessions = []
      const byGroup = new Map()
      for (const agent of list) {
        let entry = byGroup.get(agent.groupId)
        if (entry === undefined) {
          entry = {
            id: agent.groupId,
            hubId: agent.hubId,
            sessionId: agent.sessionId,
            label: agent.groupLabel || '',
            agentName: '',
            agentCount: 0,
            activeCount: 0,
            toolCalls: 0,
            lastSeen: 0,
            phase: 'idle',
          }
          byGroup.set(agent.groupId, entry)
          sessions.push(entry)
        }
        entry.agentCount += 1
        if (agent.phase !== 'idle') entry.activeCount += 1
        entry.toolCalls += Number(agent.toolCalls) || 0
        if (agent.agentName && entry.agentName === '') entry.agentName = agent.agentName
        if (agent.updatedAt > entry.lastSeen) {
          entry.lastSeen = agent.updatedAt
          entry.phase = agent.phase
        }
      }
      sessions.sort((a, b) => b.activeCount - a.activeCount || b.lastSeen - a.lastSeen)

      const visible = group === null ? list : list.filter((agent) => agent.groupId === group)
      const groupById = new Map(list.map((agent) => [agent.id, agent.groupId]))
      const latest = events
        .filter((event) => group === null || groupById.get(event.agentId) === group)
        .slice(-12)
        .reverse()
        .map((event) => ({ ...event, groupId: groupById.get(event.agentId) || '' }))

      const computedLast = visible.reduce(
        (max, agent) => Math.max(max, agent.updatedAt, agent.lastOutcome?.at ?? 0),
        0,
      )
      return {
        version: 1,
        at,
        lastEventAt: Math.max(lastEventAt, computedLast) || null,
        primary: visible[0]?.id ?? null,
        agents: visible,
        sessions,
        filter: { group },
        events: latest,
      }
    },

    size() {
      return agents.size
    },

    reset() {
      agents.clear()
      events.length = 0
      lastEventAt = 0
    },
  }

  return store
}

module.exports = { createStore, PHASE_LABELS }
