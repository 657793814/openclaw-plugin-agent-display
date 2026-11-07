/**
 * NEBULA Agent Status — Trae VS Code-extension host half.
 *
 * Shape:
 *   - one editor WebviewPanel (NEBULA theme, reused verbatim from dsh)
 *   - one status-bar HUD
 *   - two data sources: live hub_event_cache tail, and real-file mock replay
 *
 * No HTTP server, no token, no private IPC. The extension only reads files
 * under `~/.trae-cn/hub_event_cache` and never writes outside its own
 * globalStorage directory.
 */

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vscode = require('vscode')

const { createStore } = require('../lib/store')
const { createHubCacheSource, DEFAULT_ROOT } = require('../lib/hub-cache')
const { createMockSource } = require('../lib/mock')

const VERSION = '0.1.0'
const PANEL_VIEW_TYPE = 'agentStatus.screen'
const FLUSH_MS = 200
const SWEEP_MS = 1000

const mediaDir = path.join(__dirname, '..', 'media')
const VENDOR = [
  'three.min.js',
  'CopyShader.js',
  'LuminosityHighPassShader.js',
  'EffectComposer.js',
  'RenderPass.js',
  'ShaderPass.js',
  'UnrealBloomPass.js',
]

function readAsset(relative) {
  return fs.readFileSync(path.join(mediaDir, relative), 'utf8')
}

function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

// ---------------------------------------------------------------- Agent 插件大屏

const NEBULA_PLUGIN_ROOT = path.join(
  os.homedir(),
  '.trae-cn',
  'plugins',
  'nebula-lab',
  'nebula-screen',
)

/**
 * Agent 插件只支持 skill / connector / mcpServers，没有启动钩子或视图贡献，
 * 因此由本扩展在 onStartupFinished 时替它拉起本地服务。
 */
function resolveNodeBinary() {
  if (process.env.NEBULA_NODE) return process.env.NEBULA_NODE
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(candidate)) return candidate
  }
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    const versions = fs.readdirSync(nvmDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const candidate = path.join(nvmDir, version, 'bin', 'node')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    /* nvm 不存在时回退到 PATH 里的 node */
  }
  return 'node'
}

function findNebulaServerScript() {
  try {
    const versions = fs
      .readdirSync(NEBULA_PLUGIN_ROOT)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      const script = path.join(NEBULA_PLUGIN_ROOT, version, 'bin', 'start.mjs')
      if (fs.existsSync(script)) return script
    }
  } catch {
    /* 未安装 Agent 插件 */
  }
  return null
}

/**
 * `wait=false`：静默拉起（start.mjs 幂等，已在跑直接复用）。
 * `wait=true`：同步拿到含一次性 token 的 URL，供「在浏览器打开」使用。
 */
function startNebulaServer(wait) {
  const script = findNebulaServerScript()
  if (script === null) return null
  const node = resolveNodeBinary()
  if (!wait) {
    try {
      const child = childProcess.spawn(node, [script], { detached: true, stdio: 'ignore' })
      child.unref()
      return { started: true, script }
    } catch (error) {
      return { started: false, script, error: String(error) }
    }
  }
  try {
    const stdout = childProcess.execFileSync(node, [script, '--json'], {
      encoding: 'utf8',
      timeout: 8000,
    })
    return JSON.parse(stdout)
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    try {
      return JSON.parse(stdout)
    } catch {
      return { error: String(error) }
    }
  }
}

/** @param {any} probe */
function probeTraeApi() {
  const probe = {
    at: Date.now(),
    vscodeVersion: vscode.version,
    hasTrae: false,
    traeKeys: [],
    hookKeys: [],
    error: '',
  }
  try {
    const trae = vscode.trae
    probe.hasTrae = trae !== null && typeof trae === 'object'
    if (probe.hasTrae) {
      probe.traeKeys = Object.keys(trae)
      probe.hookKeys = trae.hooks && typeof trae.hooks === 'object' ? Object.keys(trae.hooks) : []
    }
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error)
  }
  return probe
}

function applyEvent(store, event) {
  switch (event.kind) {
    case 'session.start':
      store.sessionStart(event)
      return
    case 'tool.call':
      store.toolCall(event)
      return
    case 'tool.result':
      store.toolResult(event)
      return
    case 'usage':
      store.usage(event)
      return
    case 'queue':
      store.queue(event)
      return
    case 'step.note':
      store.note(event)
      return
    case 'turn.end':
      store.turnEnd(event)
      return
    default:
      return
  }
}

