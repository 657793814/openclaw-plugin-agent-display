# 把 NEBULA「星核蜘蛛」做成 Trae 插件 —— 可行性方案

> 调研对象：本机 **Trae CN 3.4.15**（`product.json` 中 `vscodeVersion: 1.107.1`）。
> 目标：把 `dsh-agent-status` 里已经跑通的 NEBULA 渲染层搬进 Trae，用真实 agent 事件驱动。
> 本文只做调研与方案，不改任何 Trae 安装目录文件、不覆盖 `index.html` / `openclaw-plugin-agent-display`。

---

## 0. 结论先行

### 0.1 能做成什么形态

| 形态 | 可行性 | 说明 |
| --- | --- | --- |
| **编辑器内 Webview 面板（推荐主形态）** | **已确证可用** | Trae 完整保留了 VS Code 的 webview API：`createWebviewPanel` / `registerWebviewViewProvider` / `registerWebviewPanelSerializer`。面板是编辑器 tab，可并排、可最大化，**用户可把它拖到独立窗口**（VS Code 的「Move into New Window」，不是 API 行为）。 |
| 侧边栏 / 底部面板里的自定义视图 | **已确证可用** | Trae 自带扩展 `cloudide.dsl-agent-logs` 就声明了 `views` 且 `type: "webview"`，`cloudide.icube-devtool-ports` 直接调用了 `createWebviewPanel` —— 说明这条链路在 Trae 里是活的，不是「理论上支持」。 |
| 状态栏 HUD | **已确证可用，但只能文字/图标** | `window.createStatusBarItem` 属稳定 API。适合放「阶段 · 工具 · 轮次」一行字，放不下 3D。 |
| 原生注入 Trae 聊天面板 / 主题注入 | **不可用** | Trae 的聊天/Agent UI 编译在 `workbench.desktop.main.js` 里，不是扩展；也没有任何 `index.html` 注入点。主题只能靠 `contributes.themes` 贡献整套配色，不能程序化改别人的界面。 |
| 独立操作系统窗口 | **只能降级实现** | 扩展 API 没有「开原生窗口」。降级路径：扩展内起本地 HTTP + `env.openExternal` 交给系统浏览器全屏（就是 dsh 现在的方式）。 |

**关键结论：Trae 的「agent 插件」系统做不了这个。** `~/.trae-cn/plugins/` 下的插件是「技能 + MCP + 二进制 + 连接器」的声明式包，**没有 UI、没有入口进程、没有生命周期**。要出界面，必须走 VS Code 扩展这一层。

### 0.2 事件能不能拿到（核心问题）

| 需求 | 是否有官方 API | 结论 |
| --- | --- | --- |
| 会话/轮次状态 | 无 | — |
| 工具调用开始 / 结束 / 结果 | 无 | — |
| 错误 / 失败原因 | 无 | — |
| 等待用户确认（approval） | 无 | — |
| 「会话结束」一个点 | 有，但是专有 proposed API：`trae.hooks.onSessionStopped` | **已确证可用**（P0 探针实测，第三方扩展无需 `--enable-proposed-api` 也能启用）；但只有一个「停了」事件，没有过程。 |
| MCP 工具注册（让 agent 调你） | 有：`trae.registerMcpProvider` 等 | 不等于「观测」，是「被调用」。 |

**所以：没有任何一条「插件 API 直接提供 agent 事件」的路径。必须走旁路。**

旁路里唯一能拿到「工具名 + 参数 + 结果 + 状态」的是 Trae 自己的事件缓存：

```
~/.trae-cn/hub_event_cache/TraeCode/<hubId>/<messageId>.jsonl
```

它是**按行追加的 JSONL**，`plan_item` 里带完整的工具调用对象（已实测，见 §1.4）。这是本方案的数据基础。

### 0.3 一句话结论

> **可以做成「Trae 内嵌 webview 作战大屏 + 状态栏 HUD」**：渲染层 100% 复用 dsh 的 NEBULA 代码，适配层换成「Node 侧 tail `hub_event_cache` JSONL + 监听 `command-execution` 目录」，用 `postMessage` 推给 webview，不走 HTTP、不需要 token。
> **一个已确证项 + 一个已处置项**：① `hub_event_cache` 在当前版本/当前会话模式下是否实时写入 —— **已确证不写入**（2026-11-07 实测：目录存在但全树 0 个 jsonl，Hub 桥未激活，见 §P0-4）；已用 `command-execution` + `renderer.log` 的 `live_local` 源兜底，大屏不再恒为 SILENT；② 第三方扩展能否启用 `trae` proposed API —— **已确证可用**，见 §P0。

---

## P0 实测结果（2026-11-06）

本节是方案落地前的实测记录。所有验证都在**隔离的用户数据目录 / 扩展目录**里跑，未重启、未改动用户当前正在运行的 Trae 窗口（PID 68683 全程保持运行）。

### P0-1 `trae` proposed API 对第三方扩展是否开放 —— **已确证：开放**

| 探测项 | 实测结果 |
| --- | --- |
| `vscode.trae` 是否存在 | **存在**（对象） |
| `Object.keys(vscode.trae)` | `registerMcpProvider` / `registerMcpServerDefinition` / `registerMcpTransportServer` / `hooks` |
| `vscode.trae.hooks` 的方法 | **只有 `onSessionStopped`**，无工具过程事件 |
| 是否必须 `--enable-proposed-api` | **不需要**。带 flag 与不带 flag 两次运行均激活成功、均能读到 `trae`，说明 gate 对第三方扩展开放 |

证据：`docs/evidence/trae-api-probe.json`、`docs/evidence/trae-probe-test-result.json`（`probeFound:true`、`probeActivated:true`、`activationError:""`、`hasTrae:true`）。

**含义：** 能拿到「会话停了」这一个点，拿不到「工具开始 / 工具结束 / 结果 / 错误 / 等待确认」。过程数据仍必须走 `hub_event_cache` 旁路，这一点没有被 API 改变。

### P0-2 真实扩展能否在 Trae 扩展宿主里激活 —— **已确证：可以**

| 探测项 | 实测结果 |
| --- | --- |
| 扩展被发现 | `extensionFound:true` |
| 激活成功 | `activated:true`（日志 `ExtensionService#_doActivateExtension trae.agent-status ... onStartupFinished`） |
| `agentStatus.open` 可执行 | `openCommandOk:true`（webview 面板成功打开） |
| 注册的 commands | `agentStatus.open` / `agentStatus.reload` / `agentStatus.toggleMock` / `agentStatus.debug` |

证据：`docs/evidence/trae-main-ext-result.json`。

### P0-3 Webview 里 NEBULA 渲染层是否真的跑起来 —— **已确证：跑起来了，且有实测帧率**

用可见 Chrome（非 headless）+ CDP `Runtime.evaluate` 读取 webview 内 `nebula.debug()`，再 `Page.captureScreenshot` 存证。两档窗口尺寸各测一次：

| 尺寸 | `glOK` | 实测 fps | `dpr` | 快照 | 截图 |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | **true** | **60** | 0.75 | 2 agents / 28 tool calls / 27 ok / 1 error / rate 96，`phase:"read"` | `docs/evidence/nebula-live-1440.png` |
| 900×700 | **true** | **59** | 1 | 2 agents / 28 tool calls，`walking:true` | `docs/evidence/nebula-live-900.png` |

`visibilityState` 两次均为 `visible`（先前测到 0 fps / FRAME 0000 是因为自动化标签页被判定为 hidden，rAF 被暂停，不是渲染层问题）。

**结论：** WebGL 上下文、EffectComposer、UnrealBloomPass、工具词条全部正常，帧率 60/59 属满帧，**不需要在 1440×900 上做降级**。窄屏（900×700）出现了右侧 HUD 裁切，属布局问题，建议 P1 处理（见 §降级建议）。

### P0-4 `hub_event_cache` 是否实时写入 —— **仍未确证**

| 检查项 | 结果 |
| --- | --- |
| 现有 `.jsonl` 文件数 | 2 |
| 最新文件的 mtime | `2026-11-05T06:44:02Z`（本地 14:44）、`2026-11-05T06:52:11Z`（本地 14:52） |
| 2026-11-06 是否有任何新写入 | **0**（`find -newermt "2026-11-06 00:00"` 无结果） |

