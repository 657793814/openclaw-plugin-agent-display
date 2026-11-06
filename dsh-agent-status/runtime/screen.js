/**
 * AGENT 作战大屏 — client half.
 *
 * Served as a standalone page by the plugin route `/dsh-agent-status/screen`.
 * It consumes exactly the same snapshot as the HUD (`/api/state` + `/stream`),
 * which is built from real host events. There is no simulation engine here.
 *
 * Transport: SSE first, polling fallback, automatic SSE retry after a drop.
 * Auth: the token travels in the URL built by the HUD from `location.origin`,
 * so no port is ever hard-coded. Missing/invalid tokens surface as a 401 page
 * (server) or an explicit "鉴权失败" overlay (after a host restart invalidates
 * the per-boot ticket).
 */
;(() => {
  const CFG = globalThis.__DSH_AGENT_STATUS_SCREEN__ || {}
  const PREFIX = String(CFG.prefix || '/dsh-agent-status')
  const POLL_MS = Math.max(250, Number(CFG.pollMs) || 800)
  const WAITING_AFTER_MS = Math.max(3000, Number(CFG.waitingAfterMs) || 15_000)
  const VERSION = String(CFG.version || '—')
  const QUERY = new URLSearchParams(location.search)
  const TOKEN = QUERY.get('token') || ''
  const SSE_RETRY_MS = 5000
  // `?theme=galaxy` previews the NEBULA theme without touching the profile.
  const THEME = (() => {
    const wanted = String(QUERY.get('theme') || CFG.screenTheme || CFG.theme || 'neon')
    return ['neon', 'mono', 'galaxy'].includes(wanted) ? wanted : 'neon'
  })()

  const PHASE_TEXT = {
    idle: 'IDLE',
    thinking: 'THINK',
    tool: 'TOOL',
    waiting: 'HOLD',
    awaiting: 'AWAIT',
    done: 'DONE',
    failed: 'FAIL',
  }

  const PHASE_CJK = {
    idle: '空闲 / 待命',
    thinking: '思考中 / 请求模型',
    tool: '调用工具',
    waiting: '等待用户确认',
    awaiting: '等待用户输入',
    done: '本轮完成',
    failed: '执行失败',
  }

  const GLYPH = {
    idle: '◇',
    thinking: '◍',
    tool: '⌁',
    waiting: '?',
    awaiting: '◌',
    done: '✓',
    failed: '✕',
  }

  // ---------- dom ----------
  const el = {
    frame: document.getElementById('frame'),
    version: document.getElementById('version'),
    footerVersion: document.getElementById('footer-version'),
    conn: document.getElementById('conn'),
    connText: document.getElementById('conn-text'),
    clock: document.getElementById('clock'),
    pause: document.getElementById('pause'),
    waiting: document.getElementById('waiting'),
    phaseBlock: document.getElementById('phase-block'),
    glyph: document.getElementById('stage-glyph'),
    stageName: document.getElementById('stage-name'),
    stageCn: document.getElementById('stage-cn'),
    pulse: document.getElementById('pulse'),
    agent: document.getElementById('m-agent'),
    model: document.getElementById('m-model'),
    turn: document.getElementById('m-turn'),
    elapsed: document.getElementById('m-elapsed'),
    tokens: document.getElementById('m-tokens'),
    tools: document.getElementById('m-tools'),
    timeline: document.getElementById('timeline'),
    timelineEmpty: document.getElementById('timeline-empty'),
    timelineCount: document.getElementById('timeline-count'),
    agents: document.getElementById('agents'),
    agentsEmpty: document.getElementById('agents-empty'),
    agentsCount: document.getElementById('agents-count'),
    agentFilter: document.getElementById('agent-filter'),
    filterAll: document.getElementById('filter-all'),
    events: document.getElementById('events'),
    eventsEmpty: document.getElementById('events-empty'),
    footerStale: document.getElementById('footer-stale'),
    offline: document.getElementById('offline'),
    offlineTitle: document.getElementById('offline-title'),
    offlineNote: document.getElementById('offline-note'),
    pausedBadge: document.getElementById('paused'),
  }

  document.documentElement.dataset.theme = THEME
  el.version.textContent = VERSION
  el.footerVersion.textContent = VERSION

  // NEBULA「星核蜘蛛」：原主题（index.html theme 05）的模板与渲染代码原样挂进
  // Shadow DOM；这里只负责把真实快照喂给它的数据入口。neon/mono 不加载 WebGL。
  const nebula = (() => {
    if (THEME !== 'galaxy') return null
    if (typeof globalThis.DSHNebulaMount !== 'function' || typeof CFG.nebulaTemplate !== 'string') {
      console.error('[agent-status] NEBULA assets missing; falling back to neon')
      document.documentElement.dataset.theme = 'neon'
      return null
    }
    const host = document.createElement('div')
    host.className = 'nebula-host'
    host.id = 'host-nebula'
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = CFG.nebulaTemplate
    try {
      const ctrl = globalThis.DSHNebulaMount(host, shadow)
      el.frame.hidden = true
      return ctrl
    } catch (error) {
      console.error('[agent-status] NEBULA mount failed', error)
      host.remove()
      document.documentElement.dataset.theme = 'neon'
      return null
    }
  })()
  // Read-only diagnostics for verification; never includes chat/tool payloads.
  globalThis.__DSH_NEBULA_DEBUG__ = () => (nebula === null ? null : nebula.debug())
  globalThis.__DSH_GALAXY_DEBUG__ = globalThis.__DSH_NEBULA_DEBUG__

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0')

  const hhmmss = (at) => {
    const date = new Date(at)
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  const duration = (ms) => {
    const total = Math.max(0, Math.floor(Number(ms) / 1000))
    const minutes = Math.floor(total / 60)
    if (minutes >= 60) {
      return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
    }
    return `${pad(minutes)}:${pad(total % 60)}`
  }

  const shortId = (id) => {
    const text = String(id || 'agent')
    return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-5)}` : text
  }

  const compactNumber = (value) => {
    const n = Number(value) || 0
    if (n < 1000) return String(n)
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  }

  const setText = (node, text) => {
    if (node !== null && node.textContent !== text) node.textContent = text
  }

  const PHASE_COLOR =
    THEME === 'galaxy'
      ? {
          idle: '#6f7d96',
          thinking: '#62e3ff',
          tool: '#ff6fae',
          waiting: '#ffd27a',
          awaiting: '#a093ff',
          done: '#6ff0c0',
          failed: '#ff6b8b',
        }
      : {
          idle: '#5d6f7d',
          thinking: '#45e6f5',
          tool: '#ff3f8e',
          waiting: '#ffb020',
          awaiting: '#8ea6bd',
          done: '#35e08a',
          failed: '#ff4d5e',
        }

  const phaseColor = (phase) => PHASE_COLOR[phase] || PHASE_COLOR.idle

  // ---------- state ----------
  let latest = null
  let pending = null
  let paused = false
  let mode = 'connecting'
  let source = null
  let pollTimer = null
  let sseRetryTimer = null
  let lastReceivedAt = 0
  let selectedAgentId = null
  let lastPhase = null
  let flashTimer = null
  let startedAt = Date.now()

  // ---------- connection badge ----------
  function setConn(state, text) {
    mode = state
    el.conn.dataset.state = state
    setText(el.connText, text)
    nebula?.setTransport(state)
  }

  function showOffline(title, note) {
    el.offlineTitle.textContent = title
    el.offlineNote.textContent = note
    el.offline.hidden = false
  }

  function hideOffline() {
    el.offline.hidden = true
  }

  // ---------- render ----------
  function primaryAgent() {
    if (latest === null) return null
    const agents = Array.isArray(latest.agents) ? latest.agents : []
    return (
      agents.find((agent) => agent.id === latest.primary) ?? agents[0] ?? null
    )
  }

  function timelineAgent() {
    if (latest === null) return null
    const agents = Array.isArray(latest.agents) ? latest.agents : []
    if (selectedAgentId !== null) {
      const selected = agents.find((agent) => agent.id === selectedAgentId)
      if (selected !== undefined) return selected
    }
    return primaryAgent()
  }

  function phaseFlash(phase) {
    if (lastPhase === null || phase === lastPhase) {
      lastPhase = phase
      return
    }
    lastPhase = phase
    el.frame.classList.remove('phase-flash')
    // Force a reflow so the animation restarts even on rapid switches.
    void el.frame.offsetWidth
    el.frame.classList.add('phase-flash')
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      el.frame.classList.remove('phase-flash')
      flashTimer = null
    }, 750)
  }

  function renderOverview(primary) {
    const phase = primary?.phase ?? 'idle'
    el.frame.dataset.phase = phase
    phaseFlash(phase)
    setText(el.stageName, PHASE_TEXT[phase] ?? 'IDLE')
    setText(el.stageCn, primary === null ? '未检测到 agent' : String(primary.label || PHASE_CJK[phase] || ''))
    setText(el.glyph, GLYPH[phase] ?? '◇')
    el.pulse.style.background = phaseColor(phase)

    setText(el.agent, primary === null ? '—' : shortId(primary.id))
    setText(el.model, primary?.model ? String(primary.model) : '—')
    setText(
      el.turn,
      primary === null ? '—' : `${Number(primary.turn) || 0} / ${Number(primary.step) || 0}`,
    )
    setText(el.elapsed, primary === null ? '—' : duration(primary.turnElapsedMs))
    setText(
      el.tokens,
      primary?.usage
        ? `${compactNumber(primary.usage.inputTokens)} / ${compactNumber(primary.usage.outputTokens)}`
        : '—',
    )
    setText(el.tools, primary === null ? '—' : String(Number(primary.toolCalls) || 0))
  }

  function renderTimeline(agent) {
    const entries = Array.isArray(agent?.timeline) ? agent.timeline : []
    setText(el.timelineCount, `${entries.length} CALLS`)
    el.timelineEmpty.hidden = entries.length > 0
    el.timeline.replaceChildren()

    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'tl-row'
      row.dataset.status = String(entry.status || 'running')
      row.dataset.start = String(Number(entry.startedAt) || 0)
      row.dataset.end = String(Number(entry.endedAt) || 0)

      const time = document.createElement('span')
      time.className = 'tl-time'
      time.textContent = hhmmss(Number(entry.startedAt) || Date.now())

      const name = document.createElement('span')
      name.className = 'tl-name'
      const nameBold = document.createElement('b')
      nameBold.textContent = String(entry.name || 'tool')
      const nameSub = document.createElement('small')
      nameSub.textContent = `T${Number(entry.turn) || 0} · S${Number(entry.step) || 0}`
      name.append(nameBold, nameSub)

      const detail = document.createElement('span')
      detail.className = 'tl-detail'
      const detailMain = document.createElement('span')
      detailMain.textContent = String(entry.detail || '（无参数摘要）')
      const detailResult = document.createElement('small')
      if (entry.status === 'running') {
        detailResult.textContent = '执行中…'
      } else if (entry.status === 'error') {
        detailResult.textContent = `✕ ${String(entry.result || '工具报错')}`
      } else {
        detailResult.textContent =
          entry.result === '' ? '✓ 已完成' : `→ ${String(entry.result)}`
      }
      detail.append(detailMain, detailResult)

      const state = document.createElement('span')
      state.className = 'tl-state'
      const dot = document.createElement('span')
      dot.className = 'tl-dot'
      const dur = document.createElement('b')
      dur.dataset.role = 'dur'
      dur.textContent = duration(entry.durationMs)
      state.append(dot, dur)

      row.append(time, name, detail, state)
      el.timeline.append(row)
    }
  }

  function renderAgents(list, primary) {
    const agents = Array.isArray(list) ? list : []
    setText(el.agentsCount, String(agents.length))
    el.agentsEmpty.hidden = agents.length > 0
    el.agents.replaceChildren()

    for (const agent of agents) {
      const card = document.createElement('button')
      card.type = 'button'
      card.className = 'agent-card'
      card.dataset.phase = String(agent.phase || 'idle')
      card.style.setProperty('--pc', phaseColor(String(agent.phase || 'idle')))
      card.dataset.active = agent.id === primary?.id ? 'true' : 'false'
      card.dataset.selected = agent.id === selectedAgentId ? 'true' : 'false'

      const top = document.createElement('span')
      top.className = 'agent-top'
      const dot = document.createElement('span')
      dot.className = 'd'
      const id = document.createElement('b')
      id.textContent = shortId(agent.id)
      const phase = document.createElement('em')
      phase.textContent = PHASE_TEXT[agent.phase] || String(agent.phase || '')
      top.append(dot, id, phase)

      const meta = document.createElement('span')
      meta.className = 'agent-meta'
      meta.textContent = `T${Number(agent.turn) || 0}/S${Number(agent.step) || 0} · ${Number(agent.toolCalls) || 0} TOOLS · ${duration(agent.turnElapsedMs)}`

      card.append(top, meta)

      if (typeof agent.error === 'string' && agent.error !== '') {
        const error = document.createElement('span')
        error.className = 'agent-err'
        error.textContent = String(agent.error).slice(0, 90)
        card.append(error)
      }

      card.addEventListener('click', () => {
        selectedAgentId = selectedAgentId === agent.id ? null : agent.id
        render()
      })

      el.agents.append(card)
    }

    const multi = agents.length > 1 || selectedAgentId !== null
    el.agentFilter.hidden = !multi
  }

  function renderEvents(events) {
    const list = Array.isArray(events) ? events : []
    el.eventsEmpty.hidden = list.length > 0
    el.events.replaceChildren()

    for (const event of list) {
      const row = document.createElement('div')
      row.className = 'ev-row'

      const time = document.createElement('span')
      time.className = 'ev-time'
      time.textContent = hhmmss(Number(event.at) || Date.now())

      const bar = document.createElement('span')
      bar.className = 'ev-bar'
      bar.dataset.p = String(event.phase || 'idle')

      const text = document.createElement('span')
      text.className = 'ev-text'
      const agent = document.createElement('b')
      agent.textContent = `${shortId(event.agentId)} `
      text.append(agent, document.createTextNode(String(event.text || '')))

      row.append(time, bar, text)
      el.events.append(row)
    }
  }

  function render() {
    // NEBULA owns its own HUD; the legacy frame stays hidden.
    if (nebula !== null) return
    const snapshot = latest
    if (snapshot === null) {
      renderOverview(null)
      renderTimeline(null)
      renderAgents([], null)
      renderEvents([])
      return
    }
    const primary = primaryAgent()
    renderOverview(primary)
    renderTimeline(timelineAgent())
    renderAgents(snapshot.agents, primary)
    renderEvents(snapshot.events)
    el.footerStale.dataset.stale = 'false'
    setText(el.footerStale, paused ? '已暂停' : '数据实时')
  }

  function applySnapshot(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object') return
    pending = snapshot
    lastReceivedAt = Date.now()
    if (paused) return
    latest = snapshot
    nebula?.setSnapshot(snapshot)
    render()
  }

  // ---------- live counters / waiting ----------
  function tick() {
    setText(el.clock, hhmmss(Date.now()))

    // Keep running rows and elapsed time moving between snapshots.
    if (latest !== null) {
      const primary = primaryAgent()
      if (primary !== null) {
        const running = primary.turnStartedAt !== null && primary.turnEndedAt === null
        const drift = running ? Math.max(0, Date.now() - Number(latest.at || Date.now())) : 0
        setText(el.elapsed, duration((Number(primary.turnElapsedMs) || 0) + drift))
      }
      const now = Date.now()
      for (const row of el.timeline.querySelectorAll('.tl-row[data-status="running"]')) {
        const start = Number(row.dataset.start) || now
        const dur = row.querySelector('[data-role="dur"]')
        if (dur !== null) dur.textContent = duration(now - start)
      }
    }

    const sinceEvent = Date.now() - Math.max(Number(latest?.lastEventAt) || 0, startedAt)
    const waiting = !paused && mode !== 'offline' && mode !== 'denied' && sinceEvent > WAITING_AFTER_MS
    el.waiting.hidden = !waiting
    nebula?.setWaiting(waiting)

    if (paused) {
      el.footerStale.dataset.stale = 'false'
      setText(el.footerStale, '已暂停')
      return
    }
    if (mode === 'offline' || mode === 'denied') {
      el.footerStale.dataset.stale = 'offline'
      setText(el.footerStale, '最后快照已过期')
      return
    }
    if (waiting) {
      // No tool/agent event for a while: this is a valid quiet state, not a
      // stale transport. Avoid implying the data feed is broken.
      el.footerStale.dataset.stale = 'false'
      setText(el.footerStale, '等待中 · 无新事件')
      return
    }
    const age = Date.now() - lastReceivedAt
    if (age > 10_000) {
      el.footerStale.dataset.stale = 'true'
      setText(el.footerStale, `数据 ${Math.round(age / 1000)}s 未更新`)
    } else {
      el.footerStale.dataset.stale = 'false'
      setText(el.footerStale, '数据实时')
    }
  }

  setInterval(tick, 500)
  tick()

  // ---------- pause ----------
  function setPaused(next) {
    paused = next === true
    el.pause.setAttribute('aria-pressed', paused ? 'true' : 'false')
    el.pause.textContent = paused ? '继续刷新' : '暂停刷新'
    el.pausedBadge.hidden = !paused
    nebula?.setPaused(paused)
    if (!paused && pending !== null) {
      latest = pending
      // Re-baseline so calls that finished during the pause do not replay.
      nebula?.resync(pending)
      render()
    }
  }

  el.pause.addEventListener('click', () => setPaused(!paused))
  // NEBULA 全屏没有旧 HUD 的暂停按钮：P 键等价于「暂停刷新/继续」。
  if (nebula !== null) {
    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'p' || event.key === 'P') setPaused(!paused)
    })
  }

  el.filterAll.addEventListener('click', () => {
    selectedAgentId = null
    render()
  })

  // ---------- transport ----------
  function stateUrl() {
    return `${PREFIX}/api/state?token=${encodeURIComponent(TOKEN)}`
  }

  function authHeaders() {
    return TOKEN === '' ? {} : { 'X-Agent-Status-Token': TOKEN }
  }

  function clearPolling() {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  function denyAuth() {
    clearPolling()
    closeSse()
    if (sseRetryTimer !== null) clearTimeout(sseRetryTimer)
    sseRetryTimer = null
    setConn('denied', '鉴权失败')
    showOffline(
      '需要鉴权 · 401',
      '缺少或失效的 token。请从 HUD 的「大屏」入口重新打开，或使用 /dsh-agent-status/screen?token=<安装 token>。',
    )
  }

  function startPolling() {
    if (pollTimer !== null) return
    const tickOnce = async () => {
      try {
        const response = await fetch(stateUrl(), {
          cache: 'no-store',
          headers: authHeaders(),
        })
        if (response.status === 401) {
          denyAuth()
          return
        }
        if (!response.ok) throw new Error(String(response.status))
        applySnapshot(await response.json())
        hideOffline()
        if (mode !== 'live') setConn('poll', '轮询回退')
      } catch {
        if (mode !== 'denied') {
          setConn('offline', '连接中断')
          showOffline('连接中断', '正在自动重连，保留最后一次快照…')
        }
      }
    }
    void tickOnce()
    pollTimer = setInterval(tickOnce, POLL_MS)
  }

  function closeSse() {
    if (source === null) return
    try {
      source.close()
    } catch {
      /* already closed */
    }
    source = null
  }

  function scheduleSseRetry() {
    if (sseRetryTimer !== null || mode === 'denied') return
    sseRetryTimer = setTimeout(() => {
      sseRetryTimer = null
      connectSse()
    }, SSE_RETRY_MS)
  }

  function connectSse() {
    if (mode === 'denied') return
    if (typeof globalThis.EventSource !== 'function') {
      startPolling()
      return
    }
    closeSse()
    try {
      source = new EventSource(`${PREFIX}/stream?token=${encodeURIComponent(TOKEN)}`)
    } catch {
      startPolling()
      scheduleSseRetry()
      return
    }

    source.addEventListener('state', (event) => {
      let snapshot
      try {
        snapshot = JSON.parse(event.data)
      } catch {
        return
      }
      applySnapshot(snapshot)
      clearPolling()
      hideOffline()
      setConn('live', '实时 SSE')
    })

    source.addEventListener('open', () => {
      clearPolling()
      hideOffline()
      setConn('live', '实时 SSE')
    })

    source.addEventListener('error', () => {
      closeSse()
      if (mode === 'denied') return
      setConn('poll', '轮询回退')
      startPolling()
      scheduleSseRetry()
    })
  }

  connectSse()

  globalThis.addEventListener('beforeunload', () => {
    nebula?.destroy()
    closeSse()
    clearPolling()
    if (sseRetryTimer !== null) clearTimeout(sseRetryTimer)
  })

  render()
})()
