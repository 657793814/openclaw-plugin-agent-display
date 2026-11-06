/**
 * Client half of dsh-agent-status.
 *
 * Injected as one synchronous script row by `webserver/index-inject`, so it
 * must not rely on the host's React tree or module loader. Everything lives in
 * a shadow root: the series shell already uses shadow DOM, and this keeps the
 * HUD immune to the host's CSS.
 *
 * Transport: SSE (`/dsh-agent-status/stream`) with polling fallback. Both are
 * read-only; the widget never posts anything back.
 */
;(() => {
  const CFG = globalThis.__DSH_AGENT_STATUS__
  if (!CFG || typeof CFG.css !== 'string') return
  if (globalThis.__DSH_AGENT_STATUS_STARTED__) return
  globalThis.__DSH_AGENT_STATUS_STARTED__ = true

  const PREFIX = CFG.prefix || '/dsh-agent-status'
  const POLL_MS = Number(CFG.pollMs) || 800
  const TICKET = String(CFG.ticket || '')
  const KEY_COLLAPSED = 'dsh-agent-status.collapsed'
  const KEY_POS = 'dsh-agent-status.pos'
  const KEY_ANCHOR = 'dsh-agent-status.anchor'
  const KEY_VISIBLE = 'dsh-agent-status.visible'
  const ANCHORS = ['bottom-right', 'top-right', 'top-left', 'bottom-left']

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

  // ---------- shadow host ----------
  const host = document.createElement('div')
  host.id = 'dsh-agent-status'
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  host.setAttribute('aria-label', 'Agent 工作状态')
  const root = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CFG.css
  root.append(style)

  const template = document.createElement('template')
  template.innerHTML = `
    <div class="hud" data-phase="idle" data-multi="false" data-collapsed="false">
      <div class="panel">
        <div class="head" data-drag="true">
          <span class="mark"></span>
          <span class="title">AGENT STATUS <i>// 工作状态</i></span>
          <span class="link" data-online="false"><span class="dot"></span><span class="link-text">连接中</span></span>
          <button class="act screen" type="button" data-act="screen" title="打开作战大屏（新标签页）" aria-label="打开作战大屏">大屏</button>
          <button class="act" type="button" data-act="anchor" title="切换位置（右下 / 右上）" aria-label="切换位置">⇅</button>
          <button class="act" type="button" data-act="hide" title="隐藏 HUD" aria-label="隐藏 HUD">×</button>
          <button class="toggle" type="button" data-act="collapse" title="折叠 / 展开" aria-label="折叠或展开">–</button>
        </div>
        <div class="body">
          <div class="orb">
            <span class="ring out"></span>
            <span class="ring mid"></span>
            <span class="ring in"></span>
            <span class="core">◇</span>
            <span class="eq"><span></span><span></span><span></span><span></span><span></span></span>
          </div>
          <div class="read">
            <div class="kicker">CURRENT PHASE / 当前阶段</div>
            <div class="phase">IDLE</div>
            <div class="cjk">空闲 / 待命</div>
            <div class="toolchip"><b></b><span class="t"></span></div>
            <div class="errline"></div>
          </div>
        </div>
        <div class="others"></div>
        <div class="stats">
          <div class="cell"><span class="k">TURN / STEP</span><span class="v" data-f="turn">–</span></div>
          <div class="cell"><span class="k">TOOL CALLS</span><span class="v" data-f="tools">0</span></div>
          <div class="cell"><span class="k">TOKENS IN/OUT</span><span class="v" data-f="tokens">–</span></div>
          <div class="cell"><span class="k">ELAPSED</span><span class="v" data-f="elapsed">00:00</span></div>
        </div>
        <div class="feed"></div>
        <div class="foot">
          <span class="src">agent/status · session/event</span>
          <span class="ver">v${String(CFG.version || '1.0.0')}</span>
        </div>
      </div>
    </div>
    <button class="bubble" type="button" title="显示 HUD" aria-label="显示 HUD" hidden>◍</button>
  `
  root.append(template.content)

  const ui = {
    hud: root.querySelector('.hud'),
    phase: root.querySelector('.phase'),
    cjk: root.querySelector('.cjk'),
    core: root.querySelector('.core'),
    chip: root.querySelector('.toolchip'),
    chipName: root.querySelector('.toolchip b'),
    chipTime: root.querySelector('.toolchip .t'),
    err: root.querySelector('.errline'),
    others: root.querySelector('.others'),
    feed: root.querySelector('.feed'),
    link: root.querySelector('.link'),
    linkText: root.querySelector('.link-text'),
    toggle: root.querySelector('[data-act="collapse"]'),
    screenBtn: root.querySelector('[data-act="screen"]'),
    anchorBtn: root.querySelector('[data-act="anchor"]'),
    hideBtn: root.querySelector('[data-act="hide"]'),
    bubble: root.querySelector('.bubble'),
    fields: {
      turn: root.querySelector('[data-f="turn"]'),
      tools: root.querySelector('[data-f="tools"]'),
      tokens: root.querySelector('[data-f="tokens"]'),
      elapsed: root.querySelector('[data-f="elapsed"]'),
    },
  }

  document.documentElement.append(host)

  // ---------- helpers ----------
  const setText = (el, text) => {
    if (el !== null && el.textContent !== text) el.textContent = text
  }

  const pad = (n) => String(n).padStart(2, '0')

  const hhmmss = (at) => {
    const d = new Date(at)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const clock = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
  }

  const shortId = (id) => {
    const text = String(id || 'agent')
    return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text
  }

  const compactNumber = (n) => {
    const value = Number(n) || 0
    if (value < 1000) return String(value)
    return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
  }

  // ---------- preferences ----------
  const readPref = (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null
    } catch {
      return null
    }
  }
  const writePref = (key, value) => {
    try {
      globalThis.localStorage?.setItem(key, value)
    } catch {
      /* storage may be unavailable on file:// */
    }
  }

  let collapsed = readPref(KEY_COLLAPSED) === 'true'
  ui.hud.dataset.collapsed = collapsed ? 'true' : 'false'
  ui.toggle.textContent = collapsed ? '+' : '–'

  const storedVisible = readPref(KEY_VISIBLE)
  let visible = storedVisible === null ? CFG.visible !== false : storedVisible === 'true'

  let anchor = readPref(KEY_ANCHOR) || String(CFG.position || 'bottom-right')
  if (!ANCHORS.includes(anchor)) anchor = 'bottom-right'
  host.dataset.anchor = anchor
  ui.hud.dataset.theme = String(CFG.theme || 'neon')
  host.dataset.theme = String(CFG.theme || 'neon')
  host.dataset.version = String(CFG.version || '')

  function clearOffsets() {
    for (const el of [ui.hud, ui.bubble]) {
      el.style.left = ''
      el.style.top = ''
    }
    delete host.dataset.posX
    delete host.dataset.posY
  }

  function setAnchor(next) {
    anchor = next
    host.dataset.anchor = next
    clearOffsets()
    writePref(KEY_ANCHOR, next)
    try {
      globalThis.localStorage?.removeItem(KEY_POS)
    } catch {
      /* ignore */
    }
  }

  /**
   * Custom pixel position (drag). Presets are handled by CSS anchors.
   * `x`/`y` are viewport coordinates.
   */
  function applyPosition(x, y) {
    if (x === undefined || y === undefined) return
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return
    const width = ui.hud.getBoundingClientRect().width
    const height = ui.hud.getBoundingClientRect().height
    const left = Math.min(Math.max(8, nx), Math.max(8, innerWidth - width - 8))
    const top = Math.min(Math.max(8, ny), Math.max(8, innerHeight - height - 8))
    host.dataset.anchor = 'custom'
    ui.hud.style.left = `${left}px`
    ui.hud.style.top = `${top}px`
    ui.bubble.style.left = `${left}px`
    ui.bubble.style.top = `${top}px`
    host.dataset.posX = String(left)
    host.dataset.posY = String(top)
  }

  function setVisible(next) {
    visible = next === true
    ui.hud.hidden = !visible
    ui.bubble.hidden = visible
    writePref(KEY_VISIBLE, String(visible))
  }

  setVisible(visible)

  // Restore a custom drag position, if one was saved.
  try {
    const saved = readPref(KEY_POS)
    if (saved !== null) {
      const parsed = JSON.parse(saved)
      anchor = 'custom'
      host.dataset.anchor = 'custom'
      applyPosition(parsed.x, parsed.y)
    }
  } catch {
    /* ignore malformed preference */
  }

  ui.toggle.addEventListener('click', (event) => {
    event.stopPropagation()
    collapsed = !collapsed
    ui.hud.dataset.collapsed = collapsed ? 'true' : 'false'
    ui.toggle.textContent = collapsed ? '+' : '–'
    writePref(KEY_COLLAPSED, String(collapsed))
    if (anchor === 'custom') applyPosition(host.dataset.posX, host.dataset.posY)
  })

  ui.anchorBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    const next = ANCHORS[(ANCHORS.indexOf(anchor) + 1) % ANCHORS.length]
    setAnchor(next)
  })

  ui.hideBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    setVisible(false)
  })

  /**
   * Open the standalone operations screen in a new browser tab/window.
   *
   * Desktop Harness blocks `window.open` inside its Electron renderer and
   * forwards http(s) targets to the system browser, so we need a real HTTP
   * origin: the shell exposes the live server origin on
   * `__DSH_TRANSPORT__.streamBaseUrl` (random port per boot). Mock/dev hosts
   * fall back to `location.origin`. Nothing is hard-coded.
   */
  function screenOrigin() {
    const transportOrigin = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
    if (typeof transportOrigin === 'string' && /^https?:\/\//u.test(transportOrigin)) {
      return transportOrigin.replace(/\/+$/u, '')
    }
    const protocol = globalThis.location?.protocol
    if (!protocol || protocol === 'file:' || protocol === 'about:') return ''
    if (protocol !== 'http:' && protocol !== 'https:') return ''
    return globalThis.location.origin
  }

  function openScreen() {
    const origin = screenOrigin()
    if (origin === '') return
    const url = `${origin}${PREFIX}/screen?token=${encodeURIComponent(TICKET)}`
    if (String(CFG.screenWindow || 'tab') === 'window') {
      globalThis.open(url, 'dsh-agent-status-screen', 'popup,width=1440,height=900')
    } else {
      globalThis.open(url, '_blank', 'noopener')
    }
  }

  ui.screenBtn.hidden = CFG.screenButton === false
  ui.screenBtn.addEventListener('click', (event) => {
    event.stopPropagation()
    openScreen()
  })

  // Optional default landing page: open the big screen once per shell session.
  if (String(CFG.screenLanding || 'hud') === 'screen' && screenOrigin() !== '') {
    try {
      const KEY_AUTO = 'dsh-agent-status.screen-auto'
      if (globalThis.sessionStorage?.getItem(KEY_AUTO) !== '1') {
        globalThis.sessionStorage?.setItem(KEY_AUTO, '1')
        globalThis.setTimeout(openScreen, 800)
      }
    } catch {
      /* storage unavailable: do not auto-open */
    }
  }

  ui.bubble.addEventListener('click', () => setVisible(true))

  globalThis.addEventListener('keydown', (event) => {
    // Alt+Shift+H toggles visibility without touching the profile config.
    if (event.altKey && event.shiftKey && String(event.key).toLowerCase() === 'h') {
      setVisible(!visible)
    }
  })

  // drag by the header
  let drag = null
  let moved = false
  const head = root.querySelector('.head')
  head.addEventListener('pointerdown', (event) => {
    if (event.target instanceof globalThis.Element && event.target.closest('button') !== null) return
    if (event.button !== undefined && event.button !== 0) return
    const rect = ui.hud.getBoundingClientRect()
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
    moved = false
    head.style.cursor = 'grabbing'
    event.preventDefault()
  })

  globalThis.addEventListener('pointermove', (event) => {
    if (drag === null) return
    moved = true
    applyPosition(event.clientX - drag.dx, event.clientY - drag.dy)
  })

  globalThis.addEventListener('pointerup', () => {
    if (drag === null) return
    drag = null
    head.style.cursor = 'grab'
    if (!moved) return
    writePref(
      KEY_POS,
      JSON.stringify({ x: Number(host.dataset.posX), y: Number(host.dataset.posY) }),
    )
  })

  globalThis.addEventListener('resize', () => {
    if (anchor === 'custom') applyPosition(host.dataset.posX, host.dataset.posY)
  })

  // ---------- render ----------
  let latest = null
  let online = false
  let feedSignature = ''

  function renderFeed(events) {
    const list = Array.isArray(events) ? events.slice(0, 4) : []
    const signature = list.map((event) => `${event.at}:${event.text}`).join('|')
    if (signature === feedSignature) return
    feedSignature = signature
    ui.feed.replaceChildren()
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '暂无事件 · 等待 agent 活动'
      ui.feed.append(empty)
      return
    }
    for (const event of list) {
      const row = document.createElement('div')
      row.className = 'row'
      const bar = document.createElement('span')
      bar.className = 'bar'
      bar.dataset.p = String(event.phase || 'idle')
      const time = document.createElement('span')
      time.className = 't'
      time.textContent = hhmmss(Number(event.at) || Date.now())
      const message = document.createElement('span')
      message.className = 'm'
      message.textContent = String(event.text || '')
      row.append(bar, time, message)
      ui.feed.append(row)
    }
  }

  function renderOthers(agents, primaryId) {
    const others = Array.isArray(agents) ? agents.filter((agent) => agent.id !== primaryId) : []
    const visible = others.slice(0, 3)
    ui.hud.dataset.multi = visible.length > 0 ? 'true' : 'false'
    if (visible.length === 0) {
      ui.others.replaceChildren()
      return
    }
    const signature = visible.map((agent) => `${agent.id}:${agent.phase}:${agent.label}`).join('|')
    if (ui.others.dataset.signature === signature) return
    ui.others.dataset.signature = signature
    ui.others.replaceChildren()
    for (const agent of visible) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.dataset.p = String(agent.phase || 'idle')
      const dot = document.createElement('span')
      dot.className = 'd'
      const label = document.createElement('span')
      label.textContent = `${shortId(agent.id)} · ${PHASE_TEXT[agent.phase] || agent.phase}`
      chip.append(dot, label)
      ui.others.append(chip)
    }
  }

  function render() {
    const snapshot = latest
    const primary =
      snapshot === null
        ? null
        : snapshot.agents?.find((agent) => agent.id === snapshot.primary) ??
          snapshot.agents?.[0] ??
          null
    const phase = primary?.phase ?? 'idle'

    ui.hud.dataset.phase = phase
    setText(ui.phase, PHASE_TEXT[phase] ?? 'IDLE')
    setText(ui.core, GLYPH[phase] ?? '◇')
    setText(
      ui.cjk,
      primary === null
        ? '未检测到 agent'
        : String(primary.label || PHASE_CJK[phase] || ''),
    )

    if (phase === 'tool' && primary?.activeTool) {
      setText(ui.chipName, String(primary.activeTool.name))
      setText(ui.chipTime, clock(Number(primary.activeTool.elapsedMs) || 0))
    } else {
      setText(ui.chipName, '')
      setText(ui.chipTime, '')
    }

    ui.err.textContent =
      phase === 'failed' && primary?.error ? String(primary.error).slice(0, 120) : ''

    setText(ui.fields.turn, primary ? `${primary.turn || 0} / ${primary.step || 0}` : '–')
    setText(ui.fields.tools, primary ? String(primary.toolCalls || 0) : '0')
    setText(
      ui.fields.tokens,
      primary?.usage
        ? `${compactNumber(primary.usage.inputTokens)}/${compactNumber(primary.usage.outputTokens)}`
        : '–',
    )
    setText(ui.fields.elapsed, primary ? clock(Number(primary.elapsedMs) || 0) : '00:00')

    ui.link.dataset.online = online ? 'true' : 'false'
    setText(
      ui.linkText,
      online ? 'LIVE' : latest === null ? '连接中' : '已离线',
    )

    renderOthers(snapshot?.agents ?? [], primary?.id ?? null)
    renderFeed(snapshot?.events ?? [])
  }

  // elapsed counters tick locally between snapshots
  setInterval(() => {
    if (latest === null) return
    const primary =
      latest.agents?.find((agent) => agent.id === latest.primary) ?? latest.agents?.[0]
    if (primary === undefined || primary === null) return
    const drift = Math.max(0, Date.now() - Number(latest.at || Date.now()))
    setText(ui.fields.elapsed, clock((Number(primary.elapsedMs) || 0) + drift))
    if (primary.phase === 'tool' && primary.activeTool) {
      setText(ui.chipTime, clock((Number(primary.activeTool.elapsedMs) || 0) + drift))
    }
  }, 500)

  function apply(snapshot) {
    latest = snapshot
    online = true
    render()
  }

  function setOffline() {
    online = false
    render()
  }

  // ---------- transport ----------
  let source = null
  let pollTimer = null
  let polling = false

  function startPolling() {
    if (polling) return
    polling = true
    const tick = async () => {
      try {
        const response = await fetch(`${PREFIX}/api/state`, {
          cache: 'no-store',
          headers: TICKET === '' ? {} : { 'X-Agent-Status-Token': TICKET },
        })
        if (!response.ok) throw new Error(String(response.status))
        apply(await response.json())
      } catch {
        setOffline()
      }
    }
    void tick()
    pollTimer = setInterval(tick, POLL_MS)
  }

  function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
    polling = false
  }

  const httpOrigin =
    globalThis.location?.protocol === 'http:' || globalThis.location?.protocol === 'https:'

  if (httpOrigin && typeof globalThis.EventSource === 'function') {
    try {
      source = new EventSource(
        `${PREFIX}/stream?token=${encodeURIComponent(TICKET)}`,
      )
      source.addEventListener('state', (event) => {
        try {
          apply(JSON.parse(event.data))
        } catch {
          /* malformed frame: keep the last snapshot */
        }
      })
      source.addEventListener('open', () => {
        online = true
        render()
      })
      source.addEventListener('error', () => {
        try {
          source.close()
        } catch {
          /* already closed */
        }
        source = null
        setOffline()
        startPolling()
      })
    } catch {
      startPolling()
    }
  } else {
    startPolling()
  }

  globalThis.addEventListener('beforeunload', () => {
    try {
      source?.close()
    } catch {
      /* already closed */
    }
    stopPolling()
  })

  render()
})()