**判断：** 今天没有任何 TraeCode 会话产生的落盘记录，因此**不能**用 11-05 的历史数据当作「实时写入」的证据。当前只能说：历史文件格式与字段结构（`{task_id, seq, type, data}`，`plan_item.tool_call_info` 内含工具名/参数/结果）已实测确认；**实时性未确证**。

**要确证这件事，需要用户做一件事：** 在今天新开一个 TraeCode 会话并跑一次带工具调用的任务，然后回来看 `~/.trae-cn/hub_event_cache/TraeCode/` 下是否出现今天的新目录/新文件。如果新会话仍然不落盘，说明当前版本的会话模式已切到别的存储（可能是 `database.db` 或私有 IPC），旁路方案需要改路径 —— 那时再讨论，不猜。

**适配层已按此设计：** `lib/hub-cache.js` 里的状态机是 `starting → live → silent → offline`，`silent` 会明确输出「未确证实时性 · hub cache 最近写入 MM-DD HH:mm，本轮无新增」的 banner，**不会把旧数据伪装成实时数据**。

**2026-11-07 实测结论（已确证，不再是未确证项）：**

| 检查项 | 结果 |
| --- | --- |
| `hub_event_cache/TraeCode/` 目录 | 存在，属主与权限正常（`drwxr-xr-x`） |
| 全树 `.jsonl` 文件数 | **0** |
| 唯一 hubId 子目录 mtime | `2026-11-07 22:34:27`（会话初始化），此后连续执行多次工具调用不再变化 |
| 是否存在第二个缓存根 | 无（`~/.trae/hub_event_cache` 不存在，不存在路径迁移） |

**根因：** 写入实现是原生 Hub 桥（`libharness.dylib` 的 `harness/hub/bridge/src/events/event_cache.rs`、`libai_agent.dylib` 的 `hub_bridge/event_cache.rs`，字符串含 `[HubEventCache] started task caching` / `TraeCode + hub_event_cache`）。它是企业/云端同步链路的副产物；本机为纯本地个人版，Hub 链路未激活，因此**只在会话启动时建空目录、不产生事件文件**。不是权限问题，不是我方读取方式问题。

**处置：** 新增 `lib/live-source.js`（`live_local` 源），用 `command-execution/execution.json` 作为实时工具活动心跳、用最新启动的 `renderer.log` 的 `plan_item` 补会话归属；`bin/server.mjs` 在 `auto` 模式下**只有 hub cache 今天确实有写入**才选 `hub_cache`，否则选 `live_local`。`bin/status.mjs` 会如实打印 `kind`。

### P0-5 探针清理

| 项目 | 处理 |
| --- | --- |
| 探针扩展源码 `/tmp/trae-probe-ext` | 已删除 |
| 探针宿主 runner `/tmp/trae-probe-test` | 已删除 |
| 隔离用户数据目录 `/tmp/trae-probe-user*`、`/tmp/trae-main-user` | 已删除 |
| 隔离扩展目录 `/tmp/trae-probe-exts*`、`/tmp/trae-main-exts`、`/tmp/trae-ext-test` | 已删除 |
| 结果 JSON 与截图 | **保留**（作为上表证据） |
| `~/.trae-cn` 下现有配置 | **未改动**；全程未向 `~/.trae-cn/extensions/` 写入任何东西 |

---

## P1 落地记录（2026-11-06）

### P1-1 标题与 Harness 文案的来源

先查清了文案到底从哪来，结论是**两处、都不是数据驱动的**：

| 文案 | 实际来源 | 性质 |
| --- | --- | --- |
| `DEEPSEEK HARNESS · THEME 05 · AGENT CRAWL` | `media/nebula/template.html` 的 `<div class="eb">` | 静态 HTML，`extension.js` 把整份模板作为字符串塞进 Shadow DOM |
| `HARNESS.LOG` | 同上，`.dp-h b` | 静态 HTML |
| `LIVE · HARNESS 事件` / `只读接收 Harness 事件` / `监听 Harness 事件流` | `theme.js` 运行时写 `innerHTML` | 硬编码在渲染层，**不是** `planSnapshot` 字段 |
| `HOST · Harness` | `theme.js` 的 `AG[0].zh` 与星核标签 | 硬编码 |

所以这里没有「优先走数据字段」的空间：标题/副标题在 NEBULA 原模板里就是写死的，`planSnapshot` 只提供 task / sections / words。改法就是直接改这两处源文件。

改后：

| 位置 | 新文案 |
| --- | --- |
| `.eb` 卷头 | `TRAE CN · AGENT OPS · THEME 05 · CRAWLER` |
| `.sub2` | `LIVE · TRAE 会话事件 · 只读` |
| 右下日志面板标题 | `TRAE.LOG` |
| 星核宿主标签 | `host / TRAE` |
| 宿主槽位文案 | `Trae 宿主`（`AG[0].zh`、`AG[0].zh='Trae 宿主'`） |
| 空态提示 | `在 Trae 里发起一轮对话` |
| aria-label | `正中是 Trae 宿主的丝带星核` |

**保留**：`NEBULA 星核蜘蛛 / CRAWLER` 这一行是产品名，不属于 Harness 专属文案，未改。

### P1-2 顺带发现并修复一个真 bug：CSP 把整份 Shadow DOM 样式打掉了

`extension.js` 原来的 CSP 是 `style-src 'nonce-…' 'unsafe-inline'`。按 CSP 规范，**源列表里一旦出现 nonce，`'unsafe-inline'` 会被忽略**。而 NEBULA 的模板 `<style>` 没有 nonce、渲染层还大量写 `style="--c:…"` 属性，结果：

- 实测 `shadowRoot.styleSheets.length === 0`
- 模板样式全部失效，面板退化成纵向堆叠、全部跑到视口外（实测 `board` 高度 8123px）

修法：`style-src 'unsafe-inline'`（去掉 nonce），脚本仍保持 `script-src 'nonce-…'`。这条如果不修，装进 Trae 也是一块无样式的白板。修复后实测 `styleSheets=1, rules=169`。

### P1-3 窄屏布局（`@media (max-width:1100px)`）

改在 `template.html` 的模板样式里（Shadow DOM 内，媒体查询按视口宽度生效）：

- 事件流 `.p-log` 折叠成**一条 46px 高的横条**，只显示最新一行
- `AGENTS` / `AGENT RADAR` 一组、`TOOL HEAT` / `SUCCESS RATE` 一组，**收成两列**，宽度用 `calc(50% - 34px)` 按板宽百分比算
- `TRAE.LOG` 改成**整行通栏**
- 字号降一档（面板标题 10.5→9.5px、雷达 10→9px、代码 9.5→8.5px）
- 雷达/热力/成功率三个 canvas 同比缩小，避免内容溢出面板

实测（900×633 视口，dpr 1.75）：

| 指标 | 结果 |
| --- | --- |
| `glOK` | true |
| fps | **60** |
| 越界元素（`offscreen`） | **[]**（原六块面板全部落在视口内） |
| 日志可见行数 | 1（折叠生效） |
| 标题 | `TRAE CN · AGENT OPS · THEME 05 · CRAWLER` |
| 截图 | `docs/evidence/nebula-narrow-900.png` |

宽屏回归（1440×706）：media query 不触发，仍是原六面板单行布局，fps 60，截图 `docs/evidence/nebula-wide-1440.png`。

### P1-4 真实 hub cache 数据源

`out/extension.js` 默认就起 `HubCacheSource`（`agentStatus.toggleMock` 才切 mock）。当前实测：

```
state: silent
note:  未确证实时性 · hub cache 最近写入 11-05 14:52，本轮无新增
files: 2
events: 419（历史冷启动水合，时间戳按观察时钟处理，不伪造耗时）
```

即：今天仍无新写入，界面走 `silent` banner 如实标注，不把 11-05 的数据当实时。

### P1-5 隐私裁剪复核

- 只读字段仍是白名单：`metadata / model_config / token_usage / queuing / plan_item`
- `user_message`、`append_input`、`context_usage`、`timing_events`、`notification` 全部落在 `default` 分支直接丢弃
- 新增一条回归测试：这五类行不得产出任何事件（断言 `PRIVATE-CHAT-TEXT` 不出现）
- 原有测试继续覆盖：`reasoning_content` / `thought` / `old_string` / `new_string` / `result.changes` 不外泄；Shell 只取 `description` 不取 `command`；Read 只留 basename + 行范围
- `node --test`：**19 passed / 0 failed**

