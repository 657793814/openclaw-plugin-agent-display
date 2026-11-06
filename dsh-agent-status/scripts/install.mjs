#!/usr/bin/env node
/**
 * One-click installer for dsh-agent-status.
 *
 *   node scripts/install.mjs                 # install into ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --screen-theme galaxy   # NEBULA「星核蜘蛛」big screen
 *   node scripts/install.mjs --profile-dir ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --home /tmp/dsh-home --profile-dir /tmp/dsh-home/profiles/test
 *
 * What it does (idempotent):
 *   1. backs up package.json / cordis.yml / cordis.patch.yml / lockfiles /
 *      any profile index.html under $DSH_HOME/backups/dsh-agent-status/<stamp>/
 *      (first install only; updates reuse the pristine pre-install snapshot);
 *   2. adds a `link:` dependency and the bundle entry to the profile package.json;
 *   3. symlinks <package> into <profile>/node_modules/dsh-agent-status;
 *   4. writes the managed config row (token, theme, position, visibility,
 *      screen button/landing/window, waiting timeout) into cordis.patch.yml.
 *
 * It never touches the Harness app or its asar.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createToken } from '../lib/auth.js'
import {
  hasPatchBlock,
  mergeProfilePackage,
  readPatchBlock,
  upsertPatch,
} from '../lib/install.js'

const PACKAGE_NAME = 'dsh-agent-status'
const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const BACKUP_FILES = [
  'package.json',
  'cordis.yml',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'index.html',
  'web/index.html',
  'dist/index.html',
]

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq > 0) {
      args[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      index += 1
    } else {
      args[key] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const home = path.resolve(args.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const profileDir = path.resolve(
  args['profile-dir'] ?? process.env.DSH_PROFILE_DIR ?? path.join(home, 'profiles', 'desktop'),
)

function fail(message) {
  console.error(`[agent-status] install failed: ${message}`)
  process.exit(1)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function ensureProfile() {
  for (const required of ['package.json', 'cordis.patch.yml']) {
    if (!fs.existsSync(path.join(profileDir, required))) {
      fail(`${required} missing in profile ${profileDir}`)
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`)
  }
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function flag(value, fallback) {
  if (value === undefined) return fallback
  if (value === true) return true
  if (value === false) return false
  const text = String(value).toLowerCase()
  if (text === 'true' || text === '1' || text === 'yes') return true
  if (text === 'false' || text === '0' || text === 'no') return false
  return fallback
}

/**
 * Reuse the oldest backup taken before the plugin was ever installed, so an
 * update never overwrites the pristine snapshot with an "already installed"
 * one. Backups that already contain the managed block are ignored.
 */
function findPristineBackup() {
  const root = path.join(home, 'backups', 'dsh-agent-status')
  if (!fs.existsSync(root)) return null
  const names = fs.readdirSync(root).sort()
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      if (path.resolve(manifest.profileDir) !== profileDir) continue
      const patch = path.join(dir, 'profile', 'cordis.patch.yml')
      if (fs.existsSync(patch) && hasPatchBlock(fs.readFileSync(patch, 'utf8'))) continue
      return dir
    } catch {
      /* skip malformed backup */
    }
  }
  return null
}

function linkState(linkPath) {
  try {
    const stat = fs.lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      return { state: 'symlink', target: fs.readlinkSync(linkPath) }
    }
    return { state: 'directory', target: '' }
  } catch {
    return { state: 'absent', target: '' }
  }
}

