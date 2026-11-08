#!/usr/bin/env node
/**
 * 停止 NEBULA 作战大屏，清理运行时文件。
 *
 *   node bin/stop.mjs
 *   node bin/stop.mjs --json
 */
import { execFileSync } from 'node:child_process'
import {
  PLUGIN_ROOT,
  STATE_FILE,
  clearState,
  pidAlive,
  readState,
  sleep,
} from './runtime.mjs'

const asJson = process.argv.slice(2).includes('--json')

function emit(payload, human) {
  if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${human}\n`)
}

/** True only when the PID still belongs to this plugin's server process. */
function isOurServer(pid) {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    })
    return command.includes('server.mjs') && command.includes(PLUGIN_ROOT)
  } catch {
    return false
  }
}

const state = readState()

if (!state) {
  emit({ stopped: false, reason: 'not-running' }, '大屏未在运行（没有运行时状态文件）')
  process.exit(0)
}

if (!pidAlive(state.pid)) {
  clearState()
  emit(
    { stopped: false, reason: 'stale-pid', pid: state.pid },
    `发现僵尸 PID ${state.pid}，已清理运行时文件（进程本来就不在了）`,
  )
  process.exit(0)
}

// The PID may have been recycled by an unrelated process; never signal it.
if (!isOurServer(state.pid)) {
  clearState()
  emit(
    { stopped: false, reason: 'foreign-pid', pid: state.pid },
    `PID ${state.pid} 已不属于本插件的大屏进程，已只清理运行时文件（未发送信号）`,
  )
  process.exit(0)
}

try {
  process.kill(state.pid, 'SIGTERM')
} catch (error) {
  clearState()
  emit({ stopped: false, reason: 'signal-failed', error: String(error) }, `发送 SIGTERM 失败：${error}`)
  process.exit(1)
}

for (let i = 0; i < 15; i += 1) {
  await sleep(200)
  if (!pidAlive(state.pid)) break
}

if (pidAlive(state.pid)) {
  try {
    process.kill(state.pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  await sleep(200)
}

clearState()

emit(
  { stopped: true, pid: state.pid, port: state.port },
  `大屏已停止（PID ${state.pid}，端口 ${state.port}）；运行时文件已清理：${STATE_FILE}`,
)