### P1-6 状态栏 HUD

`statusItem.command = agentStatus.open`，**激活瞬间就写入文案**（避免 `show()` 时文本为空、渲染成 0 宽不可见项）。文案：

`$(graph) NEBULA 作战大屏`（默认）/ `$(circle-slash) NEBULA · SILENT` / `$(history) NEBULA · MOCK` / `$(radio-tower) NEBULA · LISTENING` / `$(pulse) NEBULA · <阶段 · 工具名>` / `$(warning) NEBULA · OFFLINE`；有 agent 失败时底色转 `error`，silent/offline 转 `warning`。

> 早期版本这里写的是 `Agent Status` / `SILENT · hub cache`，跟「NEBULA」没有字面关联，用户装完找不到入口。已改成始终带 `NEBULA`。

### P1-7 安装到用户扩展目录

用 Trae 自带 CLI 安装（等价于 `--install-extension`，会写 `extensions.json`，比手解压更完整）：

```
/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn \
  --install-extension dist/agent-status-0.1.0.vsix --force
```

| 项目 | 结果 |
| --- | --- |
| 实际安装路径 | `/Users/liuzuodong/.trae-cn/extensions/trae.agent-status-0.1.0` |
| 文件数 | 19（18 个扩展文件 + `.vsixmanifest`） |
| `extensions.json` | 26 → 27 条，新增 `trae.agent-status`，`source: vsix`，`pinned: true` |
| 源文件一致性 | 10 个关键文件逐个 sha256 比对，9 个一致；`package.json` 仅差安装器追加的 `__metadata` |
| 生效方式 | **需要用户自己重载窗口**（本次未重启用户 Trae） |

卸载：删目录即可
`rm -rf ~/.trae-cn/extensions/trae.agent-status-0.1.0`（再重载窗口）。

---

## 1. 事实调查（每条都带证据路径）

### 1.1 Trae 里其实有两套「插件」，能力完全不同

#### A. Trae Agent 插件（`~/.trae-cn/plugins/`）

真实安装样例：

```
~/.trae-cn/plugins/trae-remote-official/lark/1.0.7/
  .trae-plugin/plugin.json     ← 真正的清单
  .success                     ← 安装记录（registry / checksum / installed_at）
  package.json                 ← 只有 name/version/description
  skills/                      ← SKILL.md 集合
  bin/lark-cli                 ← 平台二进制
  connector.json               ← OAuth 连接器声明
~/.trae-cn/plugins/trae-remote-official/office-plugin-mac/0.1.0/
~/.trae-cn/plugins/browser-bridge/browser-bridge   ← 单个可执行文件 + VERSION
~/.trae-cn/plugins/trae-remote-official/chrome/1.0.5/  ← 只有 assets/*.svg，没有代码
```

清单里出现的全部字段（来自 `installed-plugins.json` 的 `manifest_json` 与上面的 `plugin.json`）：

```
name, version, description, author, homepage, repository, license, keywords,
i18n(display_name/description), interface(displayName, shortDescription,
longDescription, developerName, category, capabilities, defaultPrompt,
brandColor, composerIcon, logo, screenshots, websiteURL, privacyPolicyURL,
termsOfServiceURL), skills, connector, env, mcpServers, binaries, instructions,
environments
```

- `binaries[]`：每个平台一份 `{sha256, file_size, urls[]}`，安装时下载到 `bin/`，`required/executable` 可配。**插件可以自带可执行程序**。
- `mcpServers` / `instructions` / `environments`：字段存在，但本机 5 个官方插件里全是 `null`，**具体配置格式未确证**。
- **没有** `main` / `activationEvents` / `contributes` / `views` / `webview` / 任何 UI 字段。

**结论：这套系统只能扩展「Agent 的技能与工具」，不能画界面、不能常驻进程。** `browser-bridge` 只是给 Agent 用的浏览器桥二进制，不是 UI。

#### B. VS Code 扩展（`~/.trae-cn/extensions/`）

```
~/.trae-cn/extensions/                       ← 26 个扩展，extensions.json 有完整安装记录
  vue.volar-3.3.14-universal/
  eamodio.gitlens-19.5.0-universal/
  redhat.java-1.55.0-darwin-arm64/
  ...
/Applications/Trae CN.app/Contents/Resources/app/product.json
  → dataFolderName: ".trae-cn"，vscodeVersion: "1.107.1"
  → extensionsGallery: open-vsx.org
/Applications/Trae CN.app/Contents/Resources/app/out/vscode-dts/vscode.d.ts   ← 21,164 行完整 API 定义
```

安装入口（命令行原生支持，证据：`.../app/bin/code --help`）：

```
--install-extension <ext-id | path>     # 支持本地 .vsix 路径
--extensions-dir <dir>                  # 隔离测试
--list-extensions / --show-versions
```

本机已装了 26 个第三方扩展（Volar、GitLens、Java、Python…），说明侧载/安装是正常工作的，不存在「只允许官方扩展」的限制。

### 1.2 可用扩展点清单

| 扩展点 | 状态 | 证据 |
| --- | --- | --- |
| Webview 编辑器面板 | 可用 | `vscode.d.ts` L11525 `createWebviewPanel(viewType, title, showOptions, options)` |
| Webview 视图（侧边栏/面板容器） | 可用 | L11730 `registerWebviewViewProvider`；Trae 自带 `cloudide.dsl-agent-logs/package.json` 声明 `"type": "webview"` |
| Webview 持久化恢复 | 可用 | L11719 `registerWebviewPanelSerializer` |
| 本地资源加载 | 可用 | L9906 `localResourceRoots`、L10013 `asWebviewUri(localResource)`、L9951 注释「To load a resource from the workspace inside a webview…」 |
| 隐藏时保活 | 可用 | L10046 `retainContextWhenHidden` |
| 状态栏 | 可用 | 稳定 API `createStatusBarItem` |
| 命令 / 快捷键 | 可用 | 稳定 API |
| 贡献配色主题 | 可用 | 稳定 `contributes.themes`（只能整套换，不能注入别人的界面） |
| Chat 参与者 / LM | 可用但**方向相反** | L20042 `namespace chat` → L20050 `createChatParticipant`（你是「被问的人」）；L20663 `namespace lm`。**没有**「读别人会话」的 API |
| 注入 Trae 聊天面板 / 改 `index.html` | 不可用 | 聊天/Agent UI 在 `out/vs/workbench/workbench.desktop.main.js`，非扩展产物 |

### 1.3 Webview 是 iframe 还是原生？能跑 WebGL 吗？

- **是 iframe 沙箱**：VS Code 系 webview 由 `WebviewElement` 承载，内容跑在独立的 `vscode-webview://` 源里，和扩展宿主通过 `postMessage` 通信；`product.json` 里 `webviewContentExternalBaseUrlTemplate` 指向 `vscode-cdn.net/.../webview/browser/pre/`，说明 webview 基础设施完整保留。
- **本地资源**：必须 `asWebviewUri` 转换 + `localResourceRoots` 白名单，不能直接写 `file://`。
- **WebGL**：webview 就是 Electron 的 Chromium 渲染上下文，不存在禁用 WebGL 的机制；但 **Trae 内 webview 里跑 three.js + UnrealBloomPass 的实际帧率尚未实测** → 标 **未确证**，放到 P0 验收项。
- CSP：`webview.html` 必须自带 CSP。dsh 现在的做法是「模板 + 内联 CSS/JS + 内联配置」，可以直接沿用，只需把内联脚本写成带 `nonce` 的 `<script>`，CSP 用 `default-src 'none'; script-src 'nonce-xxx'; style-src 'nonce-xxx' 'unsafe-inline'; img-src data:;`。

### 1.4 Agent 事件：官方没有，旁路有

#### (1) 官方扩展 API：只到「会话停止」为止

Trae 在扩展宿主里注入了一个专有 API 对象（压缩后的代码可读）：

`/Applications/Trae CN.app/Contents/Resources/app/out/vs/workbench/api/node/extensionHostProcess.js`（偏移 1,810,452 ~ 1,810,779）

```js
async registerMcpProvider(...)          // 让扩展当 MCP server（被 agent 调用）
async registerMcpServerDefinition(...)
async registerMcpTransportServer(...)
hooks: { onSessionStopped: e.onSessionStopped }   // 唯一的事件
```

