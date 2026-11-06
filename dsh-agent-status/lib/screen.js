/**
 * Big-screen page assembly helpers (pure, unit-tested).
 *
 * The page is served by the plugin route `/dsh-agent-status/screen`. It is
 * assembled per request from `runtime/screen.html|css|js`, so front-end changes
 * to the screen do not require a host restart (unlike the injected HUD).
 */

/** Dynamic origin + token URL; never hard-code a port. */
export function screenUrl(origin, prefix, token) {
  const base = String(origin ?? '').replace(/\/+$/u, '')
  const safePrefix = String(prefix ?? '/dsh-agent-status').replace(/\/+$/u, '')
  return `${base}${safePrefix}/screen?token=${encodeURIComponent(String(token ?? ''))}`
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/**
 * @param {{ template: string, css: string, js: string, config: Record<string, any> }} input
 * @returns {string}
 */
export function renderScreenHtml({ template, css, js, config }) {
  const source = String(template ?? '')
  return source
    .split('__SCREEN_CSS__')
    .join(String(css ?? ''))
    .split('__SCREEN_JS__')
    .join(String(js ?? ''))
    .split('__SCREEN_CONFIG__')
    .join(inlineJson(config ?? {}))
}
