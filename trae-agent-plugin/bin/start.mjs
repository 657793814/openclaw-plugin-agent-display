#!/usr/bin/env node
/**
 * 启动 NEBULA 作战大屏（幂等）。
 *
 *   node bin/start.mjs            # 已运行则复用，未运行则拉起
 *   node bin/start.mjs --open     # 启动/复用后打开浏览器
 *   node bin/start.mjs --json     # 只输出 JSON，便于 agent 解析
 */
import { spawn } from 'node:child_process'
import path from 'node:path'

import {
  PLUGIN_ROOT,
  STATE_FILE,
  VERSION,
  health,
  pidAlive,
  readState,
  clearState,
  sleep,
  LOG_FILE,
} from './runtime.mjs'

const argv = process.argv.slice(2)
const wantOpen = argv.includes('--open')
const asJson = argv.includes('--json')

function openUrl(url) {
  try {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    /* 打不开浏览器不算失败 */
  }
}

function emit(payload, human) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${human}\n`)
  }
}

async function waitReady(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    state = readState()
    if (state && pidAlive(state.pid) && (await health(state.port))) return state
    await sleep(120)
  }
  return null
}

const existing = readState()

if (existing && pidAlive(existing.pid) && (await health(existing.port))) {
  const payload = { running: true, reused: true, ...existing }
  if (wantOpen) openUrl(existing.url)
  emit(payload, `大屏已在运行（复用，未重复起进程）\nURL: ${existing.url}\n端口: ${existing.port}  PID: ${existing.pid}`)
  process.exit(0)
}

if (existing) {
  // 僵尸 pid / 端口失效：清掉残留状态再重启
  clearState()
}

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'server.mjs')], {
  detached: true,
  stdio: 'ignore',
  cwd: PLUGIN_ROOT,
  env: { ...process.env },
})
child.unref()

const ready = await waitReady()

if (!ready) {
  const payload = {
    running: false,
    error: 'start timeout',
    log: LOG_FILE,
    stateFile: STATE_FILE,
  }
  emit(payload, `启动失败：4 秒内未就绪。\n请查看日志：${LOG_FILE}`)
  process.exit(1)
}

if (wantOpen) openUrl(ready.url)

const payload = { running: true, reused: false, ...ready }
emit(
  payload,
  [
    `NEBULA 作战大屏已启动 v${VERSION}`,
    `URL: ${ready.url}`,
    `端口: ${ready.port}  PID: ${ready.pid}`,
    `运行时文件: ${STATE_FILE}`,
  ].join('\n'),
)
