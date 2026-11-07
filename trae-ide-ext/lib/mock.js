/**
 * Mock replay: feeds the extension real hub-cache JSONL at an accelerated
 * pace, without bundling any private data into the extension package.
 *
 * The files are read at runtime from the user's own hub cache. If they are
 * absent, the mock reports "no data" and emits nothing — it never invents a
 * session.
 */

const fs = require('node:fs')
const path = require('node:path')
const { DEFAULT_ROOT, parseLine } = require('./hub-cache')

function listJsonl(root) {
  const out = []
  let hubs
  try {
    hubs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
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
        out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs })
      } catch {
        /* disappeared */
      }
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return out
}

function rowTimestamp(text) {
  try {
    const row = JSON.parse(text)
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
    if (data === null || typeof data !== 'object') return 0
    const candidates = [
      data.timing && data.timing.generated_at_ms,
      data.created_at,
      data.updated_at,
    ]
    for (const value of candidates) {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch {
    /* malformed line is skipped by parseLine anyway */
  }
  return 0
}

/**
 * @param {{ root?: string, speed?: number, onEvent?: (event: any) => void,
 *           onStatus?: (status: any) => void, now?: () => number }} [options]
 */
function createMockSource(options = {}) {
  const root = options.root || DEFAULT_ROOT
  const speed = Math.max(1, Number(options.speed) || 10)
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
  const now = options.now || (() => Date.now())

  /** @type {Array<{ text: string, at: number, file: string }>} */
  const rows = []
  const seenResults = new Set()
  const seenCalls = new Set()
  const seenLines = new Set()
  let timer = null
  let stopped = false
  let index = 0
  let emitted = 0

  function load() {
    const files = listJsonl(root)
    for (const file of files) {
      let text
      try {
        text = fs.readFileSync(file.path, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        rows.push({ text: line, at: rowTimestamp(line), file: file.path })
      }
    }
    return files
  }

  function step() {
    if (stopped) return
    if (index >= rows.length) {
      onStatus({
        state: 'mock',
        note: `回放完成 · ${emitted} 条事件 · 真实 hub cache`,
        done: true,
        files: 1,
      })
      return
    }
    const row = rows[index]
    index += 1
    const previous = rows[index - 2]
    let delta = 40
    if (row.at > 0 && previous !== undefined && previous.at > 0) {
      delta = row.at - previous.at
      if (delta < 0 || delta > 600) delta = 300
    }
    // Accelerate, but keep each step visible (at least 8ms).
    const delay = Math.max(8, Math.round(delta / speed))
    const parsed = parseLine(row.text, {
      replay: true,
      live: false,
      observedAt: now(),
      seenResults,
      seenCalls,
      seenLines,
    })
    for (const event of parsed) {
      onEvent(event)
      emitted += 1
    }
    timer = setTimeout(step, delay)
    timer.unref?.()
  }

  return {
    start() {
      if (timer !== null) return
      stopped = false
      const files = load()
      if (rows.length === 0) {
        onStatus({
          state: 'mock',
          note: `未找到真实 JSONL，未回放任何数据：${root}`,
          done: true,
          files: files.length,
        })
        return
      }
      onStatus({
        state: 'mock',
        note: `回放真实 hub cache · ${speed}× · ${rows.length} 行`,
        done: false,
        files: files.length,
      })
      step()
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    get progress() {
      return { index, total: rows.length, emitted }
    },
  }
}

module.exports = { createMockSource, listJsonl }
