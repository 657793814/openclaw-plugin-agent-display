#!/usr/bin/env node
/**
 * One-click uninstaller for dsh-agent-status.
 *
 *   node scripts/uninstall.mjs                  # restore ~/.dsh/profiles/desktop
 *   node scripts/uninstall.mjs --profile-dir ... --backup-dir ...
 *
 * It restores the pre-install snapshot written by scripts/install.mjs:
 *   - profile package.json / cordis.patch.yml / cordis.yml / lockfiles / index.html;
 *   - the node_modules symlink state.
 *
 * If no backup exists it falls back to a surgical removal of the managed block,
 * dependency and bundle entry. Safe to run twice.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasPatchBlock, removePatch, removeProfilePackage, PACKAGE_NAME } from '../lib/install.js'

const args = parse(process.argv.slice(2))
const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = path.resolve(args.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'))
const profileDir = path.resolve(
  args['profile-dir'] ?? process.env.DSH_PROFILE_DIR ?? path.join(home, 'profiles', 'desktop'),
)
const backupRoot = path.join(home, 'backups', 'dsh-agent-status')

function parse(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const eq = item.indexOf('=')
    if (eq > 0) {
      result[item.slice(2, eq)] = item.slice(eq + 1)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next
      index += 1
    } else {
      result[key] = true
    }
  }
  return result
}

function fail(message) {
  console.error(`[agent-status] uninstall failed: ${message}`)
  process.exit(1)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function findBackup() {
  if (typeof args['backup-dir'] === 'string') {
    const dir = path.resolve(args['backup-dir'])
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) fail(`${dir} has no manifest.json`)
    return dir
  }
  if (!fs.existsSync(backupRoot)) return null
  const candidates = fs
    .readdirSync(backupRoot)
    .filter((name) => fs.existsSync(path.join(backupRoot, name, 'manifest.json')))
    .sort()
    .reverse()
  for (const name of candidates) {
    const dir = path.join(backupRoot, name)
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
      if (path.resolve(manifest.profileDir) === profileDir) {
        // A backup that already contains the managed block was taken *after* an
        // install (older installer bug). Restoring it would re-install the
        // plugin, so it is never a valid pre-install snapshot.
        const patch = path.join(dir, 'profile', 'cordis.patch.yml')
        if (fs.existsSync(patch) && hasPatchBlock(fs.readFileSync(patch, 'utf8'))) {
          console.warn(`[agent-status] skipping backup ${dir}: it already contains the managed block`)
          continue
        }
        return dir
      }
    } catch {
      /* skip malformed backup */
    }
  }
  return null
}

function restoreFromBackup(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  if (path.resolve(manifest.profileDir) !== profileDir) {
    fail(`backup belongs to ${manifest.profileDir}, not ${profileDir}`)
  }
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const managed = fs.existsSync(patchFile) && hasPatchBlock(fs.readFileSync(patchFile, 'utf8'))
  if (fs.existsSync(path.join(dir, 'restored.json')) && !managed) {
    console.log(`[agent-status] backup ${dir} was already restored; nothing to do`)
    return
  }

  const checks = []
  for (const [relative, meta] of Object.entries(manifest.files ?? {})) {
    const target = path.join(profileDir, relative)
    if (!meta.existed) {
      if (fs.existsSync(target)) {
        console.warn(`[agent-status] ${relative} did not exist before install; leaving the current file untouched`)
      }
      continue
    }
    const source = path.join(dir, 'profile', relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    const actual = sha256(target)
    checks.push({ relative, ok: actual === meta.sha256 })
  }

  const linkPath = path.join(profileDir, 'node_modules', PACKAGE_NAME)
  const link = manifest.nodeModulesLink ?? { state: 'absent', target: '' }
  if (link.state === 'symlink') {
    try {
      fs.unlinkSync(linkPath)
    } catch {
      /* absent */
    }
    fs.symlinkSync(link.target, linkPath, 'dir')
    checks.push({ relative: 'node_modules/dsh-agent-status', ok: true })
  } else if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
    const target = fs.readlinkSync(linkPath)
    const resolved = path.resolve(path.dirname(linkPath), target)
    if (resolved === path.resolve(manifest.packageDir ?? PACKAGE_DIR)) {
      fs.unlinkSync(linkPath)
    } else {
      console.warn(`[agent-status] node_modules/${PACKAGE_NAME} points to ${target}; leaving it untouched`)
    }
  }

  fs.writeFileSync(
    path.join(dir, 'restored.json'),
    `${JSON.stringify({ restoredAt: new Date().toISOString(), profileDir }, null, 2)}\n`,
  )

  console.log(`[agent-status] restored from ${dir}`)
  for (const check of checks) {
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'} ${check.relative}`)
  }
  if (checks.some((check) => !check.ok)) fail('hash mismatch after restore')
}

function surgicalRemoval() {
  const packageFile = path.join(profileDir, 'package.json')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const linkPath = path.join(profileDir, 'node_modules', PACKAGE_NAME)

  if (fs.existsSync(packageFile)) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    const result = removeProfilePackage(pkg)
    if (result.changed) fs.writeFileSync(packageFile, `${JSON.stringify(result.json, null, 2)}\n`)
  }
  if (fs.existsSync(patchFile)) {
    const next = removePatch(fs.readFileSync(patchFile, 'utf8'))
    fs.writeFileSync(patchFile, next)
  }
  if (fs.existsSync(linkPath) && fs.lstatSync(linkPath).isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))
    if (resolved === PACKAGE_DIR) fs.unlinkSync(linkPath)
  }
  console.log(`[agent-status] no backup found; removed managed rows surgically from ${profileDir}`)
}

function main() {
  if (!fs.existsSync(profileDir)) fail(`profile directory not found: ${profileDir}`)
  const backup = findBackup()
  if (backup === null) {
    surgicalRemoval()
  } else {
    restoreFromBackup(backup)
  }
  console.log('')
  console.log('Restart DeepSeek Harness (Cmd+Q, then reopen) to drop the injected HUD.')
}

main()
