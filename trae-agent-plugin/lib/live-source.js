/**
 * Local real-time source for the NEBULA screen.
 *
 * The hub event cache (`~/.trae-cn/hub_event_cache/TraeCode/<hubId>/`) is
 * written by the native Hub bridge, which is only active when Trae's cloud/Hub
 * channel is connected. On a plain local install the directory is created but
 * stays empty forever, so this source reads two ordinary local files instead:
 *
 *   1. `ModularData/ai-agent/command-execution/<executionId>/execution.json`
 *      — one live record per shell/tool execution (status, cwd, pid, exit code,
 *      timestamps). It never contains the command text, so the screen shows
 *      `Shell · pid <n>` and the workspace basename; nothing is invented.
 *
 *   2. `logs/<launch>/window<N>/renderer.log`
 *      — `[ASSISTANT-DEBUG] chat stream received <rpc> plan_item {json}` rows
 *      carry sessionId / task_id / toolCallName / agent_display_name /
 *      agent_status. They give the screen real chat-session attribution.
 *
 * Privacy: only the fields documented above are read. `database.db` and Trae
 * private IPC are not touched.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN')
const DEFAULT_CMD_ROOT = path.join(APP_DATA, 'ModularData', 'ai-agent', 'command-execution')
const DEFAULT_LOG_ROOT = path.join(APP_DATA, 'logs')

const LIVE_WINDOW_MS = 30_000
const HYDRATE_MS = 15 * 60_000
const LAUNCH_DIR_RE = /^\d{8}T\d{6}$/u

function basename(value) {
  const text = String(value || '').replace(/\\/gu, '/')
  const index = text.lastIndexOf('/')
  return index >= 0 ? text.slice(index + 1) : text
}

function numberAt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Incremental tail of the local Trae runtime.
 *
 * @param {{ cmdRoot?: string, logRoot?: string, onEvent?: (event: any) => void,
 *           onStatus?: (status: any) => void, now?: () => number,
 *           pollMs?: number }} [options]
 */