对应实现位于同一文件偏移 2,104,708：

```js
this._onSessionStopped = new A
this.onSessionStopped = this._onSessionStopped.event
this._management = ... createInstance(uA, ...)   // MCPServerManager
```

可见「会话停止」本质是给 MCP/computer-use 生命周期收尾用的，**不是给 UI 用的观测事件**。

启用条件（proposed API）：

- `byted-solo.builtin-mcp/package.json` 里有 `"enabledApiProposals": ["trae"]`（Trae 自带扩展可以用）。
- `.../dist/extension.js` L1467、L1854 调用了 `trae.hooks.onSessionStopped`；L215 `trae.registerMcpProvider`；L1322 `trae.registerMcpTransportServer`。
- 第三方扩展侧：`extensionHostProcess.js` 偏移 631,218 处的 gate 函数在本机构建里被改成了恒真：

```js
function it(e,t){return !0}
function k(e,t){ if(!it(e,t)) throw new Error(`Extension '...' CANNOT use API proposal: ${t} ... --enable-proposed-api ...`) }
```

但 `product.json` **没有** `extensionEnabledApiProposals` 白名单字段。**因此「第三方扩展能不能用 `trae` proposal」= 未确证**，必须实测（P0 里放一个 10 行的探针扩展 + `--enable-proposed-api` 启动参数）。

即使能用，也只有 `onSessionStopped` 一个点，**无法驱动阶段/工具/脉冲**。

#### (2) 旁路一：`hub_event_cache`（工具级事件，已确证）

路径：

```
~/.trae-cn/hub_event_cache/TraeCode/<hubId>/<messageId>.jsonl
例：~/.trae-cn/hub_event_cache/TraeCode/05867b38-9429-41ac-83d8-1625abcdaa7b/a3e754f2084886872216ddf3.jsonl
```

写入方是原生模块（不是 JS）：

```
/Applications/Trae CN.app/Contents/Resources/app/modules/ai-agent/libharness.dylib   ← strings 里有 "hub_event_cache"
/Applications/Trae CN.app/Contents/Resources/app/modules/ai-agent/libai_agent.dylib
```

每行结构（实测）：

```json
{"task_id":"a3e754...","seq":76,"type":"plan_item","data":"{\"id\":\"pi_...\",\"tool_call_info\":{...},\"agent_status\":{...},\"timing\":{...}}"}
```

- `data` 是**字符串**，需要二次 `JSON.parse`；里面有嵌套对象 `tool_call_info` / `agent_status` / `timing`（**这些是对象，不要再 parse 一次**）。
- 事件类型实测覆盖（两个会话文件，222 + 487 行）：

| type | 次数 | 内容 |
| --- | --- | --- |
| `plan_item` | 116 / 320 | **一次工具调用**：`tool_call_info.{id,name,params,result,meta.llm_toolcall_id}`、`agent_id`、`agent_display_name`、`agent_run_id`、`agent_status.{status,run_mode}`、`timing.generated_at_ms`、`reasoning_content` |
| `timing_events` | 37 / 55 | 模型侧耗时（首 token、网关、重试） |
| `token_usage` | 35 / 54 | `prompt_tokens / completion_tokens / reasoning_tokens / last_turn_total_tokens / max_tokens` |
| `context_usage` | 12 / 53 | 被读取的文件/上下文列表（含 `toolcall_id`、`status`、`uri`） |
| `queuing` / `notification` | 13+5 | 排队状态（`queue_status: begin`、`position`） |
| `metadata` | 1 / 2 | `session_id / turn_id / message_index / agent_type / agent_name` |
| `user_message` | 1 | 用户消息（含正文，**上屏必须丢弃**） |
| `model_config` | 1 | `model_name`（如 `deepseek-v4.1-flash`） |
| `message_context_update` / `append_input` | 少量 | 上下文合并 |

`plan_item.tool_call_info` 实测样例（真实）：

```json
{
  "id": "pi_6aec25c3e4b30e47deefff02",
  "name": "Edit",
  "params": {"file_path": ".../TagService.java", "old_string": "", "new_string": ""},
  "result": {"status": "success", "error_message": "", "data": {...}, "changes": [...]},
  "meta": {"llm_toolcall_id": "call_..."}
}
```

工具分布（两个已缓存会话）：`Read 189 / Edit 149 / Grep 77 / Shell 18 / CompactFake 3` —— **覆盖读取、编辑、搜索、命令，不是只有 shell**。

**实时性证据**：文件最后一条事件 `generated_at_ms` = 14:51:47，文件 mtime = 14:52:11，`seq` 从 1 连续递增到 869 → 是**会话进行中追加写**，可以 tail 增量读。

**已处置（2026-11-07）**：本机所有 TraeCode 会话（含当前这条）都不生成新的 `hub_event_cache` 目录/文件，已确证为 Hub 桥未激活（见 §P0-4）。因此该源不再作为默认实时源，改由 `live_local`（`command-execution` + `renderer.log`）承担；`hub_cache` 保留为 Hub 模式下的可选源。

#### (3) 旁路二：`command-execution`（命令级，已确证，但看不到命令内容）

```
~/Library/Application Support/Trae CN/ModularData/ai-agent/command-execution/<executionId>/
  execution.json     ← 见下
  output.log / stderr.log
  cwd.txt
  sandbox/
```

`execution.json` 实测字段：

```json
{"version":2,"executionId":"a4917df30ccfc67626481805878926ac",
 "ownerHash":"9143bd83d3e8680bd0fd451dd87c7f784ab4f4918d5bc96308190d3fe7a0015d",
 "requestDigest":"2c6cbe3c32854b640143e78b1730e5d62a78eedf90efe55273e34642ce9e8c2e",
 "stdinMode":"closed","captureStderr":false,"target":"host","status":"running","pid":90423,
 "cwd":"/Users/liuzuodong/Documents/Trae-CN/temp_20261106_02","exitCode":null,
 "terminalReason":null,"outputComplete":false,"sandbox":null,
 "createdAtMs":1793975027895,"startedAtMs":1793975027914,"finishedAtMs":null}
```

- 有 `pid / cwd / exitCode / 开始结束时间 / status`，**没有 argv**（`requestDigest` 只是哈希）。
- 本会话的 `ls` 命令刚刚（22:24）也生成了新目录 → **实时性好、可 fs.watch**。
- 用途：**已实现为 `lib/live-source.js` 的主实时源**（`live_local`）。映射：一个工作区目录（`cwd`）= 一个 agent，`running` → `tool.call`，`exited` → `tool.result`（`exitCode === 0` 为成功）；首轮回填 15 分钟内的执行记录。限制：没有命令文本，屏幕只能显示 `Shell · pid <n>` 与工作区目录名，**不编造命令**。会话归属由最新启动的 `renderer.log` 中的 `plan_item` 补充。

#### (4) 旁路三：加密数据库（不可用）

```
~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db   337,010,688 B（约 321 MiB）
```

- `file` 判定为 `data`，前 32 字节随机（`d8 be f1 de 00 a8 21 ac ...`），**不是 `SQLite format 3`**；
- `libharness.dylib` 里同时存在大量 `PRAGMA`/`sqlite_master` 字符串，说明内层确实是 SQLite，外层多半是 SQLCipher/加密壳。
- **结论：不能直接读**。不加入方案（读它等于破解加密库）。

#### (5) 旁路四：日志（只能辅助，不能当事件源）

```
~/Library/Application Support/Trae CN/logs/<session>/window1/renderer.log
~/Library/Application Support/Trae CN/logs/<session>/window1/exthost/exthost.log
~/Library/Application Support/Trae CN/logs/<session>/main.log
```

`renderer.log` 里有 `[ai-chat] doRequestWithStream ... service=lite, method=subscribe_events`，但只有耗时/方法名，**没有工具参数或阶段**。适合排障，不适合驱动大屏。

#### (6) 本地端口 / IPC：查到线索，但都不建议用

