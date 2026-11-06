/**
 * Plugin config normalization.
 *
 * The config row lives in the profile's `cordis.patch.yml` and reaches
 * `apply(ctx, config)`. Everything here is defensive: a malformed value falls
 * back to the default instead of preventing the plugin from loading.
 */

export const POSITIONS = ['bottom-right', 'top-right', 'bottom-left', 'top-left']
export const THEMES = ['neon', 'mono']
export const SCREEN_THEMES = ['neon', 'mono', 'galaxy']
export const SCREEN_LANDINGS = ['hud', 'screen']
export const SCREEN_WINDOWS = ['tab', 'window']

export const DEFAULTS = {
  token: '',
  port: 0,
  theme: 'neon',
  screenTheme: 'neon',
  position: 'bottom-right',
  visible: true,
  screenButton: true,
  screenLanding: 'hud',
  screenWindow: 'tab',
  waitingAfterMs: 15_000,
  doneHoldMs: 6000,
  pollMs: 800,
  sseFlushMs: 120,
}

function integer(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.floor(parsed)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

function boolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * @param {any} raw config from the loader row
 * @param {{ envToken?: string }} [options]
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw, options = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const token =
    typeof source.token === 'string' && source.token.trim() !== ''
      ? source.token.trim()
      : String(options.envToken ?? '').trim()

  return {
    token,
    port: integer(source.port, DEFAULTS.port, 0, 65535),
    theme: THEMES.includes(source.theme) ? source.theme : DEFAULTS.theme,
    screenTheme: SCREEN_THEMES.includes(source.screenTheme)
      ? source.screenTheme
      : DEFAULTS.screenTheme,
    position: POSITIONS.includes(source.position) ? source.position : DEFAULTS.position,
    visible: boolean(source.visible, DEFAULTS.visible),
    screenButton: boolean(source.screenButton, DEFAULTS.screenButton),
    screenLanding: SCREEN_LANDINGS.includes(source.screenLanding)
      ? source.screenLanding
      : DEFAULTS.screenLanding,
    screenWindow: SCREEN_WINDOWS.includes(source.screenWindow)
      ? source.screenWindow
      : DEFAULTS.screenWindow,
    waitingAfterMs: integer(source.waitingAfterMs, DEFAULTS.waitingAfterMs, 3000, 600_000),
    doneHoldMs: integer(source.doneHoldMs, DEFAULTS.doneHoldMs, 1000, 120_000),
    pollMs: integer(source.pollMs, DEFAULTS.pollMs, 250, 30_000),
    sseFlushMs: integer(source.sseFlushMs, DEFAULTS.sseFlushMs, 50, 2000),
  }
}

/** Public config for the HUD script; never contains the install token. */
export function clientConfig(config) {
  return {
    theme: config.theme,
    position: config.position,
    visible: config.visible,
    screenButton: config.screenButton,
    screenLanding: config.screenLanding,
    screenWindow: config.screenWindow,
    waitingAfterMs: config.waitingAfterMs,
    pollMs: config.pollMs,
  }
}
