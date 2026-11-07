/**
 * NEBULA「星核蜘蛛」— real-data adapter (pure, no DOM/WebGL).
 *
 * The renderer in `runtime/nebula/theme.js` is the original theme code from
 * agent-display/index.html, copied verbatim. Only its simulation engine was
 * removed. This module converts the Harness snapshot (agents, phases, tool
 * calls/results, errors, session events) into the exact data structures the
 * renderer expects:
 *
 *   AG[0] 星核 = Harness host (not an agent)
 *   AG[1..12]  = real agents, stable slot per agent id, missing slots neutral
 *   task.sections[].words[] = real tool calls of that agent (status → state)
 *   logs / code panel        = real session events
 *
 * Missing fields stay empty; nothing is synthesised. The only derived values
 * are the success-rate gauge and the "all tools finished → ship" phase, both
 * computed from real counts.
 */

;(() => {
  const TAU = Math.PI * 2

  // Colours come from the original theme palette (index.html :host vars).
  const PHASE_TINT = {
    idle: '#9fd4ff',
    thinking: '#62e3ff',
    tool: '#ff6fae',
    waiting: '#ffd27a',
    awaiting: '#ffd27a',
    done: '#6ff0c0',
    failed: '#ff6b8b',
  }

  // Nebula brightness per phase. Empty slots sit near zero.
  const PHASE_LOAD = {
    idle: 0.14,
    thinking: 0.58,
    tool: 0.94,
    waiting: 0.38,
    awaiting: 0.44,
    done: 0.70,
    failed: 0.66,
  }

  const PHASE_CJK = {
    idle: '空闲',
    thinking: '思考中',
    tool: '调用工具',
    waiting: '等待确认',
    awaiting: '等待输入',
    done: '完成',
    failed: '失败',
  }

  const PHASE_VERB = {
    idle: 'load',
    thinking: 'read',
    tool: 'crawl',
    waiting: 'ask',
    awaiting: 'ask',
    done: 'fix',
    failed: 'flag',
  }

  const WORD_CAP = 14 // CL[k].words has exactly 14 layout slots
  const MAX_SLOTS = 12
  const EMPTY_TINT = '#5f6d8a'

  const tint = (phase) => PHASE_TINT[phase] || PHASE_TINT.idle
  const loadOf = (phase) => (PHASE_LOAD[phase] === undefined ? 0.12 : PHASE_LOAD[phase])
  const cjkPhase = (phase) => PHASE_CJK[phase] || PHASE_CJK.idle
  const verbOf = (phase) => PHASE_VERB[phase] || 'load'

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

  function truncate(text, max) {
    const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
    return value.length > max ? `${value.slice(0, max - 1)}…` : value
  }

  /**
   * Slot key from the real agent id (`sess-xxxx` → `XXXX`). The host `label`
   * is a phase string ("调用工具 · bash"), so it can never be an identity.
   */
  function shortLabel(agent) {
    const raw = String(agent?.id || 'agent').trim()
    const segs = raw.split(/[\s_·/-]+/u).filter(Boolean)
    let tail = segs[segs.length - 1] || raw
    // 真实 id 常见「main-agent / scout-agent」这种通用后缀：直接取末段会让所有
    // agent 都叫 AGENT。遇到通用词就回退到前一段，保证标签可区分。
    if (/^(agent|main|worker|bot)$/i.test(tail) && segs.length > 1) tail = segs.slice(0, -1).join('-')
    return truncate(tail, 7).toUpperCase()
  }

  /** Chinese descriptor = the host's live phase label (real text). */
  function cjkLabel(agent) {
    const raw = String(agent?.label || '').trim()
    return raw === '' ? cjkPhase(agent?.phase) : truncate(raw, 12)
  }

  /**
   * Assign each real agent a cloud slot (1..12). Slots are sticky per agent id
   * so a cloud never teleports between agents. New agents take the first free
   * slot; agents beyond 12 are ignored (the theme has 12 clouds).
   * @param {Array<any>} agents
   * @param {Map<string, number>} [previous]
   */
  function assignSlots(agents, previous) {
    const prev = previous instanceof Map ? previous : new Map()
    const list = Array.isArray(agents) ? agents : []
    const slots = new Array(MAX_SLOTS + 1).fill(null)
    const map = new Map()
    const used = new Set()
    const pending = []

    for (const agent of list) {
      const id = String(agent?.id ?? 'agent')
      if (map.has(id)) continue
      const want = prev.get(id)
      if (
        typeof want === 'number' &&
        want >= 1 &&
        want <= MAX_SLOTS &&
        !used.has(want)
      ) {
        used.add(want)
        slots[want] = agent
        map.set(id, want)
      } else {
        pending.push(agent)
      }
    }
    for (const agent of pending) {
      const id = String(agent?.id ?? 'agent')
      for (let k = 1; k <= MAX_SLOTS; k += 1) {
        if (!used.has(k)) {
          used.add(k)
          slots[k] = agent
          map.set(id, k)
          break
        }
      }
    }
    return { slots, map }
  }

  /**
   * Real tool calls → the theme's "word" records. Only the last 14 calls fit
   * the 14 word slots baked into each cloud.
   * @param {any} agent
   * @param {number} slot cloud slot 1..12
   */
  function wordsFor(agent, slot) {
    // `snapshot.agents[].timeline` is newest-first; flip to chronological and
    // keep the last 14 so the theme's 14 word slots stay in time order.
    const timeline = Array.isArray(agent?.timeline) ? [...agent.timeline].reverse() : []
    const recent = timeline.slice(-WORD_CAP)
    return recent.map((entry, i) => {
      const status =
        entry?.status === 'error' ? 'error' : entry?.status === 'running' ? 'running' : 'ok'
      const startedAt = Number(entry?.startedAt) || 0
      const endedAt = Number(entry?.endedAt) || 0
      const durationMs =
        Number(entry?.durationMs) ||
        (endedAt > 0 && startedAt > 0 ? Math.max(0, endedAt - startedAt) : 0)
      return {
        key: String(entry?.callId || entry?.id || `${slot}-${i}`),
        name: String(entry?.name || 'tool'),
        detail: truncate(entry?.detail || '', 24),
        result: truncate(entry?.result || '', 22),
        status,
        durationMs,
        slot: i,
        ai: slot,
        // Default state; the renderer lifts this when the call actually arrives.
        state: status === 'error' ? 'flag' : status === 'ok' ? 'fix' : 'read',
      }
    })
  }

  /**
   * One section per real agent. Agents without tool calls keep an empty word
   * list (the theme's progress bars then show zero, never a fabricated call).
   * @param {Array<any>} slots index 0 unused
   */
  function sectionsFor(slots) {
    const out = []
    for (let k = 1; k < slots.length; k += 1) {
      const agent = slots[k]
      if (agent === null) continue
      const words = wordsFor(agent, k)
      out.push({
        ai: k,
        agentId: String(agent.id ?? 'agent'),
        words,
        read: words.filter((w) => w.state !== 'idle').length,
        done: words.length === 0 ? false : words.every((w) => w.status !== 'running'),
      })
    }
    return out
  }

  function countWords(sections) {
    let calls = 0
    let running = 0
    let ok = 0
    let error = 0
    for (const section of sections) {
      for (const word of section.words) {
        calls += 1
        if (word.status === 'running') running += 1
        else if (word.status === 'error') error += 1
        else ok += 1
      }
    }
    return { calls, running, ok, error }
  }

  /** Derived gauge: finished = ok + error. No calls → 0 (honest empty state). */
  function successRate(counts) {
    const finished = counts.ok + counts.error
    if (finished === 0) return 0
    return Math.round((counts.ok / finished) * 100)
  }

  /**
   * Which cloud the spider should sit on: the agent with the newest running
   * tool, else the newest agent in an active phase (thinking/tool/waiting).
   * Done/failed/idle agents are not "active", so the spider returns to the
   * core instead of hovering over finished work.
   */
  function focusSlot(slots, primaryId) {
    const ACTIVE = new Set(['thinking', 'tool', 'waiting', 'awaiting'])
    let best = 0
    let bestAt = -1
    for (let k = 1; k < slots.length; k += 1) {
      const agent = slots[k]
      if (agent === null) continue
      const timeline = Array.isArray(agent.timeline) ? agent.timeline : []
      const running = timeline.filter((e) => e?.status === 'running')
      const at = running.length
        ? Math.max(...running.map((e) => Number(e.startedAt) || 0))
        : Number(agent.updatedAt) || 0
      if (at > bestAt && (running.length > 0 || ACTIVE.has(agent.phase))) {
        bestAt = at
        best = k
      }
    }
    if (best > 0) return best
    for (let k = 1; k < slots.length; k += 1) {
      if (slots[k] !== null && String(slots[k].id) === String(primaryId)) return k
    }
    for (let k = 1; k < slots.length; k += 1) if (slots[k] !== null) return k
    return 0
  }

  /** Real event → log verb used by the theme's log list. */
  function eventVerb(event) {
    if (!event) return 'load'
    if (event.phase === 'failed') return 'flag'
    if (event.phase === 'waiting' || event.phase === 'awaiting') return 'ask'
    if (event.phase === 'done') return 'fix'
    if (event.phase === 'tool') return 'crawl'
    if (event.phase === 'thinking') return 'read'
    return 'load'
  }

  function clockOf(at) {
    const date = new Date(Number(at) || 0)
    const pad = (n) => String(n).padStart(2, '0')
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  /**
   * Seven radar axes: tool volume, results, error-free, non-waiting, done,
   * event activity, turn depth. Every value is derived from the snapshot.
   */
  function radarValues(plan) {
    const counts = plan.counts
    const agents = plan.agents
    const total = agents.length
    const finished = counts.ok + counts.error
    const errorFree = counts.calls > 0 ? 1 - counts.error / counts.calls : 1
    const waiting = plan.awaiting
    const notWaiting = counts.calls > 0 ? 1 - waiting / counts.calls : 1
    const done = total > 0 ? agents.filter((a) => a.phase === 'done').length / total : 0
    const eventLevel = clamp((plan.events.length || 0) / 20, 0.08, 1)
    const maxTurn = total > 0 ? Math.max(...agents.map((a) => Number(a.turn) || 0)) : 0
    return [
      clamp(counts.calls / 12, 0.06, 1),
      finished > 0 ? clamp(counts.ok / Math.max(1, finished), 0.06, 1) : 0.06,
      clamp(errorFree, 0.06, 1),
      clamp(notWaiting, 0.06, 1),
      clamp(done, 0.06, 1),
      eventLevel,
      clamp(maxTurn / 6, 0.06, 1),
    ]
  }

  /**
   * Build the whole renderer model from one snapshot.
   * @param {any} snapshot
   * @param {{ slots?: Map<string, number>, states?: Map<string, string> }} [prev]
   */
  function planSnapshot(snapshot, prev = {}) {
    const agentsRaw = Array.isArray(snapshot?.agents) ? snapshot.agents : []
    const { slots, map } = assignSlots(agentsRaw, prev.slots)
    const agents = []
    for (let k = 1; k < slots.length; k += 1) {
      const agent = slots[k]
      if (agent === null) {
        agents.push({
          slot: k,
          id: '',
          short: '',
          cjk: '',
          phase: 'idle',
          tint: EMPTY_TINT,
          load: 0.06,
          turn: 0,
          step: 0,
          elapsedMs: 0,
          error: '',
          model: '',
          empty: true,
        })
        continue
      }
      const phase = String(agent.phase || 'idle')
      agents.push({
        slot: k,
        id: String(agent.id ?? 'agent'),
        short: shortLabel(agent),
        cjk: cjkLabel(agent),
        phase,
        tint: tint(phase),
        load: loadOf(phase),
        turn: Number(agent.turn) || 0,
        step: Number(agent.step) || 0,
        elapsedMs: Number(agent.turnElapsedMs) || 0,
        error: String(agent.error || ''),
        model: String(agent.model || ''),
        empty: false,
      })
    }

    const sections = sectionsFor(slots)
    // Apply previously observed word states so a call is not re-read twice.
    const prevStates = prev.states instanceof Map ? prev.states : new Map()
    for (const section of sections) {
      for (const word of section.words) {
        const known = prevStates.get(word.key)
        if (known !== undefined) word.state = known
      }
      section.read = section.words.filter((w) => w.state !== 'idle').length
    }

    const counts = countWords(sections)
    const awaiting = agents.filter(
      (a) => a.phase === 'waiting' || a.phase === 'awaiting',
    ).length
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const rate = successRate(counts)
    const focus = focusSlot(slots, snapshot?.primary)

    return {
      slots,
      slotMap: map,
      agents,
      sections,
      counts,
      awaiting,
      rate,
      focus,
      events,
      at: Number(snapshot?.at) || 0,
      primary: snapshot?.primary ?? null,
      idle: agents.every((a) => a.empty || a.phase === 'idle'),
    }
  }

  globalThis.__DSH_NEBULA_CORE__ = {
    PHASE_TINT,
    PHASE_LOAD,
    WORD_CAP,
    MAX_SLOTS,
    tint,
    loadOf,
    cjkPhase,
    verbOf,
    shortLabel,
    cjkLabel,
    assignSlots,
    wordsFor,
    sectionsFor,
    countWords,
    successRate,
    focusSlot,
    eventVerb,
    clockOf,
    radarValues,
    planSnapshot,
  }
})()