function createLiveSource(options = {}) {
  const cmdRoot = options.cmdRoot || DEFAULT_CMD_ROOT
  const logRoot = options.logRoot || DEFAULT_LOG_ROOT
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
  const now = options.now || (() => Date.now())
  const pollMs = Math.max(250, Number(options.pollMs) || 1000)
  // Events older than this are history, not live activity. `sinceMs` lets the
  // caller start a fallback source at "now" so a hub→live switch does not
  // replay (and double count) the last 15 minutes.
  const hydrateFrom = Math.max(now() - HYDRATE_MS, numberAt(options.sinceMs))
  const MISSING_GRACE_MS = Math.max(3000, pollMs * 3)
  // A fresh process only reads the tail of an old renderer.log; scanning
  // megabytes of history on the first poll used to spike CPU.
  const MAX_INITIAL_READ = 2_000_000

  function initialOffset(file, size) {
    if (size <= MAX_INITIAL_READ) return 0
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const chunk = Buffer.alloc(64 * 1024)
        fs.readSync(fd, chunk, 0, chunk.length, size - MAX_INITIAL_READ)
        const text = chunk.toString('utf8')
        const newline = text.indexOf('\n')
        if (newline < 0) return size
        return size - MAX_INITIAL_READ + Buffer.byteLength(text.slice(0, newline + 1), 'utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return size
    }
  }

  /** @type {Map<string, { status: string, cwd: string, groupId: string, label: string, callEmitted: boolean, resultEmitted: boolean, lastSeenAt: number, missingSince: number }>} */
  const executions = new Map()
  /** @type {Map<string, { offset: number, ino: number }>} */
  const logFiles = new Map()
  const planTasks = new Set()
  /** callKey -> taskId, for calls whose result never arrived. */
  const pendingCalls = new Map()
  const planResults = new Set()
  const skipped = new Set()
  const workspaceStarted = new Set()

  let timer = null
  let stopped = false
  let firstScanDone = false
  let lastActivityAt = 0
  let activeLaunch = ''
  let commandCount = 0
  let planCount = 0
  let cmdUnreadable = false

  function touch(at) {
    const stamp = numberAt(at) || now()
    lastActivityAt = Math.max(lastActivityAt, stamp)
  }

  // ------------------------------------------------------------- commands
  /**
   * Close an execution whose record is unusable so the store never keeps it
   * "running". A call that was emitted without a result gets a synthetic
   * failure; the agent finishes instead of hanging forever.
   */
  function abandon(state, id, reason) {
    if (state.callEmitted && !state.resultEmitted) {
      state.resultEmitted = true
      onEvent({
        kind: 'tool.result',
        at: now(),
        taskId: state.groupId,
        callId: id,
        ok: false,
        error: reason,
      })
      touch(now())
    }
    state.status = 'failed'
    state.lastSeenAt = now()
  }

  function scanCommands() {
    let entries
    try {
      entries = fs.readdirSync(cmdRoot, { withFileTypes: true })
      cmdUnreadable = false
    } catch {
      cmdUnreadable = true
      return false
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      if (skipped.has(id)) continue
      const known = executions.get(id)
      if (known !== undefined && known.status !== 'running') continue
      const file = path.join(cmdRoot, id, 'execution.json')
      let statMtime = 0
      if (known === undefined) {
        // History is only hydrated for the recent window; older executions are
        // skipped so the board does not fill with hundreds of dead agents.
        try {
          statMtime = fs.statSync(file).mtimeMs
        } catch {
          skipped.add(id)
          continue
        }
      }
      const record = readJson(file)
      if (record === null) {
        if (known === undefined) {
          skipped.add(id)
          continue
        }
        // The record was readable before (possibly mid-run) and vanished now.
        // Give it a grace window for atomic rewrites, then close the call so
        // the agent cannot stay "running" forever on a dead record.
        if (now() - known.lastSeenAt <= HYDRATE_MS) {
          if (known.missingSince === 0) known.missingSince = now()
          if (now() - known.missingSince < MISSING_GRACE_MS) continue
        }
        abandon(known, id, 'execution record unavailable')
        continue
      }
      const cwd = String(record.cwd || '')
      if (cwd === '') {
        if (known === undefined) {
          skipped.add(id)
        } else {
          abandon(known, id, 'execution record has no cwd')
        }
        continue
      }
      const status = String(record.status || '')
      const createdAt = numberAt(record.createdAtMs) || now()
      if (!(known !== undefined && (status === 'running' || !known.resultEmitted)) && now() - createdAt > HYDRATE_MS) {
        skipped.add(id)
        continue
      }
      if (known === undefined && createdAt < hydrateFrom) {
        skipped.add(id)
        continue
      }
      if (known === undefined && statMtime !== 0 && statMtime < hydrateFrom) {
        skipped.add(id)
        continue
      }
      const groupId = `ws:${cwd}`
      const label = basename(cwd) || 'workspace'

      if (known === undefined) {
        commandCount += 1
        // One workspace = one agent: start the agent once, then append calls.
        if (!workspaceStarted.has(groupId)) {
          workspaceStarted.add(groupId)
          onEvent({
            kind: 'session.start',
            at: createdAt,
            taskId: groupId,
            groupId,
            groupLabel: label,
            agentName: label,
          })
        }
        touch(createdAt)
        executions.set(id, {
          status: '',
          cwd,
          groupId,
          label,
          callEmitted: false,
          resultEmitted: false,
          lastSeenAt: now(),
          missingSince: 0,
        })
      }
      const state = executions.get(id)
      state.lastSeenAt = now()
      state.missingSince = 0

      if (status === 'running' && !state.callEmitted) {
        state.callEmitted = true
        onEvent({
          kind: 'tool.call',
          at: numberAt(record.startedAtMs) || createdAt,
          taskId: state.groupId,
          callId: id,
          name: 'Shell',
          detail: `pid ${Number(record.pid) || '?'}`,
        })
        touch(record.startedAtMs || createdAt)
      }

      if ((status === 'exited' || status === 'failed') && !state.resultEmitted) {
        if (!state.callEmitted) {
          state.callEmitted = true
          onEvent({
            kind: 'tool.call',
            at: numberAt(record.startedAtMs) || createdAt,
            taskId: state.groupId,
            callId: id,
            name: 'Shell',
            detail: `pid ${Number(record.pid) || '?'}`,
          })
        }
        state.resultEmitted = true
        const code = Number(record.exitCode)
        const ok = Number.isFinite(code)
          ? code === 0
          : String(record.terminalReason || '') === 'process_exited'
        const finishedAt = numberAt(record.finishedAtMs) || now()
        onEvent({
          kind: 'tool.result',
          at: finishedAt,
          taskId: state.groupId,
          callId: id,
          ok,
          error: ok ? '' : `exit ${Number.isFinite(code) ? code : record.terminalReason || 'failed'}`,
        })
        touch(finishedAt)
      }

      state.status = status
      state.cwd = cwd
    }
    return true
  }

  // ------------------------------------------------------------ renderer
  /** A new Trae launch starts new logs: close calls that will never report. */
  function closePendingCalls(reason) {
    for (const [callKey, taskId] of pendingCalls) {
      onEvent({
        kind: 'tool.result',
        at: now(),
        taskId,
        callId: callKey,
        ok: false,
        error: reason,
      })
    }
    pendingCalls.clear()
    planResults.clear()
  }

  function resolveLaunch() {
    let entries
    try {
      entries = fs.readdirSync(logRoot, { withFileTypes: true })
    } catch {
      return false
    }
    let latest = ''
    for (const entry of entries) {
      if (!entry.isDirectory() || !LAUNCH_DIR_RE.test(entry.name)) continue
      if (entry.name > latest) latest = entry.name
    }
    if (latest !== activeLaunch) {
      if (activeLaunch !== '') closePendingCalls('log launch changed before result')
      activeLaunch = latest
      logFiles.clear()
    }
    return true
  }

  function logCandidates() {
    const out = []
    if (activeLaunch === '') return out
    const root = path.join(logRoot, activeLaunch)
    let windows
    try {
      windows = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const dir of windows) {
      if (!dir.isDirectory() || !/^window\d+$/u.test(dir.name)) continue
      const full = path.join(root, dir.name)
      let files
      try {
        files = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !/^renderer[\w.-]*\.log$/u.test(file.name)) continue
        out.push(path.join(full, file.name))
      }
    }
    return out
  }

  function parsePlanLine(line) {
    const hit = line.indexOf('chat stream received ')
    if (hit < 0) return null
    const rest = line.slice(hit + 'chat stream received '.length)
    const planAt = rest.indexOf(' plan_item ')
    if (planAt < 0) return null
    const rpc = rest.slice(0, planAt).trim()
    const jsonAt = rest.indexOf('{', planAt)
    if (jsonAt < 0) return null
    try {
      const data = JSON.parse(rest.slice(jsonAt))
      return { rpc, data }
    } catch {
      return null
    }
  }

  function emitPlan(rpc, data, lineAt) {
    const taskId = String(data.task_id || '')
    if (taskId === '') return
    const sessionId = String(data.sessionId || data.targetSessionId || '')
    const generatedAt = numberAt(data.timing && data.timing.generated_at_ms) || lineAt
    if (generatedAt < hydrateFrom) return
    const agentName = String(data.agent_display_name || data.agent_id || '')
    const groupTask = `plan:${taskId}`
    const planId = String(data.planItemId || '')
    if (!planTasks.has(groupTask)) {
      planTasks.add(groupTask)
      planCount += 1
      onEvent({
        kind: 'session.start',
        at: generatedAt,
        taskId: groupTask,
        sessionId,
        agentName,
      })
      touch(generatedAt)
    }
    if (planId === '') return
    const callKey = `${groupTask}:${planId}`
    const name = String(data.toolCallName || rpc || '').trim()
    const info = data.tool_call_info
    const resultStatus = String((info && info.result && info.result.status) || '')
    if (name !== '' && !pendingCalls.has(callKey)) {
      pendingCalls.set(callKey, groupTask)
      onEvent({
        kind: 'tool.call',
        at: generatedAt,
        taskId: groupTask,
        callId: callKey,
        name,
      })
      touch(generatedAt)
    }
    if (resultStatus !== '' && pendingCalls.has(callKey) && !planResults.has(callKey)) {
      planResults.add(callKey)
      pendingCalls.delete(callKey)
      onEvent({
        kind: 'tool.result',
        at: generatedAt,
        taskId: groupTask,
        callId: callKey,
        ok: resultStatus === 'success',
        error: resultStatus === 'success' ? '' : resultStatus,
      })
      touch(generatedAt)
    }
  }

  function readLogFile(file) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    let state = logFiles.get(file)
    if (state === undefined) {
      state = { offset: initialOffset(file, stat.size), ino: stat.ino }
      logFiles.set(file, state)
    }
    if (stat.ino !== state.ino || stat.size < state.offset) {
      state.offset = initialOffset(file, stat.size)
      state.ino = stat.ino
    }
    if (stat.size <= state.offset) return
    const length = stat.size - state.offset
    let buffer
    try {
      const fd = fs.openSync(file, 'r')
      try {
        buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, state.offset)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    const text = buffer.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) return
    const complete = text.slice(0, lastNewline + 1)
    for (const line of complete.split('\n')) {
      if (line === '') continue
      const parsed = parsePlanLine(line)
      if (parsed === null) continue
      const stamp = line.slice(0, line.indexOf(' ['))
      const lineAt = Number(Date.parse(stamp)) || now()
      emitPlan(parsed.rpc, parsed.data, lineAt)
    }
    state.offset += Buffer.byteLength(complete, 'utf8')
  }

  function scanLogs() {
    if (!resolveLaunch()) return false
    for (const file of logCandidates()) readLogFile(file)
    return true
  }

  // -------------------------------------------------------------- status
  /** Finished executions older than the hydration window are dead weight. */
  function prune(nowMs) {
    for (const [id, state] of executions) {
      if (state.status !== 'running' && nowMs - state.lastSeenAt > HYDRATE_MS) {
        executions.delete(id)
      }
    }
  }

  function runningCount() {
    let count = 0
    for (const state of executions.values()) {
      if (state.status === 'running') count += 1
    }
    return count
  }

  function emitStatus(hasCmd, hasLog) {
    if (!firstScanDone) {
      onStatus({ state: 'starting', kind: 'live_local', note: '正在扫描本地运行数据…', files: 0, lastAppendAt: null })
      return
    }
    if (!hasCmd && !hasLog) {
      onStatus({
        state: 'offline',
        kind: 'live_local',
        note: cmdUnreadable
          ? `命令目录不可读（路径不存在或无权限）：${cmdRoot}`
          : `未找到本地运行数据：${cmdRoot}`,
        files: 0,
        lastAppendAt: null,
      })
      return
    }
    const status = {
      kind: 'live_local',
      state:
        (lastActivityAt > 0 && now() - lastActivityAt < LIVE_WINDOW_MS) || runningCount() > 0
          ? 'live'
          : 'silent',
      note:
        (cmdUnreadable ? `命令目录不可读：${cmdRoot} · ` : '') +
        (lastActivityAt === 0
          ? '本地实时源暂无活动 · 等待新的命令执行或会话事件'
          : `本地实时源 · 命令执行 ${commandCount} 条（运行中 ${runningCount()}）· 会话事件 ${planCount} 条`),
      files: commandCount + planCount,
      lastAppendAt: lastActivityAt || null,
      roots: { commands: cmdRoot, logs: logRoot },
    }
    onStatus(status)
  }

  function poll() {
    if (stopped) return
    const hasCmd = scanCommands()
    const hasLog = scanLogs()
    prune(now())
    firstScanDone = true
    emitStatus(hasCmd, hasLog)
  }

  return {
    kind: 'live_local',
    start() {
      if (timer !== null) return
      poll()
      timer = setInterval(poll, pollMs)
      if (typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}

module.exports = { createLiveSource, DEFAULT_CMD_ROOT, DEFAULT_LOG_ROOT, LIVE_WINDOW_MS }