| 线索 | 证据 | 判断 |
| --- | --- | --- |
| `modules/ai-agent/meta.json` 声明 `connections: [{socket:{port:40005}}]`，`start.sh` 里 `exec ./ai-agent` | `/Applications/Trae CN.app/.../modules/ai-agent/{meta.json,start.sh}` | 实测 40005 **未监听**，`ps` 也**未**看到独立 `ai-agent` 进程 → 当前会话下该模块没以可外部访问的形态运行（到底是进程内还是未启动：**未确证**） |
| 两个监听端口 | `lsof`: 54905（WebSocket，回 `WebSockets request was expected`）、58904（HTTP，返回 404） | 用途**未确证**（疑似 Trae Ports / DevTools 相关） |
| `[ai-chat] ... service=lite, method=subscribe_events` | renderer.log + `workbench.desktop.main.js` 里 `_transportManager.executeRequest` | 事件确实通过 RPC 从 `lite` 服务取，但传输是**进程内 IPC / AHA**，没有公开协议 |
| `AHA_IPC_SERVICE_NAME=ai-agent`、`ENABLE_IPC_SERVER=true`、`CKG_PORT=51000` | `~/.trae-cn/toolhost/native-runcommand-snapshots/process-97272-1793617526890/zsh-profile-snapshot.sh` | 内部 IPC 环境变量，**未公开、未文档化** |

**结论：不接这些私有通道。** 它们会随版本变化、可能违反使用条款，且失败时没有降级空间。

### 1.5 安全与权限模型

| 项 | 实测结论 | 证据 |
| --- | --- | --- |
| 扩展安装 | 侧载自由，无手动信任弹窗；26 个第三方扩展已在用 | `~/.trae-cn/extensions/extensions.json` |
| 文件系统 | 扩展宿主是 Node 进程，`fs` 可读任意路径（含 `~/Library/Application Support/Trae CN/**`） | 本方案实测读取 |
| 网络 | 无沙箱限制 | 同上 |
| Workspace Trust | 只影响任务/调试等，不影响 Node `fs` | `settings.json` 里 `security.workspace.trust.untrustedFiles: "open"` |
| 扩展「信任发布者」白名单 | 只有 `microsoft` / `github`（影响徽标/信任展示，不阻止安装） | `product.json` → `trustedExtensionPublishers` |
| Webview | 我们自己的 webview 自己写 CSP；本地资源必须走 `asWebviewUri` | `vscode.d.ts` L9906/L10013 |
| Trae 私有 API | proposed，需 `--enable-proposed-api`；白名单缺失 | `product.json`、`extensionHostProcess.js` |

**合规建议**：只读；不写 Trae 配置、不改 `~/.trae-cn` 状态；`reasoning_content` 与用户正文一律不上屏、不落盘。

---

## 2. NEBULA 渲染层复用方案

### 2.1 可以直接搬（不改一行）

| dsh 文件 | 目标位置 | 说明 |
| --- | --- | --- |
| `runtime/nebula/template.html` | `media/nebula/template.html` | 原主题 HTML + CSS（`#tpl-nebula`，Shadow DOM 宿主） |
| `runtime/nebula/theme.js` | `media/nebula/theme.js` | 1,290 行渲染层，只保留 `mountNebula(host, SR)` 入口 |
| `runtime/nebula/vendor/*.js` | `media/nebula/vendor/` | three 0.147 + EffectComposer + UnrealBloomPass + Copy/Render/LuminosityHighPass/ShaderPass，本地化离线可用 |
| `runtime/nebula-core.js` | `media/nebula-core.js` | 纯函数 `planSnapshot(snapshot, prev)`，把快照 → 星云/词/日志模型 |
| `runtime/screen.html` | `media/screen.html` | `__SCREEN_CSS__ / __SCREEN_JS__ / __SCREEN_CONFIG__` 三占位模板 |
| `runtime/screen.css` | `media/screen.css` | 大屏外层 UI |
| `runtime/screen.js` | `media/screen.js`（改数据来源） | 现通过 `fetch/EventSource` 拉数据；改为接收 `window.postMessage` 快照 + 用 `acquireVsCodeApi()` 回传就绪/键盘 |
| `lib/state.js` | `src/state/store.ts`（TS 化或直接保留 JS） | `createStore(options)` 是**纯函数、无宿主依赖**，`apply → snapshot()` 的契约可直接复用 |

`lib/state.js` 里 `snapshot()` 的输出形状（`agents[] / timeline[] / events[] / primary / lastEventAt`）就是渲染层的输入契约，**这个契约不要动**，NEBULA 侧零改动。

### 2.2 需要新写的适配层

```
agent-display/trae-ide-ext/                ← 新子目录，独立，不碰旧实现
  package.json                              ← VS Code 扩展清单（contributes.commands/views）
  tsconfig.json / esbuild.mjs               ← 打包成单文件 out/extension.js（CJS）
  src/extension.ts                          ← activate/deactivate、注册命令与面板
  src/panel.ts                              ← WebviewPanel 生命周期、HTML 拼装（复用 lib/screen.js 的 renderScreenHtml）
  src/sources/types.ts                      ← 归一化事件类型（见下）
  src/sources/hub-cache.ts                  ← 旁路一：tail JSONL（主数据源）
  src/sources/command-exec.ts               ← 旁路二：监听 execution.json（补 Shell 结果 / 心跳）
  src/sources/mock.ts                       ← 回放两份真实 jsonl（演示与验收，不造假数据）
  src/state/map.ts                          ← Trae 事件 → dsh snapshot 字段
  src/state/store.ts                        ← 移植 lib/state.js
  media/                                    ← 上面 §2.1 搬过来的运行时
```

**适配层接口**（这是本方案唯一的新契约）：

```ts
export type SourceKind = 'hub-cache' | 'command-exec' | 'mock' | 'hook'

export type TraeEvent =
  | { kind: 'session.start';   at: number; taskId: string; sessionId?: string; agentId: string; agentName: string; model?: string }
  | { kind: 'tool.call';       at: number; taskId: string; callId: string; tool: string; detail: string; source: SourceKind }
  | { kind: 'tool.result';     at: number; callId: string; ok: boolean; error?: string; durationMs?: number; resultSummary?: string; exitCode?: number }
  | { kind: 'step.note';       at: number; taskId: string; text: string }        // plan_item.thought / 阶段播报（脱敏后）
  | { kind: 'usage';           at: number; inputTokens: number; outputTokens: number }
  | { kind: 'queue';           at: number; status: 'begin' | 'end'; position?: number }
  | { kind: 'turn.end';        at: number; taskId: string; reason: 'completed' | 'failed' | 'stopped' | 'unknown' }

export interface EventSource {
  readonly kind: SourceKind
  /** 增量推送；返回取消函数。实现内部负责 watchdog/断线重连。 */
  start(emit: (ev: TraeEvent) => void): () => void
  /** 冷启动补齐（只回放终态，不补动画）。 */
  hydrate?(): Promise<TraeEvent[]>
}
```

`HubCacheSource` 关键实现点（都已实测过格式）：

1. 轮询/watch `~/.trae-cn/hub_event_cache/TraeCode/*/*.jsonl`（macOS 上 `fs.watch` 对该目录可靠，仍加 1s 兜底扫描）。
2. 每个文件记录 `{inode, offset, seenSeq}`；只读新增字节，按 `\n` 切分，遇半行**丢掉半行并回退 offset**（避免读到写一半的行）。
3. 逐行 `JSON.parse` → `data` 再做一次 `JSON.parse`（`data` 是字符串；`tool_call_info/agent_status/timing` 是已解析对象）。
4. 幂等键 `(task_id, seq)`，去重；`plan_item.id` 作为 `callId`（一个 `plan_item` 一次工具调用）。
5. `tool_call_info.result.status !== ''` → 同时产出 `tool.call` + `tool.result`（同一 `at`，`result.status === 'success'` 判 ok，否则 error + `error_message`）。
6. **丢弃**：`reasoning_content`、`user_message.content`、`params.old_string/new_string`、`result.data.changes[].old_content/new_content`（只保留 `file_path` 的 basename、行号范围、状态）。

`CommandExecSource`：

- watch `ModularData/ai-agent/command-execution/`，新目录 → `tool.call {tool:'Shell', detail: basename(cwd)}`；
- `execution.json.status: 'running' → 'exited'` 或文件 mtime 变化 → `tool.result {exitCode, durationMs}`；
- `pid + createdAtMs` 在运行时可尝试 `ps -p <pid> -o args=` 抓 argv（**可选、不可靠，短命令会丢失**，默认关闭，标 `experimental`）。

### 2.3 字段映射表（Trae → 现有 agent/phase/timeline）