function createBackup(manifest) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = path.join(home, 'backups', 'dsh-agent-status', stamp)
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true })
  const files = {}
  for (const relative of BACKUP_FILES) {
    const source = path.join(profileDir, relative)
    if (!fs.existsSync(source)) {
      files[relative] = { existed: false, sha256: null }
      continue
    }
    const target = path.join(dir, 'profile', relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    files[relative] = { existed: true, sha256: sha256(source) }
  }
  const record = {
    schema: 1,
    createdAt: new Date().toISOString(),
    profileDir,
    packageDir: PACKAGE_DIR,
    nodeModulesLink: manifest.link,
    files,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`)
  return dir
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function main() {
  ensureProfile()
  if (!fs.existsSync(path.join(PACKAGE_DIR, 'package.json'))) {
    fail(`package directory is invalid: ${PACKAGE_DIR}`)
  }

  const packageFile = path.join(profileDir, 'package.json')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const nodeModules = path.join(profileDir, 'node_modules')
  const linkPath = path.join(nodeModules, PACKAGE_NAME)

  const pkg = readJson(packageFile)
  const patchText = readText(patchFile)
  const existing = readPatchBlock(patchText)
  const token = typeof args.token === 'string' && args.token !== '' ? args.token : String(existing.token ?? '')
  const config = {
    token: token === '' ? createToken() : token,
    port: Number(args.port ?? existing.port ?? 0),
    theme: String(args.theme ?? existing.theme ?? 'neon'),
    screenTheme: String(args['screen-theme'] ?? existing.screenTheme ?? 'neon'),
    position: String(args.position ?? existing.position ?? 'bottom-right'),
    visible: args.hidden === true ? false : flag(args.visible, Boolean(existing.visible ?? true)),
    screenButton:
      args['no-screen-button'] === true
        ? false
        : flag(
            args['screen-button'],
            typeof existing.screenButton === 'boolean' ? existing.screenButton : true,
          ),
    screenLanding: String(args['screen-landing'] ?? existing.screenLanding ?? 'hud'),
    screenWindow: String(args['screen-window'] ?? existing.screenWindow ?? 'tab'),
    waitingAfterMs: Number(args['waiting-after-ms'] ?? existing.waitingAfterMs ?? 15000),
    doneHoldMs: Number(args['done-hold-ms'] ?? existing.doneHoldMs ?? 6000),
    pollMs: Number(args['poll-ms'] ?? existing.pollMs ?? 800),
  }

  const linkSpec = `link:${path.relative(profileDir, PACKAGE_DIR)}`
  const merged = mergeProfilePackage(pkg, { linkSpec })
  const currentLink = linkState(linkPath)
  if (currentLink.state === 'directory') {
    fail(`${linkPath} is a real directory; move it away before installing`)
  }

  const patchNext = upsertPatch(patchText, config)
  const linkChanged = currentLink.state !== 'symlink' || path.resolve(linkPath, currentLink.target) !== PACKAGE_DIR
  const changed = merged.changed || patchNext !== patchText || linkChanged

  if (!changed) {
    console.log(`[agent-status] already installed in ${profileDir}; nothing to change`)
    console.log(`[agent-status] token: ${config.token}`)
    return
  }

  const backupDir = findPristineBackup()
  if (backupDir !== null) {
    console.log(`[agent-status] reusing pre-install backup: ${backupDir}`)
    // 还原过一次的备份在重新安装后必须能再次还原，否则 uninstall 会误判“已还原”。
    const marker = path.join(backupDir, 'restored.json')
    if (fs.existsSync(marker)) fs.unlinkSync(marker)
  } else if (hasPatchBlock(patchText)) {
    console.warn(
      '[agent-status] no pristine backup found; skipping backup. Uninstall will fall back to surgical removal.',
    )
  } else {
    const created = createBackup({ link: currentLink })
    console.log(`[agent-status] backup: ${created}`)
  }

  if (merged.changed) writeJson(packageFile, merged.json)
  if (patchNext !== patchText) fs.writeFileSync(patchFile, patchNext)

  if (linkChanged) {
    fs.mkdirSync(nodeModules, { recursive: true })
    try {
      fs.unlinkSync(linkPath)
    } catch {
      /* absent or already gone */
    }
    fs.symlinkSync(PACKAGE_DIR, linkPath, 'dir')
  }

  console.log('')
  console.log(`[agent-status] installed ${PACKAGE_NAME} → ${profileDir}`)
  console.log(`[agent-status] package: ${PACKAGE_DIR}`)
  console.log(`[agent-status] bundle:  ${PACKAGE_NAME} (dsh.profile.bundles)`)
  console.log(`[agent-status] token:   ${config.token}`)
  console.log(`[agent-status] config:  port=${config.port} theme=${config.theme} screenTheme=${config.screenTheme} position=${config.position} visible=${config.visible} screenButton=${config.screenButton} screenLanding=${config.screenLanding}`)
  console.log('')
  console.log('Restart DeepSeek Harness now: quit it completely (Cmd+Q), then reopen.')
  console.log('The desktop shell snapshots its index-injection table at boot; a restart is required')
  console.log('after first install and after every runtime/hud.js|css update. The /screen page is')
  console.log('assembled per request, so only runtime/screen.* changes skip the restart.')
  console.log('')
  console.log(`State API:  http://127.0.0.1:<host-port>/dsh-agent-status/api/state?token=${config.token}`)
  console.log(`Big screen: http://127.0.0.1:<host-port>/dsh-agent-status/screen?token=${config.token}`)
  console.log('The host port is printed by the Harness web server; desktop usually uses 127.0.0.1:17818.')
  console.log('Or click the 「大屏」 button in the HUD — it builds the URL from the current page origin.')
  console.log('Hide the HUD temporarily with its × button (restore via the small bubble), or Alt+Shift+H.')
}

main()
