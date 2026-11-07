#!/usr/bin/env node
/**
 * 查询 NEBULA 作战大屏状态（不启动任何进程）。
 *
 *   node bin/status.mjs
 *   node bin/status.mjs --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { health, pidAlive, readState, LOG_FILE, PREFIX } from './runtime.mjs'

const require = createRequire(import.meta.url)
const { DEFAULT_ROOT } = require('../lib/hub-cache.js')
const { DEFAULT_CMD_ROOT, DEFAULT_LOG_ROOT } = require('../lib/live-source.js')

const asJson = process.argv.slice(2).includes('--json')

function walk(dir, depth, out) {
  if (depth > 3) return
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
  }
}

function scanHub() {
  const files = []
  walk(DEFAULT_ROOT, 0, files)
  let latestMs = null
  let latestPath = null
  for (const file of files) {
    try {
      const stat = fs.statSync(file)
      if (latestMs === null || stat.mtimeMs > latestMs) {
        latestMs = stat.mtimeMs
        latestPath = file
      }
    } catch {
      /* ignore */
    }
  }
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return {
    root: DEFAULT_ROOT,
    exists: fs.existsSync(DEFAULT_ROOT),
    files: files.length,
    latest: latestMs === null ? null : new Date(latestMs).toISOString(),
    latestPath,
    freshToday: latestMs !== null && latestMs >= startOfToday.getTime(),
  }
}

function scanLive() {
  let executions = 0
  let latestCmd = null
  let cmdEntries = []
  try {
    cmdEntries = fs.readdirSync(DEFAULT_CMD_ROOT, { withFileTypes: true })
  } catch {
    cmdEntries = []
  }
  for (const entry of cmdEntries) {
    if (!entry.isDirectory()) continue
    const file = path.join(DEFAULT_CMD_ROOT, entry.name, 'execution.json')
    try {
      const stat = fs.statSync(file)
      executions += 1
      if (latestCmd === null || stat.mtimeMs > latestCmd) latestCmd = stat.mtimeMs
    } catch {
      /* not an execution dir */
    }
  }
  let latestLog = null
  let latestLaunch = ''
  try {
    const launches = fs.readdirSync(DEFAULT_LOG_ROOT, { withFileTypes: true })
    for (const entry of launches) {
      if (entry.isDirectory() && /^\d{8}T\d{6}$/u.test(entry.name) && entry.name > latestLaunch) {
        latestLaunch = entry.name
      }
    }
  } catch {
    latestLaunch = ''
  }
  if (latestLaunch !== '') {
    let windows = []
    try {
      windows = fs.readdirSync(path.join(DEFAULT_LOG_ROOT, latestLaunch), { withFileTypes: true })
    } catch {
      windows = []
    }
    for (const dir of windows) {
      if (!dir.isDirectory() || !/^window\d+$/u.test(dir.name)) continue
      let files = []
      try {
        files = fs.readdirSync(path.join(DEFAULT_LOG_ROOT, latestLaunch, dir.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile() || !/^renderer[\w.-]*\.log$/u.test(file.name)) continue
        try {
          const stat = fs.statSync(path.join(DEFAULT_LOG_ROOT, latestLaunch, dir.name, file.name))
          if (latestLog === null || stat.mtimeMs > latestLog) latestLog = stat.mtimeMs
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    cmdRoot: DEFAULT_CMD_ROOT,
    executions,
    latestCmd: latestCmd === null ? null : new Date(latestCmd).toISOString(),
    logRoot: DEFAULT_LOG_ROOT,
    latestLaunch: latestLaunch || null,
    latestLog: latestLog === null ? null : new Date(latestLog).toISOString(),
  }
}

const state = readState()
const running = Boolean(state && pidAlive(state.pid) && (await health(state.port)))
const hubCache = scanHub()
const liveSource = scanLive()

const payload = {
  running,
  runtime: running
    ? {
        pid: state.pid,
        port: state.port,
        url: state.url,
        startedAt: state.startedAt,
        uptimeMs: state.startedAt ? Date.now() - state.startedAt : null,
      }
    : null,
  hubCache,
  liveSource,
  log: LOG_FILE,
}

if (running) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}${PREFIX}/api/state?token=${encodeURIComponent(state.token)}`, {
      signal: AbortSignal.timeout(1200),
    })
    const snapshot = await res.json()
    payload.source = snapshot.source || null
    payload.agents = Array.isArray(snapshot.agents) ? snapshot.agents.length : 0
    payload.events = Array.isArray(snapshot.events) ? snapshot.events.length : 0
  } catch (error) {
    payload.source = { state: 'unknown', note: `读取 /api/state 失败: ${error}` }
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(0)
}

const lines = []
lines.push(running ? `大屏运行中：${state.url}` : '大屏未运行')
if (running) {
  lines.push(`端口 ${state.port}  PID ${state.pid}`)
  const source = payload.source || {}
  const kind = String(source.kind || 'unknown')
  lines.push(`数据源：${source.state || 'unknown'} · kind=${kind}${source.note ? ` · ${source.note}` : ''}`)
  if (hubCache.freshToday) {
    lines.push(`hub cache：今日有写入（最近 ${hubCache.latest}，共 ${hubCache.files} 个 jsonl）`)
  } else {
    lines.push(`hub cache：今日无新写入（最近 ${hubCache.latest || '无'}，共 ${hubCache.files} 个 jsonl）`)
  }
  lines.push(
    `本地实时源：命令执行 ${liveSource.executions} 条（最近 ${liveSource.latestCmd || '无'}）· renderer 日志 ${liveSource.latestLog || '无'}`,
  )
  if (source.state === 'silent' && kind === 'hub_cache') {
    lines.push('→ 大屏显示 SILENT（hub cache 无写入）')
  } else if (source.state === 'silent' && kind === 'live_local') {
    lines.push('→ 大屏显示 SILENT（本地实时源 30s 内无新活动，不是故障）')
  }
} else {
  lines.push(
    hubCache.freshToday
      ? `hub cache：今日有写入（最近 ${hubCache.latest}）`
      : `hub cache：今日无新写入（最近 ${hubCache.latest || '无'}）`,
  )
  lines.push('启动：node bin/start.mjs --open')
}
process.stdout.write(`${lines.join('\n')}\n`)