function buildHtml() {
  const nonce = crypto.randomBytes(18).toString('hex')
  const css = readAsset('screen.css')
  const vendor = VENDOR.map((name) => readAsset(`nebula/vendor/${name}`)).join('\n;\n')
  const config = {
    version: VERSION,
    theme: 'galaxy',
    screenTheme: 'galaxy',
    waitingAfterMs: 15_000,
    mode: 'webview',
    nebulaTemplate: readAsset('nebula/template.html'),
  }
  const js = [
    readAsset('nebula-core.js'),
    vendor,
    readAsset('nebula/theme.js'),
    '\nglobalThis.DSHNebulaMount = mountNebula;\n;\n',
    readAsset('screen.js'),
  ].join('\n')
  // NEBULA's shadow-DOM template ships a plain `<style>` element and the
  // renderer writes `style="--c:..."` attributes, so styles must stay
  // `'unsafe-inline'`; scripts remain nonce-only.
  const csp =
    `default-src 'none'; img-src data:; font-src data:; ` +
    `style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; ` +
    `connect-src 'none'; base-uri 'none'; form-action 'none';`
  return readAsset('screen.html')
    .replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    .split('__SCREEN_CSS__')
    .join(css)
    .split('__SCREEN_JS__')
    .join(js)
    .split('__SCREEN_CONFIG__')
    .join(inlineJson(config))
    .split('__CSP_NONCE__')
    .join(nonce)
}

/** Activity Bar 里的「作战大屏」视图：和 TestWebviewPanel 共用同一套快照与消息协议。 */
class AgentStatusView {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {(message: any, host: AgentStatusView) => void} onMessage
   * @param {() => void} onDispose
   */
  constructor(context, onMessage, onDispose) {
    this.context = context
    this.onMessage = onMessage
    this.onDispose = onDispose
    this.ready = false
    this.view = null
  }

  resolveWebviewView(view) {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(mediaDir)],
    }
    this.ready = false
    view.webview.html = buildHtml()
    view.webview.onDidReceiveMessage(
      (message) => this.onMessage(message, this),
      undefined,
      this.context.subscriptions,
    )
    view.onDidDispose(
      () => {
        this.ready = false
        this.view = null
        this.onDispose()
      },
      undefined,
      this.context.subscriptions,
    )
  }

  send(message) {
    if (this.ready && this.view !== null) this.view.webview.postMessage(message)
  }
}

class AgentStatusPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {(message: any) => void} onMessage
   * @param {() => void} onDispose
   * @param {() => void} onVisible
   */
  constructor(context, onMessage, onDispose, onVisible) {
    this.context = context
    this.onMessage = onMessage
    this.onDispose = onDispose
    this.onVisible = onVisible
    this.panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      'Agent Status · NEBULA',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.file(mediaDir)],
      },
    )
    this.ready = false
    this.panel.webview.html = this.html()

    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      undefined,
      context.subscriptions,
    )
    this.panel.onDidChangeViewState(
      (event) => {
        if (!event.webviewPanel.visible) {
          // Context is released while hidden; the webview re-sends `ready`
          // when it comes back, so stop posting until that happens.
          this.ready = false
          return
        }
        if (this.ready) this.onVisible()
      },
      undefined,
      context.subscriptions,
    )
    this.panel.onDidDispose(
      () => this.onDispose(),
      undefined,
      context.subscriptions,
    )
  }

  html() {
    return buildHtml()
  }

  send(message) {
    if (this.ready) this.panel.webview.postMessage(message)
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.One, true)
  }

  dispose() {
    this.panel.dispose()
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const output = vscode.window.createOutputChannel('Agent Status')
  context.subscriptions.push(output)

  const probe = probeTraeApi()
  try {
    const storage = context.globalStorageUri.fsPath
    fs.mkdirSync(storage, { recursive: true })
    fs.writeFileSync(path.join(storage, 'probe.json'), JSON.stringify(probe, null, 2))
  } catch (error) {
    output.appendLine(`probe write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  output.appendLine(`probe: ${JSON.stringify(probe)}`)

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusItem.command = 'agentStatus.open'
  statusItem.name = 'NEBULA 作战大屏'
  statusItem.text = '$(graph) NEBULA 作战大屏'
  statusItem.tooltip = '点击打开 NEBULA 星核蜘蛛作战大屏'
  statusItem.show()
  context.subscriptions.push(statusItem)

  const store = createStore({})
  /** @type {null | AgentStatusPanel} */
  let panel = null
  /** @type {null | ReturnType<typeof createHubCacheSource>} */
  let hub = null
  /** @type {null | ReturnType<typeof createMockSource>} */
  let mock = null
  let sourceStatus = { state: 'starting', note: '正在扫描 hub_event_cache…', files: 0 }
  let dirty = true
  let lastStatusText = ''
  let lastStatusBg = ''

  const snapshotPayload = () => ({
    ...store.snapshot(),
    version: VERSION,
    source: sourceStatus,
  })

  function updateStatusBar() {
    const snapshot = store.snapshot()
    const primary = Array.isArray(snapshot.agents) ? snapshot.agents[0] : null
    let text = '$(graph) NEBULA 作战大屏'
    let tooltip = `NEBULA 作战大屏 v${VERSION}\n数据源：${sourceStatus.state}\n${sourceStatus.note || ''}\n点击打开`
    let bg = ''
    if (sourceStatus.state === 'offline') {
      text = '$(warning) NEBULA · OFFLINE'
      bg = 'warning'
    } else if (sourceStatus.state === 'silent') {
      text = '$(circle-slash) NEBULA · SILENT'
    } else if (sourceStatus.state === 'mock') {
      text = '$(history) NEBULA · MOCK'
    } else if (sourceStatus.state === 'live') {
      text = primary === null ? '$(radio-tower) NEBULA · LISTENING' : `$(pulse) NEBULA · ${primary.label}`
    }
    if (snapshot.agents.some((agent) => agent.phase === 'failed')) bg = 'error'
    if (text !== lastStatusText) {
      statusItem.text = text
      lastStatusText = text
    }
    if (bg !== lastStatusBg) {
      statusItem.backgroundColor =
        bg === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : bg === 'error'
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : undefined
      lastStatusBg = bg
    }
    statusItem.tooltip = tooltip
    statusItem.show()
  }

  function post(kind) {
    const message = { type: kind, snapshot: snapshotPayload(), source: sourceStatus }
    panel?.send(message)
    viewHost?.send(message)
    updateStatusBar()
  }

  function handleEvent(event) {
    applyEvent(store, event)
    dirty = true
  }

  function handleSourceStatus(status) {
    if (status.done === true && sourceStatus.state === 'mock') {
      store.markAllDone('回放结束 · 视为本轮结束')
    }
    sourceStatus = {
      state: String(status.state || 'starting'),
      note: String(status.note || ''),
      files: Number(status.files) || 0,
      lastAppendAt: Number(status.lastAppendAt) || null,
    }
    dirty = true
    updateStatusBar()
    panel?.send({ type: 'source', source: sourceStatus })
    viewHost?.send({ type: 'source', source: sourceStatus })
  }

  function stopHub() {
    if (hub !== null) hub.stop()
    hub = null
  }

  function stopMock() {
    if (mock !== null) mock.stop()
    mock = null
  }

  function startHub() {
    stopMock()
    stopHub()
    store.reset()
    sourceStatus = { state: 'starting', note: '正在扫描 hub_event_cache…', files: 0 }
    hub = createHubCacheSource({
      root: DEFAULT_ROOT,
      onEvent: handleEvent,
      onStatus: handleSourceStatus,
    })
    hub.start()
    output.appendLine(`hub cache watching: ${DEFAULT_ROOT}`)
    dirty = true
  }

  function startMock() {
    stopHub()
    stopMock()
    store.reset()
    sourceStatus = { state: 'mock', note: '正在装载真实 JSONL…', files: 0 }
    mock = createMockSource({
      root: DEFAULT_ROOT,
      speed: 10,
      onEvent: handleEvent,
      onStatus: handleSourceStatus,
    })
    mock.start()
    output.appendLine('mock replay started')
    dirty = true
  }

  function onWebviewMessage(message, host) {
    const msg = message !== null && typeof message === 'object' ? message : {}
    if (msg.type === 'ready') {
      if (host) host.ready = true
      post('state')
      if (host) host.send({ type: 'probe', probe })
      setTimeout(() => host?.send({ type: 'debug-request' }), 3000)
      return
    }
    if (msg.type === 'paused') {
      return
    }
    if (msg.type === 'debug') {
      const record = { at: Date.now(), version: VERSION, probe, source: sourceStatus, debug: msg.debug }
      try {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true })
        fs.writeFileSync(
          path.join(context.globalStorageUri.fsPath, 'debug.json'),
          JSON.stringify(record, null, 2),
        )
      } catch {
        /* diagnostics must never break the webview */
      }
      output.appendLine(`debug: ${JSON.stringify(record.debug)}`)
      return
    }
  }

  function openPanel() {
    if (panel !== null) {
      panel.reveal()
      return
    }
    const instance = new AgentStatusPanel(
      context,
      (message) => onWebviewMessage(message, instance),
      () => {
        panel = null
      },
      () => post('resync'),
    )
    panel = instance
  }

  const viewHost = new AgentStatusView(
    context,
    (message, host) => onWebviewMessage(message, host),
    () => {
      /* view disposed; the provider can resolve it again */
    },
  )
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'agentStatus.view',
      {
        resolveWebviewView: (view) => viewHost.resolveWebviewView(view),
      },
      { webviewOptions: { retainContextWhenHidden: false } },
    ),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentStatus.open', () => openPanel()),
    vscode.commands.registerCommand('agentStatus.openView', () =>
      vscode.commands.executeCommand('agentStatus.view.focus'),
    ),
    vscode.commands.registerCommand('agentStatus.reload', () => {
      if (panel === null) {
        openPanel()
        return
      }
      panel.ready = false
      panel.panel.webview.html = panel.html()
    }),
    vscode.commands.registerCommand('agentStatus.toggleMock', () => {
      if (mock !== null) {
        startHub()
      } else {
        startMock()
      }
      post('state')
      vscode.window.showInformationMessage(
        mock !== null ? 'Agent Status: Mock 回放已开启（真实 hub cache，10×）' : 'Agent Status: 已切回实时监听',
      )
    }),
    vscode.commands.registerCommand('agentStatus.debug', () => {
      const lines = [
        `version: ${VERSION}`,
        `probe: ${JSON.stringify(probe)}`,
        `source: ${JSON.stringify(sourceStatus)}`,
        `hub: ${JSON.stringify(hub === null ? null : hub.status())}`,
        `mock: ${JSON.stringify(mock === null ? null : mock.progress)}`,
        `agents: ${store.size()}`,
      ]
      output.show(true)
      for (const line of lines) output.appendLine(line)
      panel?.send({ type: 'debug-request' })
      vscode.window.showInformationMessage('Agent Status: 诊断信息已写入 Output 面板')
    }),
    vscode.commands.registerCommand('agentStatus.openBrowser', async () => {
      const payload = startNebulaServer(true)
      if (payload === null) {
        vscode.window.showWarningMessage(
          '未找到 trae-agent-plugin 大屏服务：请先安装 nebula-screen Agent 插件（bash install.sh）',
        )
        return
      }
      if (typeof payload.url !== 'string' || payload.url === '') {
        vscode.window.showWarningMessage(`大屏服务启动失败：${payload.error ?? '未知错误'}`)
        return
      }
      await vscode.env.openExternal(vscode.Uri.parse(payload.url))
    }),
  )

  const flushTimer = setInterval(() => {
    store.sweep()
    if (!dirty) return
    dirty = false
    post('state')
  }, FLUSH_MS)
  const sweepTimer = setInterval(() => {
    store.sweep()
    dirty = true
  }, SWEEP_MS)
  context.subscriptions.push({
    dispose() {
      clearInterval(flushTimer)
      clearInterval(sweepTimer)
      stopHub()
      stopMock()
    },
  })

  startHub()
  updateStatusBar()

  const nebula = startNebulaServer(false)
  if (nebula === null) {
    output.appendLine('agent 插件未安装（~/.trae-cn/plugins/nebula-lab/nebula-screen），跳过自动启动')
  } else {
    output.appendLine(`agent 插件大屏服务已自动启动：${nebula.script}`)
  }

  // 仅隔离实例的自检会用（NEBULA_SMOKE=1）：把「命令是否注册 / 面板与视图是否
  // 真的渲染」写成 smoke.json，避免再用日志推断。生产环境不会进入这段。
  if (process.env.NEBULA_SMOKE === '1') {
    setTimeout(async () => {
      const record = { at: Date.now(), version: VERSION, probe }
      try {
        record.commands = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith('agentStatus'))
      } catch (error) {
        record.commandsError = String(error)
      }
      try {
        await vscode.commands.executeCommand('agentStatus.open')
        record.openOk = panel !== null
      } catch (error) {
        record.openOk = false
        record.openError = String(error)
      }
      try {
        await vscode.commands.executeCommand('agentStatus.openView')
        record.viewFocusOk = true
      } catch (error) {
        record.viewFocusOk = false
        record.viewFocusError = String(error)
      }
      setTimeout(async () => {
        record.panelReady = panel !== null && panel.ready
        record.viewReady = viewHost.ready
        record.agents = store.size()
        record.source = sourceStatus
        try {
          fs.writeFileSync(
            path.join(context.globalStorageUri.fsPath, 'smoke.json'),
            JSON.stringify(record, null, 2),
          )
        } catch {
          /* smoke output must not throw */
        }
        output.appendLine(`smoke: ${JSON.stringify(record)}`)
        await vscode.commands.executeCommand('workbench.action.quit').catch(() => {})
      }, 6000)
    }, 2000)
  }

  // Restore a disposed panel after a window reload.
  if (vscode.window.registerWebviewPanelSerializer !== undefined) {
    try {
      vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
        async deserializeWebviewPanel() {
          openPanel()
        },
      })
    } catch {
      /* serializer is optional */
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate }
