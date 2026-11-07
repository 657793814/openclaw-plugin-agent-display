/**
 * Side-channel reader for Trae's hub event cache.
 *
 *   ~/.trae-cn/hub_event_cache/TraeCode/<hubId>/<messageId>.jsonl
 *
 * The file is append-only JSONL. Each line is
 *   { task_id, seq, type, data }
 * where `data` is a JSON *string* that must be parsed a second time.
 *
 * Privacy contract (enforced by construction, not by filtering afterwards):
 * only the keys listed below are ever read. `reasoning_content`, `thought`,
 * `user_message.content`, `params.old_string/new_string` and
 * `result.data.changes[].old_content/new_content` are never touched.
 *
 * Honesty contract: no descriptor is synthesised. A tool detail is a file
 * basename, a line range, or the model-written Shell description. Durations
 * are measured from observation time and stay 0 for cold-start history.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_ROOT = path.join(os.homedir(), '.trae-cn', 'hub_event_cache', 'TraeCode')
const LIVE_WINDOW_MS = 30_000

function basename(value) {
  const text = String(value || '').replace(/\\/gu, '/')
  const index = text.lastIndexOf('/')
  return index >= 0 ? text.slice(index + 1) : text
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function parseData(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function numberAt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Keep model-written one-liners, but turn any absolute path into a basename. */
function redactPaths(text) {
  return String(text || '').replace(/\/[^\s"'`;|&]+/gu, (match) => basename(match))
}

/** A one-line, privacy-safe description of what a tool is touching. */
function toolDetail(name, params) {
  const p = params !== null && typeof params === 'object' ? params : {}
  const tool = String(name || '')
  if (tool === 'Shell') {
    // `description` is the model-written one-liner; `command` is raw user shell
    // and is deliberately not read.
    const description = redactPaths(String(p.description || '').trim())
    if (description !== '') return truncate(description, 60)
    return basename(p.cwd) || 'shell'
  }
  if (tool === 'Read') {
    const file = basename(p.file_path)
    const offset = Number(p.offset)
    const limit = Number(p.limit)
    if (file === '') return ''
    if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
      return `${file}:${offset + 1}-${offset + limit}`
    }
    return file
  }
  if (tool === 'Grep') {
    return basename(p.path) || '.'
  }
  if (tool === 'Edit' || tool === 'Write') {
    return basename(p.file_path)
  }
  const file = basename(p.file_path || p.path)
  return file
}

function timeText(at) {
  const date = new Date(Number(at) || 0)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Parse one JSONL line into zero or more normalised events.
 *
 * @param {string} line
 * @param {{ live?: boolean, observedAt?: number, seenResults?: Set<string> }} [options]
 * @returns {Array<any>}
 */
function parseLine(line, options = {}) {
  const text = String(line || '').trim()
  if (text === '') return []
  let row
  try {
    row = JSON.parse(text)
  } catch {
    return []
  }
  if (row === null || typeof row !== 'object') return []
  const taskId = String(row.task_id || '')
  if (taskId === '') return []
  const seqKey = row.seq !== undefined ? `${taskId}:${row.seq}` : ''
  if (seqKey !== '' && options.seenLines instanceof Set) {
    if (options.seenLines.has(seqKey)) return []
    options.seenLines.add(seqKey)
  }
  const data = parseData(row.data)
  if (data === null) return []
  const observedAt = Number(options.observedAt) || Date.now()
  const resultSeen = options.seenResults instanceof Set ? options.seenResults : null
  const callSeen = options.seenCalls instanceof Set ? options.seenCalls : null
  const events = []

  switch (String(row.type || '')) {
    case 'metadata': {
      const sessionId = String(data.session_id || '')
      const turn = Number(data.message_index) || 0
      const agentName = String(data.agent_name || '')
      if (sessionId === '' && turn === 0) return []
      events.push({
        kind: 'session.start',
        at: numberAt(data.created_at) || observedAt,
        taskId,
        sessionId,
        turn,
        agentName,
      })
      return events
    }

    case 'model_config': {
      const model = String(data.config_name || data.model_name || '')
      if (model === '') return []
      events.push({
        kind: 'session.start',
        at: observedAt,
        taskId,
        model,
      })
      return events
    }

    case 'token_usage': {
      const inputTokens = Number(data.prompt_tokens)
      const outputTokens = Number(data.completion_tokens)
      if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return []
      events.push({
        kind: 'usage',
        at: observedAt,
        taskId,
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      })
      return events
    }

    case 'queuing': {
      const status = String(data.queue_status || '')
      if (status !== 'begin' && status !== 'end') return []
      events.push({
        kind: 'queue',
        at: observedAt,
        taskId,
        status,
        position: Number(data.position) || 0,
      })
      return events
    }

    case 'plan_item': {
      if (data.hide === true) return []
      const info = data.tool_call_info
      if (info === null || typeof info !== 'object') return []
      const name = String(info.name || '').trim()
      if (name === '') return []
      const callId = String(info.id || `${taskId}:${row.seq}`)
      const generatedAt = numberAt(data.timing && data.timing.generated_at_ms)
      // Mock replay uses the replay clock, not the original (days-old) timestamps.
      const startedAt = options.replay === true ? observedAt : generatedAt || observedAt
      const resultAt =
        options.replay === true || options.live === true ? observedAt : startedAt

      // CompactFake is context compaction, not a user-visible tool.
      if (name === 'CompactFake') {
        events.push({ kind: 'step.note', at: startedAt, taskId, text: '压缩上下文', phase: 'thinking' })
        return events
      }

      const detail = toolDetail(name, info.params)
      const result = info.result
      const resultStatus = String(result && result.status ? result.status : '')
      const failed = resultStatus !== '' && resultStatus !== 'success'

      const callKey = `${taskId}:${callId}`
      const alreadyCalled = callSeen !== null && callSeen.has(callKey)
      if (!alreadyCalled) {
        if (callSeen !== null) callSeen.add(callKey)
        events.push({
          kind: 'tool.call',
          at: startedAt,
          taskId,
          callId,
          name,
          detail,
        })
      }

      if (resultStatus !== '' && (resultSeen === null || !resultSeen.has(callKey))) {
        if (resultSeen !== null) resultSeen.add(`${taskId}:${callId}`)
        events.push({
          kind: 'tool.result',
          at: resultAt,
          taskId,
          callId,
          ok: !failed,
          error: truncate(result.error_message || '', 80),
        })
      }

      const agentStatus = String(data.agent_status && data.agent_status.status ? data.agent_status.status : '')
      if (agentStatus !== '' && agentStatus !== 'running') {
        events.push({
          kind: 'turn.end',
          at: resultAt,
          taskId,
          reason: agentStatus === 'completed' ? 'completed' : 'unknown',
        })
      }
      return events
    }

    default:
      // user_message / timing_events / context_usage / notification /
      // message_context_update / append_input are deliberately ignored.
      return []
  }
}

/**
 * Incremental tail of the hub event cache.
 *
 * @param {{ root?: string, onEvent?: (event: any) => void, onStatus?: (status: any) => void,
 *           now?: () => number, pollMs?: number }} [options]
 */
function createHubCacheSource(options = {}) {
  const root = options.root || DEFAULT_ROOT
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
  const now = options.now || (() => Date.now())
  const pollMs = Math.max(250, Number(options.pollMs) || 1000)

  /** @type {Map<string, { offset: number, ino: number, seenResults: Set<string>, seenCalls: Set<string>, seenLines: Set<string>, hydrated: boolean }>} */
  const files = new Map()
  let timer = null
  let watcher = null
  let stopped = false
  let lastAppendAt = 0
  let sawAnyFile = false
  let firstScanDone = false

  function listFiles() {
    const out = []
    let hubs
    try {
      hubs = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return null
    }
    for (const hub of hubs) {
      if (!hub.isDirectory()) continue
      const hubDir = path.join(root, hub.name)
      let entries
      try {
        entries = fs.readdirSync(hubDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const full = path.join(hubDir, entry.name)
        try {
          const stat = fs.statSync(full)
          // `hub.name` is the per-session directory under TraeCode/<hubId>/.
          // It is the only stable group id available before a metadata row is
          // parsed; it is NOT a project id.
          out.push({ path: full, hubId: hub.name, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs })
        } catch {
          /* file disappeared between readdir and stat */
        }
      }
    }
    out.sort((a, b) => a.mtimeMs - b.mtimeMs)
    return out
  }

  function readChunk(file, state) {
    let stat
    try {
      stat = fs.statSync(file.path)
    } catch {
      return false
    }
    if (stat.ino !== state.ino || stat.size < state.offset) {
      // Rotated, truncated or replaced: start over for this file.
      state.offset = 0
      state.ino = stat.ino
      state.seenResults.clear()
      state.seenCalls.clear()
      state.seenLines.clear()
      state.hydrated = false
    }
    if (stat.size <= state.offset) return false

    const length = stat.size - state.offset
    let buffer
    try {
      const fd = fs.openSync(file.path, 'r')
      try {
        buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, state.offset)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return false
    }

    const text = buffer.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline < 0) {
      // A half-written line: leave the offset where it is and retry later.
      return false
    }
    const complete = text.slice(0, lastNewline + 1)
    const lines = complete.split('\n')
    // A file that is being written right now is live from its first byte; old
    // history is hydrated without replaying animation timestamps.
    const observedAt = now()
    const live = state.hydrated || observedAt - (stat.mtimeMs || 0) < 120_000
    for (const line of lines) {
      if (line.trim() === '') continue
      const parsed = parseLine(line, {
        live,
        observedAt,
        seenResults: state.seenResults,
        seenCalls: state.seenCalls,
        seenLines: state.seenLines,
      })
      for (const event of parsed) {
        // Group attribution travels with every event so the store can keep
        // parallel sessions apart without re-reading the file path.
        event.hubId = file.hubId
        onEvent(event)
      }
    }
    state.offset += Buffer.byteLength(complete, 'utf8')
    state.hydrated = true
    lastAppendAt = Math.max(lastAppendAt, stat.mtimeMs || observedAt)
    return true
  }

  function emitStatus() {
    if (!firstScanDone) {
      onStatus({ state: 'starting', note: '正在扫描 hub_event_cache…', files: files.size })
      return
    }
    if (!fs.existsSync(root)) {
      onStatus({
        state: 'offline',
        note: `未找到 hub_event_cache：${root}`,
        files: 0,
        lastAppendAt: null,
      })
      return
    }
    if (!sawAnyFile) {
      onStatus({
        state: 'silent',
        note: 'hub_event_cache 为空 · 尚无会话事件（未确证实时性）',
        files: 0,
        lastAppendAt: null,
      })
      return
    }
    const age = now() - lastAppendAt
    if (age < LIVE_WINDOW_MS) {
      onStatus({
        state: 'live',
        note: '',
        files: files.size,
        lastAppendAt,
      })
      return
    }
    onStatus({
      state: 'silent',
      note: `未确证实时性 · hub cache 最近写入 ${timeText(lastAppendAt)}，本轮无新增`,
      files: files.size,
      lastAppendAt,
    })
  }

  function scan() {
    if (stopped) return
    const list = listFiles()
    if (list === null) {
      firstScanDone = true
      emitStatus()
      return
    }
    sawAnyFile = list.length > 0
    for (const file of list) {
      let state = files.get(file.path)
      if (state === undefined) {
        state = {
          offset: 0,
          ino: file.ino,
          seenResults: new Set(),
          seenCalls: new Set(),
          seenLines: new Set(),
          hydrated: false,
        }
        files.set(file.path, state)
      }
      if (file.size > state.offset) {
        readChunk(file, state)
      }
    }
    firstScanDone = true
    emitStatus()
  }

  return {
    start() {
      if (timer !== null || watcher !== null) return
      stopped = false
      scan()
      try {
        // macOS supports recursive watch; the interval below is the fallback.
        watcher = fs.watch(root, { recursive: true }, () => scan())
        watcher.on('error', () => {
          try {
            watcher.close()
          } catch {
            /* already closed */
          }
          watcher = null
        })
      } catch {
        watcher = null
      }
      timer = setInterval(scan, pollMs)
      timer.unref?.()
    },
    stop() {
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
      try {
        watcher?.close()
      } catch {
        /* already closed */
      }
      watcher = null
    },
    /** Force a scan (used by tests and the debug command). */
    scan,
    status() {
      return {
        root,
        files: [...files.keys()],
        lastAppendAt,
      }
    },
  }
}

module.exports = {
  DEFAULT_ROOT,
  LIVE_WINDOW_MS,
  basename,
  toolDetail,
  parseLine,
  createHubCacheSource,
}