| NEBULA / snapshot 字段 | Trae 数据来源 | 规则 |
| --- | --- | --- |
| `agents[].id` | `hub file 的 task_id` 或 `metadata.session_id` | 一个 task 一个槽位；最多 12 个活跃 task |
| `agents[].label` | 阶段中文 + 工具名 | `调用工具 · Edit`；来源是状态机，不是 Trae 原文 |
| `agents[].phase` | 派生的 5 态状态机 | 见下 |
| `agents[].model` | `model_config.model_name` / `timing_events.model_name` | 直接取 |
| `agents[].turn / step` | `metadata.message_index` + `plan_item` 计数 | `turn = message_index`，`step = 本 task 的 plan_item 序` |
| `agents[].usage.inputTokens/outputTokens` | `token_usage.prompt_tokens / completion_tokens` | 累加或取 `*_total` |
| `agents[].activeTool.{name,detail}` | `plan_item.tool_call_info.name` + `params` 摘要 | `Read/Grep/Edit/Shell` + 文件名/行号/cwd |
| `agents[].timeline[]` | 每个 `plan_item` 一条 | `status: running/ok/error` ← `result.status` |
| `agents[].timeline[].durationMs` | `timing.generated_at_ms` 差 或 `command-execution` 的 `startedAtMs/finishedAtMs` | Shell 优先用后者（真实） |
| `agents[].error` | `result.error_message` | 截断 80 字，不含堆栈 |
| `events[]` | `plan_item` / `queuing` / `token_usage` 摘要 | 一行一句，不上正文 |
| `snapshot.primary` | 最近有事件的 task | 排序用 `updatedAt` |
| **星核 `AG[0]`** | 扩展自身状态 | `LISTENING / NO DATA / PAUSED / OFFLINE / AUTH?`（无鉴权，去掉 AUTH） |
| **`AG[1..12]`** | 活跃 task | 空槽保持 `IDLE` 中性 |
| **星云蛛 `CRAWLER`** | 只读巡检 | 只在真实 `tool.call` 间移动 |

**阶段派生（必须诚实，只写能证明的）**：

```
收到 session.start 或新 plan_item              → thinking
tool.call 已发出、result 未回                   → tool
tool.result 回来                                → thinking
queuing(queue_status=begin)                     → queued（新增态：排队等模型）
最后一次活动 > idleAfterMs（默认 20s）且无 running → done → 6s 后 idle
result.status != success                        → failed（闪一次后回 thinking）
```

**明确缺失（不要伪造）**：

| 想要的状态 | 为什么没有 | 处理 |
| --- | --- | --- |
| `等待确认`（approval） | Trae 的确认交互不落任何旁路文件，也没有 API | **不显示**。若非要，只能靠屏幕截图/UI 自动化，属于另一条脆弱路径，本方案不做 |
| `等待输入` | 没有 `turn/end` 事件；`agent_status` 实测几乎全是 `running`（436 条里只有 1 条 `completed`） | 用「静默 N 秒」近似，文案写「静默 / 等待中」，不写「等待你输入」 |
| thinking 的流式输出 | `reasoning_content` 有，但属隐私且量大 | 只做「思考中」阶段灯，不上屏文字 |
| agent → agent 委派关系 | 两个缓存文件里 `agent_id` 全为 `solo_agent`、`sub_agent_call_description: None` | 不画连线（沿用 dsh 的诚实边界） |
| 多 agent 阵列 | 单 task 内只有一个 agent | 槽位 = **活跃 task 数**，不是「多 agent」，标签写 `TASK` 而非 `AGENT` |
| 打开页面前的历史脉冲 | JSONL 可回放 | `hydrate()` 只补终态，不补脉冲（防止一打开就满屏假动作） |

### 2.4 Webview 里的接线方式（不引入 HTTP）

```
HubCacheSource ─┐
CommandExecSource ─┼→ store.apply(ev) → snapshot() ─(节流 5Hz)→ panel.webview.postMessage({type:'state', snapshot})
MockSource ─────┘                                              ↑
                                        webview: window.addEventListener('message') → setSnapshot(snapshot)
                                                 ctrl.setSnapshot(planSnapshot(snapshot, prev))   ← nebula-core 原样
```

- 不监听端口、不发 token、不落盘页面 → 比 dsh 的 HTTP+SSE 更安全，也少一个失败点。
- 同时保留 dsh 的 `lib/screen.js renderScreenHtml()`，把 `template/css/js/config` 拼成单页 HTML（CSP nonce + 资源全部内联，避开 `asWebviewUri` 路径问题）。
- `retainContextWhenHidden: false`（省内存），重新可见时 `postMessage({type:'resync', snapshot})`，`ctrl.resync()` 会跳过旧动画。
- 暂停/继续：沿用 `ctrl.setPaused()`。
- 主题：默认 `galaxy`（NEBULA），保留 `neon/mono` 作为低配回退（面板隐藏时切 `mono` 可省 GPU）。

---

## 3. 分阶段实施计划

### P0 —— 最小可运行（半天量级）

**做**：

1. `trae-ide-ext/` 骨架 + `package.json`（`contributes.commands: agentStatus.open`）。
2. `MockSource`：把两份真实 JSONL（11-05 会话）按 10× 速度回放。
3. 面板能开、NEBULA 能渲染、mock 能驱动阶段/脉冲。
4. 探针：`enabledApiProposals: ["trae"]`，`console.log(typeof vscode.trae, Object.keys(vscode.trae?.hooks ?? {}))`。
5. 实测 hub cache 实时性：在一次普通 IDE 对话里跑 3 个工具调用，观察目录是否新增/追加。

**验收**：

- 命令面板能开面板；关闭重开不崩；`ctrl.debug()` 有 `glOK: true`、`fps ≥ 30`（1440×900 面板）；
- mock 回放出现「Edit → Grep → Shell」真实词条与真实耗时；
- `hub_event_cache` 目录 mtime 在对话期间变化（**这一条不过，整个实时方案就降级为「历史回放 + 命令心跳」**）；
- 探针结论二选一：`vscode.trae.hooks` 可用 / 不可用（写进结论表）。

**成本**：0 新依赖（three/vendor 已有），只在用户目录写扩展目录：
`~/.trae-cn/extensions/trae.agent-status-0.1.0/`（或 `--extensions-dir` 指向临时目录做隔离测试，推荐后者）。
**不做**：不写 `.trae-cn` 配置、不装到 Trae 安装目录。

### P1 —— 真实事件接入

**做**：

1. `HubCacheSource`：offset tail + 幂等去重 + 半行回退 + 字段脱敏。
2. `store` 状态机（移植 `lib/state.js`，补 `queued` 态）。
3. `agents[]` 按 task 分配槽位（粘滞，≤12）。
4. 顶部信息条：`连接状态 / 模型 / 轮次 / tokens / 工具数 / 成功率`。
5. 断流：连续 N 秒无新行 → `SILENT`；目录消失 → `OFFLINE`；写「未确证」提示条（不是假数据）。

**验收**：

- 真实对话中：`Read` 出现 → 词条 + 连线脉冲；`result.status: success` → 词条转 `fix`；`error` → `flag` + 顶部成功率下降；
- `token_usage` 更新与顶部数字一致（逐条对拍）；
- 关闭 Trae 再开：不重复补播历史脉冲；
- 隐私自查：抓取 webview 的 `postMessage`，确认不含 `reasoning_content` / `user_message.content` / `old_string` / `new_content`；
- 单测：`node --test` 针对 `hub-cache` 解析（复用 dsh 的 fixtures 风格），覆盖半行、坏行、乱序 `seq`、重复行。

### P2 —— 双源合并 + 兜底

**做**：

1. `CommandExecSource` 合并：`Shell` 调用优先用 `execution.json` 的真实 `exitCode/durationMs`；hub cache 缺失时仍能显示「有命令在跑」。
2. watchdog：文件被轮转/删除 → 重新发现；事件时间戳乱序 → 按 `at` 重排，丢弃 > 8s 的旧脉冲（沿用 dsh 规则）。
3. 状态栏 HUD：`$(pulse) 调用工具 · Edit` / `$(check) 完成`。
4. `experimental`：`ps` 抓短命进程 argv（默认关闭，开关写在设置项）。

**验收**：

