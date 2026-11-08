/**
 * NEBULA 作战大屏 — plugin HTTP client half.
 *
 * The IDE-webview client (`screen.js`) receives snapshots over postMessage.
 * This file replaces only the transport for the plugin's local HTTP server and
 * adds a per-session filter bar; the NEBULA renderer, theme and visuals are
 * untouched.
 *
 * Layout rule: the wide filter bar lives INSIDE the themed `.board` grid (left
 * column, below the TASK/HOST block), so it scales with the theme and never
 * overlaps a panel. In the narrow (`.mini`) layout the board is hidden, so the
 * mini layout gets its own horizontal session strip inserted as a flex child
 * between `.m-top` and `.m-bot` — it inherits the theme colors and, because the
 * flex column reserves its own space, can never cover the title or the stats.
 *
 * Grouping honesty: `groupId` is a chat session id when the cache has chat
 * metadata, otherwise the hub directory id. hub_event_cache carries no
 * project/workspace field, so no project name is ever invented.
 */
;(() => {
  const CFG = globalThis.__DSH_AGENT_STATUS_SCREEN__ || {}
  const WAITING_AFTER_MS = Math.max(3000, Number(CFG.waitingAfterMs) || 15_000)
  const QUERY = new URLSearchParams(location.search)
  const TOKEN = QUERY.get('token') || ''
  const PREFIX = String(CFG.prefix || '')
  const VERSION = String(CFG.version || '—')
  const THEME = (() => {
    const wanted = String(QUERY.get('theme') || CFG.screenTheme || CFG.theme || 'neon')
    return ['neon', 'mono', 'galaxy'].includes(wanted) ? wanted : 'neon'
  })()

  document.documentElement.dataset.theme = THEME
  const versionEl = document.getElementById('version')
  if (versionEl !== null) versionEl.textContent = VERSION

  // ---------------------------------------------------------------- toast style
  const headStyle = document.createElement('style')
  headStyle.textContent = `.nb-toast{position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:10000;
  padding:8px 14px;border-radius:6px;font:12px/1.4 ui-monospace,Menlo,monospace;
  color:#ffd9d9;background:rgba(60,10,18,.9);border:1px solid rgba(255,110,110,.5)}`
  document.head.appendChild(headStyle)

  // ---------------------------------------------------------------- NEBULA
  let ctrl = null
  let bars = null
  if (THEME === 'galaxy') {
    if (typeof globalThis.DSHNebulaMount === 'function' && typeof CFG.nebulaTemplate === 'string') {
      const host = document.createElement('div')
      host.className = 'nebula-host'
      host.id = 'host-nebula'
      document.body.appendChild(host)
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML = CFG.nebulaTemplate
      try {
        ctrl = globalThis.DSHNebulaMount(host, shadow)
        const frame = document.getElementById('frame')
        if (frame !== null) frame.hidden = true
        bars = mountSessionBar(shadow)
      } catch (error) {
        console.error('[nebula-plugin] mount failed', error)
        host.remove()
        ctrl = null
      }
    } else {
      console.error('[nebula-plugin] NEBULA assets missing')
    }
  }
  globalThis.__DSH_NEBULA_DEBUG__ = () => (ctrl === null ? null : ctrl.debug())

  // ---------------------------------------------------------------- state
  let latest = null
  let selected = null // groupId being filtered, null = all
  let barSignature = ''

  function hasFreshEvent(snapshot) {
    if (snapshot.lastEventAt === null || snapshot.lastEventAt === undefined) return false
    return Date.now() - Number(snapshot.lastEventAt) < WAITING_AFTER_MS
  }

  function filtered(snapshot) {
    const all = snapshot.agents || []
    const agents = selected === null ? all : all.filter((agent) => agent.groupId === selected)
    const events =
      selected === null ? snapshot.events || [] : (snapshot.events || []).filter((event) => event.groupId === selected)
    // "累计完成" follows the current scope: the selected session, or all
    // sessions when "全部" is active. An in-flight call is not finished yet.
    let completed = 0
    for (const agent of agents) {
      const calls = Number(agent.toolCalls) || 0
      completed += Math.max(0, calls - (agent.activeTool === null ? 0 : 1))
    }
    return {
      ...snapshot,
      agents,
      events,
      totals: { completed },
      primary: selected === null ? snapshot.primary : agents[0]?.id ?? null,
      filter: selected === null ? snapshot.filter : { group: selected },
    }
  }

  function apply(snapshot) {
    latest = snapshot
    const sessions = snapshot.sessions || []
    if (selected !== null && sessions.every((session) => session.id !== selected)) {
      selected = null
    }
    if (ctrl !== null) {
      ctrl.setSnapshot(filtered(snapshot))
      ctrl.setWaiting(!hasFreshEvent(snapshot))
    }
    renderBar(snapshot)
  }

  // ---------------------------------------------------------------- transport
  function feedUrl() {
    return `${PREFIX}/api/state?token=${encodeURIComponent(TOKEN)}`
  }

  function toast(text) {
    const el = document.createElement('div')
    el.className = 'nb-toast'
    el.textContent = text
    document.body.appendChild(el)
  }

  async function boot() {
    if (TOKEN === '') {
      toast('缺少 token · 请用 start.mjs 输出的完整 URL 打开')
      return
    }
    try {
      const response = await fetch(feedUrl(), { cache: 'no-store' })
      if (response.status === 401) {
        toast('401 · token 无效或已过期，请重新执行 start.mjs')
        if (ctrl !== null) ctrl.setTransport('offline')
        return
      }
      apply(await response.json())
      if (ctrl !== null) ctrl.setTransport('live')
      subscribe()
    } catch (error) {
      console.error('[nebula-plugin] initial fetch failed', error)
      if (ctrl !== null) ctrl.setTransport('offline')
      toast('无法连接本地大屏服务，请确认进程仍在运行')
    }
  }

  let stream = null
  let retryCount = 0
  let retryTimer = 0
  let warnedStale = false

  function subscribe() {
    if (stream !== null) stream.close()
    const es = new EventSource(`${PREFIX}/stream?token=${encodeURIComponent(TOKEN)}`)
    stream = es
    es.addEventListener('state', (event) => {
      retryCount = 0
      try {
        apply(JSON.parse(event.data))
        if (ctrl !== null) ctrl.setTransport('live')
      } catch (error) {
        console.error('[nebula-plugin] bad stream frame', error)
      }
    })
    es.onerror = () => {
      es.close()
      if (stream === es) stream = null
      if (ctrl !== null) ctrl.setTransport('offline')
      retryCount += 1
      if (retryCount >= 3 && !warnedStale) {
        warnedStale = true
        toast('连接持续失败 · 若服务已重启，请重新执行 start.mjs 用新链接打开')
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryCount, 5))
      clearTimeout(retryTimer)
      retryTimer = setTimeout(checkAndReconnect, delay)
    }
  }

  /** A restart rotates the token, so a blind EventSource retry would 401 forever. */
  async function checkAndReconnect() {
    try {
      const response = await fetch(feedUrl(), { cache: 'no-store' })
      if (response.status === 401) {
        if (!warnedStale) {
          warnedStale = true
          toast('token 已失效（服务重启）· 请重新执行 start.mjs 用新链接打开')
        }
        if (ctrl !== null) ctrl.setTransport('offline')
        return
      }
      if (!response.ok) throw new Error(`status ${response.status}`)
    } catch {
      /* service still starting/stopped: keep retrying */
    }
    subscribe()
  }

  // ---------------------------------------------------------------- filter bar
  /**
   * Anchors the bar in the theme's own 1920x1080 board, in the free left column
   * between the TASK/HOST block (`.sec`, ends ≈ y=300) and the bottom panels
   * (`.dp`, start at y=842). Nothing is covered at any window size, and the bar
   * inherits the board's scale. `.narrow` hides `.board`, which folds the wide
   * bar away.
   *
   * The narrow layout gets a second, horizontal strip inside `.mini`. It is
   * inserted as a flex child of the mini column (between `.m-top` and `.m-bot`),
   * so it occupies its own row and cannot cover either the title or the stats.
   */
  function mountSessionBar(shadow) {
    const board = shadow.querySelector('#board')
    const mini = shadow.querySelector('#mini')
    if (board === null || mini === null) return null

    const style = document.createElement('style')
    style.textContent = `
.session-bar{position:absolute;left:24px;top:330px;width:max-content;max-width:300px;
  max-height:490px;overflow:auto;display:none;flex-direction:column;gap:5px;
  padding:8px 9px;box-sizing:border-box;pointer-events:auto;z-index:6;
  font:500 12px/1.4 var(--mono);color:var(--ink2);
  background:rgba(6,10,22,.78);border:1px solid rgba(150,190,255,.3);border-radius:3px;
  box-shadow:inset 0 1px 0 rgba(190,215,255,.07),0 8px 24px rgba(0,0,0,.4)}
.session-bar.on{display:flex}
.session-bar .sb-t{font-size:10px;line-height:1;letter-spacing:.14em;color:var(--mute);white-space:nowrap}
.sb-c{all:unset;cursor:pointer;display:flex;gap:7px;align-items:center;
  padding:4px 6px;border:1px solid rgba(150,190,255,.2);border-radius:2px;
  font:500 12px/1.3 var(--mono);color:var(--ink2);white-space:nowrap}
.sb-c:hover{border-color:var(--ice);color:var(--ink)}
.sb-c[data-on="1"]{background:rgba(140,185,255,.18);border-color:var(--ice);color:var(--ink)}
.sb-d{width:6px;height:6px;border-radius:50%;background:#4a5878;flex:0 0 auto}
.sb-d.live{background:var(--good);box-shadow:0 0 6px var(--good)}
.session-bar .sb-h{font:400 10px/1.35 var(--cjk);color:var(--mute);white-space:nowrap}
.m-sess{display:none;pointer-events:auto;align-items:center;gap:7px;
  margin:0 -4px auto;padding:2px 4px 0;min-width:0}
.m-sess.on{display:flex}
.m-sess .ms-t{flex:0 0 auto;font:500 9px/1 var(--mono);letter-spacing:.14em;
  color:var(--mute);white-space:nowrap}
.m-sess .ms-scroll{display:flex;gap:5px;flex:1 1 auto;min-width:0;
  overflow-x:auto;overflow-y:hidden;padding:2px 0 4px;
  scrollbar-width:none;-webkit-overflow-scrolling:touch}
.m-sess .ms-scroll::-webkit-scrollbar{display:none}
.m-sess .sb-c{flex:0 0 auto;padding:3px 6px;font-size:11px}`
    shadow.appendChild(style)

    const el = document.createElement('div')
    el.className = 'session-bar'
    board.appendChild(el)

    const miniEl = document.createElement('div')
    miniEl.className = 'm-sess'
    const miniTitle = document.createElement('div')
    miniTitle.className = 'ms-t'
    const scroller = document.createElement('div')
    scroller.className = 'ms-scroll'
    miniEl.append(miniTitle, scroller)
    // Flex child of `.mini`: the column lays out its own row, so it cannot
    // overlap `.m-top` above or `.m-bot` below.
    mini.insertBefore(miniEl, mini.querySelector('.m-bot'))
    return { board: el, mini: miniEl, miniTitle, scroller }
  }

  function shortLabel(session) {
    if (session.label) return `W·${String(session.label).slice(0, 8)}`
    const tag = session.sessionId ? 'S' : session.hubId ? 'H' : 'T'
    const id = String(session.id || '')
    return `${tag}·${id.slice(0, 8)}`
  }

  /** Full, untruncated name for the native hover tooltip. */
  function fullLabel(session) {
    const parts = []
    if (session.label) parts.push(session.label)
    if (session.sessionId) parts.push(`session ${session.sessionId}`)
    if (session.hubId) parts.push(`hub ${session.hubId}`)
    if (parts.length === 0) parts.push(String(session.id || ''))
    parts.push(`${session.agentCount} agent · ${session.toolCalls} tool`)
    return parts.join(' · ')
  }

  function chip(key, text, active, live, title) {
    const button = document.createElement('button')
    button.className = 'sb-c'
    button.dataset.on = active ? '1' : '0'
    button.title = title || text
    const dot = document.createElement('span')
    dot.className = `sb-d${live ? ' live' : ''}`
    const label = document.createElement('span')
    label.textContent = text
    button.append(dot, label)
    button.addEventListener('click', () => {
      selected = key
      if (latest !== null) apply(latest)
      if (ctrl !== null && latest !== null) ctrl.resync(filtered(latest))
    })
    return button
  }

  function renderBar(snapshot) {
    if (bars === null) return
    const sessions = snapshot.sessions || []
    // 0 or 1 session: there is nothing to switch between, so keep the control
    // off the screen instead of showing a redundant chip.
    if (sessions.length < 2) {
      barSignature = ''
      bars.board.classList.remove('on')
      bars.mini.classList.remove('on')
      return
    }
    const signature =
      sessions
        .map((session) => `${session.id}:${session.label || ''}:${session.agentCount}:${session.activeCount}:${session.toolCalls}`)
        .join('|') + `#${selected}`
    if (signature === barSignature) return
    barSignature = signature

    const totalAgents = sessions.reduce((sum, session) => sum + session.agentCount, 0)
    const totalTools = sessions.reduce((sum, session) => sum + session.toolCalls, 0)
    const anyLive = sessions.some((session) => session.activeCount > 0)
    const allTitle = `全部会话 · ${totalAgents} agent · ${totalTools} tool`

    // wide board: vertical chips carrying the per-session counts
    bars.board.textContent = ''
    const title = document.createElement('div')
    title.className = 'sb-t'
    title.textContent = `SESSION · ${sessions.length} 并行`
    bars.board.append(title, chip(null, `全部 · ${totalAgents} agent`, selected === null, anyLive, allTitle))
    for (const session of sessions) {
      const count = `${session.agentCount} agent · ${session.toolCalls} tool`
      bars.board.appendChild(
        chip(session.id, `${shortLabel(session)} · ${count}`, selected === session.id, session.activeCount > 0, fullLabel(session)),
      )
    }
    const hint = document.createElement('div')
    hint.className = 'sb-h'
    hint.textContent = '点击只看这一组 · 悬停看完整名称'
    bars.board.appendChild(hint)
    bars.board.classList.add('on')

    // narrow mini: a single scrollable row of compact chips
    const keepScroll = bars.scroller.scrollLeft
    bars.scroller.textContent = ''
    bars.miniTitle.textContent = `SESSION · ${sessions.length}`
    bars.scroller.appendChild(chip(null, '全部', selected === null, anyLive, allTitle))
    for (const session of sessions) {
      bars.scroller.appendChild(
        chip(session.id, shortLabel(session), selected === session.id, session.activeCount > 0, fullLabel(session)),
      )
    }
    bars.scroller.scrollLeft = keepScroll
    bars.mini.classList.add('on')
  }

  boot()
})()
