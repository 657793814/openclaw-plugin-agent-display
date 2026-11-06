/**
 * dev/mock-host.mjs — runs the real plugin `apply()` against a tiny cordis-like
 * surface, without starting the harness.
 *
 * It exists to prove three things end to end:
 *   1. the plugin's subscriptions and HTTP routes work;
 *   2. the injected script renders a HUD identical to what the desktop shell
 *      would get from `webserver/index-inject`;
 *   3. every phase (idle/thinking/tool/done/failed/waiting) can be driven from
 *      the same event payloads the harness emits.
 *
 * Usage: node dev/mock-host.mjs [port]
 */
import http from 'node:http'

import { apply } from '../index.js'

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 17817)

// ---------- tiny cordis surface ----------
const handlers = new Map()
const routes = new Map()
const cleanups = []

function on(event, handler) {
  const list = handlers.get(event) ?? []
  list.push(handler)
  handlers.set(event, list)
  return () => {
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }
}

function effect(setup) {
  const dispose = setup()
  if (typeof dispose === 'function') cleanups.push(dispose)
  return dispose
}

function emit(event, ...args) {
  for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
}

const child = {
  effect,
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

const ctx = {
  logger: {
    warn: (message) => console.warn(message),
    info: () => {},
  },
  on(event, handler) {
    // `apply` passes { global: true }; the mock ignores options on purpose —
    // the harness is the only thing that scopes events.
    return on(event, handler)
  },
  effect,
  inject(_deps, callback) {
    callback(child)
  },
}

apply(ctx)

// ---------- demo agent + simulator ----------
const agent = { id: 'main-agent', session: { id: 'sess-demo-01' } }
const session = { id: 'sess-demo-01' }
// Extra agents only used by /demo/multi to exercise the galaxy theme.
const scout = { id: 'scout-agent', session: { id: 'sess-scout-01' } }
const proof = { id: 'proof-agent', session: { id: 'sess-proof-01' } }
let turn = 0
let mode = 'auto'
let epoch = 0
let manualTimer = null
// Verification helper: 503 + drop SSE to exercise offline/offline→reconnect.
let blackout = false
const sseClients = new Set()
// Running calls created by /demo/multi, so /demo/settle can finish them.
let multiCalls = []

function agentStatus(status) {
  emit('agent/status', { agent, status })
}

function statusFor(target, status) {
  emit('agent/status', { agent: target, status })
}

function event(type, data) {
  emit('session/event', session, { type, data, time: Date.now(), seq: 0 })
}

function eventFor(target, type, data) {
  emit('session/event', target.session, { type, data, time: Date.now(), seq: 0 })
}

function frame(type) {
  emit('agent/assistant-stream', { agent, frame: { type } })
}

function frameFor(target, type) {
  emit('agent/assistant-stream', { agent: target, frame: { type } })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assertAuto() {
  return mode === 'auto'
}

async function cycle() {
  while (true) {
    const stamp = epoch
    if (!assertAuto() || epoch !== stamp) {
      await sleep(1200)
      continue
    }
    agentStatus('idle')
    await sleep(1800)
    if (!assertAuto() || epoch !== stamp) continue

    turn += 1
    agentStatus('running')
    event('turn/start', { turn })
    await sleep(500)
    event('step/start', { turn, step: 1 })
    frame('start')
    await sleep(1800)
    frame('end')

    if (!assertAuto() || epoch !== stamp) continue
    event('tool/call', {
      turn,
      step: 1,
      callId: 'call-demo-1',
      name: 'bash',
      arguments: JSON.stringify({ description: '检查工作区状态', command: 'git status --short' }),
    })
    await sleep(2200)
    event('tool/result', { turn, step: 1 })
    frame('start')
    await sleep(900)
    frame('end')
    event('assistant/message', {
      turn,
      step: 1,
      message: {},
      stream: [],
      usage: { inputTokens: 1180, outputTokens: 240 },
    })
    event('turn/end', { turn, reason: { kind: 'completed' } })
    await sleep(3200)
  }
}

function manual(phase) {
  mode = 'manual'
  epoch += 1
  if (manualTimer !== null) clearTimeout(manualTimer)
  manualTimer = setTimeout(() => {
    mode = 'auto'
    manualTimer = null
  }, 20_000)
  manualTimer.unref?.()
  drive(phase)
}

function drive(phase) {
  switch (phase) {
    case 'idle':
      event('turn/end', { turn, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
      agentStatus('idle')
      return
    case 'thinking':
      turn += 1
      agentStatus('running')
      event('turn/start', { turn })
      event('step/start', { turn, step: 1 })
      frame('start')
      frame('chunk')
      frame('chunk')
      return
    case 'tool':
      agentStatus('running')
      event('tool/call', {
        turn: turn || 1,
        step: 1,
        callId: 'call-demo-manual',
        name: 'read_file',
        arguments: JSON.stringify({ file_path: 'src/runtime/agent-loop.ts' }),
      })
      return
    case 'waiting':
      event('approval/asked', { id: 'ap-1', toolName: 'bash', callId: 'call-demo-manual', reason: '需要写入工作区' })
      return
    case 'done':
      event('tool/result', { turn, step: 1 })
      event('turn/end', { turn, reason: { kind: 'completed' } })
      return
    case 'failed':
      event('turn/end', {
        turn,
        reason: { kind: 'error', error: { name: 'provider', message: 'AGENTS_AI_API_KEY 未配置' } },
      })
      return
    default:
      return
  }
}

/**
 * Three real agents with different phases, built from the same event payloads
 * the harness emits. Used to verify the galaxy theme's node/edge/tool mapping.
 */
function multiDemo() {
  mode = 'manual'
  epoch += 1
  if (manualTimer !== null) clearTimeout(manualTimer)
  manualTimer = null

  emit('agent/created', { agent: scout })
  emit('agent/created', { agent: proof })
  turn += 1

  // main: running bash → colour node + running tool satellite
  statusFor(agent, 'running')
  eventFor(agent, 'turn/start', { turn })
  eventFor(agent, 'step/start', { turn, step: 1 })
  eventFor(agent, 'request/header', {
    header: { config: { provider: 'agnes', model: 'agnes-2.5-flash' } },
  })
  const bashCall = `call-multi-${Date.now()}`
  eventFor(agent, 'tool/call', {
    turn,
    step: 1,
    callId: bashCall,
    name: 'bash',
    arguments: JSON.stringify({ description: '核对 worktree 状态', command: 'git status --short' }),
  })
  multiCalls = [{ target: agent, turn, id: bashCall }]

  // scout: pure thinking, never gets a tool node
  statusFor(scout, 'running')
  eventFor(scout, 'turn/start', { turn: 1 })
  eventFor(scout, 'step/start', { turn: 1, step: 1 })
  frameFor(scout, 'start')
  frameFor(scout, 'chunk')

  // proof: tool running while waiting for approval (waiting phase)
  statusFor(proof, 'running')
  eventFor(proof, 'turn/start', { turn: 1 })
  eventFor(proof, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-proof-1',
    name: 'write_file',
    arguments: JSON.stringify({ file_path: 'docs/big-screen.md' }),
  })
  eventFor(proof, 'approval/asked', {
    id: 'ap-galaxy',
    toolName: 'write_file',
    callId: 'call-proof-1',
    reason: '需要写入文档',
  })
  multiCalls.push({ target: proof, turn: 1, id: 'call-proof-1' })
}

/** Finish every call opened by /demo/multi →阶段 done →主题进入「收工」. */
function settleDemo() {
  for (const call of multiCalls) {
    eventFor(call.target, 'tool/result', {
      turn: call.turn,
      step: 1,
      callId: call.id,
      result: 'ok',
    })
    eventFor(call.target, 'turn/end', { turn: call.turn, reason: { kind: 'completed' } })
    statusFor(call.target, 'idle')
  }
  multiCalls = []
}

/** Trigger one real tool call on the selected agent to prove a pulse + result. */
function pulseDemo(target = agent) {
  mode = 'manual'
  epoch += 1
  if (manualTimer !== null) clearTimeout(manualTimer)
  manualTimer = null
  const callId = `call-pulse-${Date.now()}`
  const current = Math.max(1, turn)
  eventFor(target, 'tool/call', {
    turn: current,
    step: 1,
    callId,
    name: 'read_file',
    arguments: JSON.stringify({ file_path: 'README.md' }),
  })
  setTimeout(() => {
    eventFor(target, 'tool/result', { turn: current, step: 1, callId, result: 'read 42 lines' })
  }, 900)
}

// MOCK_AUTO=0 keeps the store empty so the big screen's no-agent state can be
// verified without inventing data.
if (process.env.MOCK_AUTO !== '0') void cycle()

// ---------- injection ----------
const table = []
emit('webserver/index-inject', table)
const injected = table
  .filter((row) => row.kind === 'script')
  .map((row) => row.text)
  .join('\n')

// ---------- preview page ----------
function previewPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-agent-status · 预览</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; }
  body {
    margin: 0; background: #07080d; color: #eef0f7;
    font: 13px/1.55 "JetBrains Mono","PingFang SC",system-ui,sans-serif;
  }
  .backdrop { position: fixed; inset: 0; display: grid; grid-template-rows: 46px 1fr auto; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 0 16px; border-bottom: 1px solid #1b1e2a; color: #73788e; font-size: 10px; letter-spacing: .14em; }
  .bar b { color: #eef0f7; letter-spacing: .08em; }
  .bar .sp { flex: 1; }
  .bar .tag { border: 1px solid #262a39; padding: 3px 6px; border-radius: 2px; }
  .chat { max-width: 720px; margin: 0 auto; padding: 26px 22px 120px; display: grid; gap: 14px; content-visibility: auto; }
  .msg { border-left: 2px solid #262a39; padding: 8px 12px; color: #b8bccb; background: rgba(10,11,16,.7); }
  .msg.me { border-left-color: #45e6f5; color: #eef0f7; }
  .msg small { display: block; color: #454a5e; font-size: 9px; letter-spacing: .14em; margin-bottom: 4px; }
  .ghost { height: 12px; width: 70%; background: #10121a; border-radius: 2px; }
  .ghost + .ghost { margin-top: 8px; width: 44%; }
  .demo { position: fixed; left: 16px; bottom: 14px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .demo span { font-size: 9px; letter-spacing: .12em; color: #454a5e; margin-right: 4px; }
  .demo button {
    font: 700 10px/1 "JetBrains Mono",monospace; letter-spacing: .08em;
    color: #b8bccb; background: #0b0c12; border: 1px solid #262a39; border-radius: 3px;
    padding: 7px 9px; cursor: pointer;
  }
  .demo button:hover { color: #45e6f5; border-color: #45e6f5; }
  .demo button:focus-visible { outline: 2px solid #45e6f5; outline-offset: 2px; }
  .hint { position: fixed; right: 18px; bottom: 2px; font-size: 9px; color: #454a5e; }
</style>
</head>
<body>
  <div class="backdrop">
    <div class="bar"><b>DEEPSEEK HARNESS</b><span>·</span><span>sess-demo-01</span><span class="sp"></span><span class="tag">mock host</span></div>
    <div class="chat">
      <div class="msg me"><small>USER</small>帮我检查一下工作区，然后把状态汇报出来。</div>
      <div class="msg"><small>ASSISTANT</small>正在读取仓库状态…<div class="ghost"></div><div class="ghost"></div></div>
      <div class="msg"><small>TOOL · bash</small>git status --short</div>
      <div class="msg"><small>ASSISTANT</small><div class="ghost"></div><div class="ghost"></div><div class="ghost"></div></div>
    </div>
  </div>
  <div class="demo">
    <span>DEMO</span>
    <button data-phase="idle">空闲</button>
    <button data-phase="thinking">思考</button>
    <button data-phase="tool">调工具</button>
    <button data-phase="waiting">等确认</button>
    <button data-phase="done">完成</button>
    <button data-phase="failed">失败</button>
    <button data-phase="auto">自动循环</button>
  </div>
  <div class="hint">HUD 由 webserver/index-inject 注入 · 只读</div>
  <script>
    document.querySelectorAll('.demo button').forEach((button) => {
      button.addEventListener('click', () => {
        fetch('/demo/' + button.dataset.phase).catch(() => {})
      })
    })
  </script>
  <script>${injected}</script>
</body>
</html>`
}

// ---------- http ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const pathname = url.pathname

  if (pathname === '/' || pathname === '/index.html') {
    const html = previewPage()
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(html)
    return
  }

  if (pathname.startsWith('/demo/')) {
    const phase = pathname.slice('/demo/'.length)
    if (phase === 'multi') {
      multiDemo()
    } else if (phase === 'pulse') {
      pulseDemo(agent)
    } else if (phase === 'settle') {
      settleDemo()
    } else if (phase === 'blackout') {
      blackout = true
      for (const client of sseClients) client.destroy()
      sseClients.clear()
    } else if (phase === 'blackout-off') {
      blackout = false
    } else if (phase === 'auto') {
      mode = 'auto'
      epoch += 1
    } else {
      manual(phase)
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, phase }))
    return
  }

  if (blackout && pathname.startsWith('/dsh-agent-status/')) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'maintenance' }))
    return
  }

  const handler = routes.get(pathname)
  if (handler !== undefined) {
    if (pathname.endsWith('/stream')) {
      sseClients.add(res)
      res.on('close', () => sseClients.delete(res))
    }
    handler(req, res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent-status] mock host ready: http://127.0.0.1:${PORT}/`)
  console.log(`[agent-status] state:  http://127.0.0.1:${PORT}/dsh-agent-status/api/state`)
  console.log(`[agent-status] stream: http://127.0.0.1:${PORT}/dsh-agent-status/stream`)
})

function shutdown() {
  for (const dispose of cleanups) {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