- 人为 `mv` 掉缓存目录 → 大屏进 `OFFLINE` 且不冻结；恢复后自动回 `LISTENING`；
- `Shell` 词条耗时与 `execution.json` 的 `finishedAtMs - startedAtMs` 误差 < 100ms；
- 状态栏与面板阶段一致、颜色随阶段变。

### P3 —— 性能与打包

**做**：

1. 性能：DPR 上限 1.75（沿用）、30fps 三次降级到 DPR 1 → 0.75 → 关 bloom；面板隐藏停 rAF；`retainContextWhenHidden: false`；快照节流 5Hz、只推增量字段。
2. 打包：`esbuild` → 单文件 `out/extension.js`；`npx @vscode/vsce package` 出 `.vsix`。
3. 安装/卸载脚本（放 `agent-display/trae-ide-ext/scripts/`）：只写 `~/.trae-cn/extensions/`，提供 `--extensions-dir` 隔离模式。
4. 文档：安装、开关、降级、已知限制、版本兼容（`engines.vscode` 对齐 1.107）。

**验收**：

- 1440×900 面板 30 分钟稳定，内存增长 < 30 MB，无 WebGL context lost 未恢复；
- 全屏 2560×1440 + bloom 不掉到 30fps 以下（不达标就默认 `DPR 1.25 + 关 bloom`）；
- `code --install-extension trae-ide-ext/dist/agent-status-0.1.0.vsix` 一键装、`--uninstall-extension` 一键卸；
- 打包后扩展目录 < 8 MB（vendor 已有 ~1 MB three，其余 CSS/JS 很小）。

---

## 4. 不做的事 / 风险 / 未确证清单

### 4.1 明确不做

1. **不改 Trae 安装目录**（`/Applications/Trae CN.app/**` 只读）。
2. **不改 `~/.trae-cn` 的配置**（`settings.json`、`plugin-config.json`、`installed-plugins.json` 一律不写）。
3. **不覆盖** `agent-display/index.html`、`openclaw-plugin-agent-display`、`dsh-agent-status`；新代码独立在 `trae-ide-ext/`。
4. **不读 `database.db`**（加密库）。
5. **不接私有 IPC / RPC / 端口**（40005 / 54905 / 58904 / AHA / CKG 51000）。
6. **不伪造状态**：不显示「等待确认」、不画 agent 间委派连线、不生成假 agent、不补放历史动画。
7. **不上屏正文与推理内容**（`reasoning_content`、用户消息、diff 正文）。
8. **不提交远程仓库**。
9. **不做写操作**：不拦工具、不代发消息、不改会话。
10. **不把 Trae Agent 插件当 UI 载体**（它没有 UI 能力；最多作为「安装器 + 打开大屏」的 MCP 入口，属可选附加件）。

### 4.2 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `hub_event_cache` 是内部调试产物，可能被裁剪/改名/清理 | 实时性直接归零 | P0 先验；退化为「历史回放 + command-execution 心跳」；把源抽象成接口，可换 |
| JSONL schema 随版本变化（Rust 结构体序列化） | 解析失败 | 防御式解析（字段缺失即降级）；`version`/`seq` 做兼容；解析失败只在状态条提示，不崩面板 |
| 大文件长会话（487 行 → 数万行） | 尾部 offset 读、单行大 `data`（`result.data` 可能几百 KB） | 只取需要的键、丢弃 `data/changes/old_content`，单行 > 256 KB 直接跳过并计数 |
| 隐私 | 推理链/代码内容泄露 | 白名单提取，不转发原文；可选「脱敏严格模式」 |
| WebGL 在 webview 里被节流 | 大屏卡顿 | 默认 DPR 1.75 + bloom 自动关；面板隐藏即停 |
| 扩展宿主多一个常驻 watcher | 内存/CPU | 1s 扫描 + `fs.watch` 双保险，无事件时零渲染 |
| 升级易碎（3.4.15 → 之后版本） | 全部旁路失效 | 版本探测 + 明确「兼容 3.4.15」；失败可见，不静默 |
| 分发摩擦 | 用户要手动装 `.vsix` | 提供脚本 + 一键命令；可选做 Trae 插件壳（skill 教 Agent 怎么装/打开），但**不能**替用户装 |
| 签名/信任 | 未签名扩展可能有提示 | 本地 `.vsix` 手装即可；不做自动更新 |

### 4.3 未确证清单（需要实测或你提供信息）

| # | 未确证项 | 现状证据 | 需要什么 |
| --- | --- | --- | --- |
| 1 | `hub_event_cache` 在当前版本/当前模式下是否**实时写入** | 11-05 两个会话文件确证有完整工具事件；11-06 当前会话**没有**新目录 | 你在 Trae 里跑一轮普通 IDE 对话（3~5 个工具调用），我再查目录是否新增/追加 |
| 2 | 第三方扩展能否启用 `trae` proposed API（`hooks.onSessionStopped`） | gate 函数恒真，但 `product.json` 无白名单 | 允许我放一个 10 行探针扩展 + `--enable-proposed-api` 启动一次 |
| 3 | webview 内 three.js + UnrealBloom 的真实帧率 | 机制上支持，未实测 | P0 面板实测（我可跑，但需要允许写扩展目录） |
| 4 | Trae Agent 插件的 `mcpServers` / `instructions` 具体 schema | 5 个官方样例均为 `null` | 若有官方插件开发文档/样例，给我路径 |
| 5 | 54905 / 58904 两个本地端口用途 | 只有协议探测结果 | 如你知道它们是什么，告诉我；否则不用 |
| 6 | `command-execution` 是否覆盖**所有**工具（还是只有 Shell） | 只有 `execution.json`，没有 argv | P1 时对比：同一次对话里 hub 的 `Shell` 条数 vs `command-execution` 目录数 |

---

## 附录 A：证据路径索引

**Trae 安装侧（只读）**

- `.../app/product.json` —— `vscodeVersion 1.107.1`、`dataFolderName .trae-cn`、`extensionsGallery open-vsx`、**无** `extensionEnabledApiProposals`
- `.../app/out/vscode-dts/vscode.d.ts` —— L11525 `createWebviewPanel`；L11719 `registerWebviewPanelSerializer`；L11730 `registerWebviewViewProvider`；L9906 `localResourceRoots`；L10013 `asWebviewUri`；L10046 `retainContextWhenHidden`；L20042/L20050 `chat.createChatParticipant`；L20663 `lm`
- `.../app/out/vs/workbench/api/node/extensionHostProcess.js` —— 偏移 1,810,452~1,810,779（trae 对象：`registerMcpProvider/registerMcpServerDefinition/registerMcpTransportServer/hooks.onSessionStopped`）；偏移 2,104,708（`ExtensionHostAgentService`）；偏移 631,218（proposed API gate）
- `.../app/extensions/byted-solo.builtin-mcp/package.json` —— `enabledApiProposals: ["trae"]`
- `.../app/extensions/byted-solo.builtin-mcp/dist/extension.js` —— L215 / L1322 / L1467 / L1854 的 `trae.*` 调用
- `.../app/extensions/cloudide.dsl-agent-logs/package.json` —— `views` + `type: "webview"`（Trae 内 webview 存活的直接证据）
- `.../app/extensions/cloudide.icube-devtool-ports/{package.json,dist/extension.js}` —— `createWebviewPanel` / `registerWebviewViewProvider`
- `.../app/modules/ai-agent/meta.json` —— `connections: [{socket:{port:40005}}]`（运行时未监听）
- `.../app/modules/ai-agent/start.sh` —— `DB_PATH=$ICUBE_MODULAR_DATA_DIR/ai-agent/database.db`、`FILE_BASE_DIR=.../snapshot`

**用户侧数据（只读）**

- `~/.trae-cn/hub_event_cache/TraeCode/05867b38-9429-41ac-83d8-1625abcdaa7b/a3e754f2084886872216ddf3.jsonl`（222 行）
- `~/.trae-cn/hub_event_cache/TraeCode/05867b38-9429-41ac-83d8-1625abcdaa7b/6aec23ede4b30e47deeffe13.jsonl`（487 行）
- `~/Library/Application Support/Trae CN/ModularData/ai-agent/command-execution/<id>/{execution.json,output.log,cwd.txt}`
- `~/Library/Application Support/Trae CN/ModularData/ai-agent/inbox/<sessionHash>/{next,later}/messages.jsonl`（跨会话消息，非工具事件）
- `~/Library/Application Support/Trae CN/ModularData/ai-agent/snapshot/<sessionHash>/v2/.git`（文件快照 git，非事件；hash 为 24 位，非 32 位 session id）
- `~/Library/Application Support/Trae CN/ModularData/ai-agent/database.db`（337,010,688 B，头部非 SQLite → 不可读）
- `~/Library/Application Support/Trae CN/logs/<session>/window1/renderer.log`（`[ai-chat] ... subscribe_events`）
- `~/.trae-cn/toolhost/native-runcommand-snapshots/process-97272-1793617526890/zsh-profile-snapshot.sh`（`AHA_IPC_SERVICE_NAME=ai-agent` / `CKG_PORT=51000` / `ENABLE_IPC_SERVER=true`）
- `~/.trae-cn/extensions/extensions.json`（26 个第三方扩展，侧载已在使用）
- `~/.trae-cn/plugins/trae-remote-official/lark/1.0.7/.trae-plugin/plugin.json`（Agent 插件完整清单）
- `~/.trae-cn/installed-plugins.json`（`manifest_json` 字段全集）
- `~/.trae-cn/plugins/trae-remote-official/office-plugin-mac/0.1.0/.trae-plugin/plugin.json`（最小 skills-only 插件）

**复用源码**

- `/Users/liuzuodong/Documents/workspace/agent-display/dsh-agent-status/runtime/nebula/template.html`
- `.../runtime/nebula/theme.js`（L1 `mountNebula(host, SR)`；尾部 `ctrl = { setSnapshot, setTransport, setPaused, setWaiting, resync, debug, destroy }`）
- `.../runtime/nebula-core.js`（`globalThis.__DSH_NEBULA_CORE__`，`planSnapshot`）
- `.../runtime/screen.html / screen.css / screen.js`
- `.../lib/state.js`（`createStore` 纯状态机）、`.../lib/screen.js`（`renderScreenHtml`）
- `.../index.js` L216-L226（vendor 拼接 + `globalThis.DSHNebulaMount = mountNebula`）

## 附录 B：目录与命令（规划）

```
/Users/liuzuodong/Documents/workspace/agent-display/
  docs/trae-plugin-plan.md               ← 本文
  dsh-agent-status/                      ← 现有 Harness 版，不动
  trae-ide-ext/                          ← 新建（P0 起）
```

隔离测试（不污染真实扩展目录）：

```bash
"/Applications/Trae CN.app/Contents/Resources/app/bin/code" \
  --extensions-dir /tmp/trae-ext-test \
  --user-data-dir /tmp/trae-user-test \
  --enable-proposed-api trae.agent-status   # 仅探针用
```

正式安装：

```bash
cd trae-ide-ext && npx @vscode/vsce package
"/Applications/Trae CN.app/Contents/Resources/app/bin/code" --install-extension dist/agent-status-0.1.0.vsix
# 目标落盘位置：~/.trae-cn/extensions/trae.agent-status-0.1.0/
```

卸载：

```bash
"/Applications/Trae CN.app/Contents/Resources/app/bin/code" --uninstall-extension trae.agent-status
```

## P1.7 「重启后仍看不到插件」根因排查（2026-11-07）

### 结论（结论先行）

1. **安装位置正确**：`trae.agent-status` 与 prettier/eslint/volar 同源——都在 `~/.trae-cn/extensions/`，`extensions.json` 里 `location.path` 指向同一个目录；不存在独立 profile（`User/profiles/` 为空，`profileAssociations` 为空）。
2. **没有被禁用**：`extensions.json` 无 disabled/enablement 记录；publisher `trae` 未被 `extensions.trustedPublishers` 排除影响（受限名单只影响「信任提示」，不会静默忽略扩展）。
3. **扩展确实被加载并激活**：用户环境日志
   `~/Library/Application Support/Trae CN/logs/20261107T003753/window1/exthost/exthost.log`
   第 45 行 `00:46:39.140 _doActivateExtension trae.agent-status, startup: false, activationEvent: 'onStartupFinished'`，
   重载后第 461 行 `00:51:15.416` 再次激活；`window2`（IDE，`neural-knowledge-base`）`00:38:20` 也激活；全程无 error。
   `User/globalStorage/trae.agent-status/probe.json` 同时刻写入，证明 `activate()` 已执行。
4. **可复现的失败根因：受限模式（工作区未信任）**。隔离实例中同一份包：
   - 未声明 `capabilities.untrustedWorkspaces` 时，扩展被 `Creating extension host` 列入但**从不 `_doActivateExtension`** → 命令面板无命令、状态栏无 NEBULA，与用户症状完全一致；
   - 声明 `"untrustedWorkspaces": { "supported": true }` 后，受限模式下立即激活，状态栏出现 `NEBULA · OFFLINE`，Activity Bar 图标可点开视图。
   → 已在 `package.json` 增加 `capabilities`（含 `virtualWorkspaces`）并补充显式 `activationEvents`（`onCommand:*` / `onView:*`）。

### 隔离实例实测（不碰用户窗口）

- 目录：`--user-data-dir=/tmp/iso6-ud --extensions-dir=/tmp/iso-ext`，打开 `agent-display`，末信任（受限模式）
- 日志：`_doActivateExtension trae.agent-status` 在受限模式下出现（修复前后对比：`/tmp/iso5-ud` 无、`/tmp/iso6-ud` 有）
- 状态栏实测：`trae-isolated-baseline.png` 左下角可见 `NEBULA · OFFLINE`
- Activity Bar 实测：DOM 存在 `aria-label="NEBULA"` 的 `.action-label`，点击后 `hasWebview: true`，`trae-isolated-activity-view.png` 显示侧边视图已渲染「星核蜘蛛 · LIVE」大屏
- 命令注册：`smoke.json`（`NEBULA_SMOKE=1`）
  `commands=['agentStatus.view.open','agentStatus.view.focus','agentStatus.view.resetViewLocation','agentStatus.view.toggleVisibility','agentStatus.view.removeView','agentStatus.open','agentStatus.openView','agentStatus.reload','agentStatus.toggleMock','agentStatus.debug']`，
  `openOk=true, viewFocusOk=true, panelReady=true, viewReady=true`

### 仍需用户侧证据的一条

日志只能证明「扩展被激活」，不能证明「用户当前屏幕的状态栏是否渲染」。若用户重载后仍看不到，请提供：
- 当前窗口左下角状态栏截图（看是否有 `NEBULA` 文案 / 「受限模式」字样）
- 或执行命令 `Agent Status: 输出诊断信息`，确认 `User/globalStorage/trae.agent-status/debug.json` 生成

### Activity Bar 入口

`contributes.viewsContainers.activitybar`（id `agentStatusBar`，title `NEBULA`，icon `media/icon.svg`）+ `contributes.views`（`agentStatus.view`，`type: webview`，name `作战大屏`）。状态栏项保留为次要入口。

### 2026-11-07 `live_local` 落地验证记录

- **fixture 双源断言**：`source.kind=live_local`、`state=live`（运行中的 execution 计入 live）；workspace 会话 `toolCalls=3`、失败调用 `ok=false`；`sessions[]` 带 `label`。
- **三档几何**：1600×1000 / 760×900 / 480×800 下 `session-bar`、`m-sess` 的 overlaps 均为 `[]`；会话芯片 `title` 含完整名称。
- **累计完成跟随会话**：生产实例「全部」= 50，选中某会话 = 13，切回「全部」= 50；窄屏 = 2。
- **真实时间流**（2026-11-07 本地时间，证据 `docs/evidence/live-timeline.json`）：

  | 时间 | source.state | workspace toolCalls | 最新事件 |
  | --- | --- | --- | --- |
  | 22:58:23.732 | live | 15 | Shell · pid 44140 |
  | 22:58:25.485 | live | 16 | Shell · pid 44149 |
  | 22:58:26.273 | live | 16 | Shell 已返回 |
  | 22:58:31.650 | live | 17 | Shell · pid 44161 |

  即：执行命令后约 1 个轮询周期（≤1s）内出现在大屏，不再是 SILENT。
- **路径回归**：`/nebula-screen/screen` = 200；`/dsh-agent-status/...` = 302。
- **WebGL**：无 GL 时仅显示居中占位；headless 截图（`--disable-gpu`）必然触发占位；真机 Trae webview 有 WebGL（P0 已测 60fps），本次未改降级代码。
