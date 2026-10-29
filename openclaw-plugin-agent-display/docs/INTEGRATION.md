# agent作战大屏 · OpenClaw 接入方案

## 1. 目标

将仓库根目录的 `index.html`（10 套主题的 Agent 战术大屏）作为 **OpenClaw 原生插件页面**接入 Control UI，并将主题核心数据绑定到真实 OpenClaw 快照。

约束：

- 不改变原项目 `index.html` 的视觉设计、布局与动效；只新增实时数据钩子（`host.__dqApply` / `host.__dqPaint`）。
- 不引入常驻外部服务；插件随 Gateway 启停。
- 不复制 Control UI 的鉴权逻辑；页面复用当前 Control UI 登录态，通过已认证 RPC 获取带签名 token 的 iframe URL。
- 10 套主题全部接入真实 agents、sessions、channels、jobs、cases 数据；PARK / HQ 保留 3D 模拟循环，只覆盖业务层。

## 2. 为什么不是别的方案

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| Website widget（`iframe src`） | 不采用 | 需要 HTTPS 或 loopback 源；Control UI 运行在 Gateway 自身，跨源绝对 URL 场景下相对资源、鉴权和 CSP 都更复杂。 |
| Session Dashboard widget（sandboxed HTML） | 不采用 | 沙箱内不能直接调 Gateway RPC；大屏依赖内联脚本和 Three.js CDN，沙箱会限制。 |
| **Feature plugin + 原生页面 + Gateway 路由 + 同源 iframe** | **采用** | 页面是 Control UI 原生导航页，iframe 同源加载 Gateway 路由；路由可独立控制 CSP，数据通过 `postMessage` 注入。 |

关键发现：

- Control UI 的 CSP 明确禁止内联脚本：

  ```text
  script-src 'self' 'sha256-...' 'sha256-...' 'wasm-unsafe-eval'
  ```

  因此不能把大屏 HTML 直接塞进原生页面或 `srcdoc`，内联 `<script>` 会被浏览器拦截。

- Control UI 的 CSP 允许同源 iframe：

  ```text
  frame-src 'self' blob: http: https:
  ```

- Gateway 自身对 Control UI 返回 `X-Frame-Options: DENY`；插件路由单独返回 `SAMEORIGIN`。实测 Gateway 不会覆盖插件路由的响应头。

## 3. 架构

```text
┌──────────────────────────── OpenClaw Control UI ────────────────────────────┐
│  Sidebar: agent作战大屏                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ plugin:agent-display page (React shell)                              │  │
│  │  <iframe src="/plugins/agent-display/dashboard">                    │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │ 原始大屏 HTML + 8 主题 + Three.js                               │  │  │
│  │  │ + theme-data 真实数据合并层                                     │  │  │
│  │  │ + OPENCLAW LIVE 浮层（bridge）                                  │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│         ▲ postMessage({type:"agent-display:snapshot", snapshot})                  │
│         │                                                                    │
│  ┌──────┴───────────────────────────────────────────────────────────────┐  │
│  │ data adapter (control-ui.ts)                                         │  │
│  │  host.request / host.onEvent / host.subscribe                        │  │
│  └──────┬───────────────────────────────────────────────────────────────┘  │
└─────────┼──────────────────────────────────────────────────────────────────┘
          │ Gateway RPC (operator session)
┌─────────▼──────────────────────────────────────────────────────────────────┐
│ Gateway                                                                     │
│  health · status · channels.status · usage.cost · sessions.list             │
│  agents.list · cron.list · models.list · session.message events             │
│                                                                             │
│  HTTP: GET /plugins/agent-display/dashboard                                 │
│    auth: "plugin" · signed token · CSP · X-Frame-Options: SAMEORIGIN        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 请求流程

1. Control UI 加载插件前端资源，注册导航项和页面 `agent-display`。
2. 页面调用已认证的 `info` query（内部为 `plugins.sessionAction`），取得带签名 token 的 iframe URL。
3. 页面挂载 iframe，`src="/plugins/agent-display/dashboard?token=..."`。
4. 插件路由校验 token，返回内嵌的大屏 HTML；token 只用于加载静态 HTML，不授予 RPC 权限。
5. 大屏加载完成后，bridge 向父页面发送 `agent-display:ready`。
6. 父页面立即采集一次快照，并通过 `postMessage` 发送 `agent-display:snapshot`。
7. bridge 将快照写入 `window.__DQ_SET_SNAPSHOT__`，并调用 `window.__DQ_APPLY__`；theme-data 把真实数据合并进当前主题的 `AGENTS/CONFIG/CASES/...` 数据，随后重绘主题。
8. bridge 同时渲染右下角浮层；首条快照到达时自动展开 5 秒。
9. 之后每 3 秒轮询一次；`session.message` 事件和 `host.subscribe` 事件触发增量刷新与主题重绘。

## 4. 数据映射

| 快照字段 | 来源 | 说明 |
| --- | --- | --- |
| `gateway.ok` | `health` | `health.ok === true` |
| `gateway.version` | `health` | Gateway 版本 |
| `gateway.uptimeMs` | `health` / `status` | 网关运行时长 |
| `metrics.agents` | `agents.list` / `host.agents.rows` | Agent 总数 |
| `metrics.activeAgents` | `agents.list` | `status === "active"` 的数量 |
| `metrics.activeSessions` | `sessions.list {activeOnly:true,limit:1}` | 返回的 `totalCount` |
| `metrics.totalSessions` | `sessions.list` | `totalCount`；失败时用 `status.sessions.count` |
| `metrics.channelsOnline` | `channels.status` | `connected === true` 或 `status === "connected"` |
| `metrics.channelsTotal` | `channels.status` | 渠道总数 |
| `metrics.tokens` | `usage.cost {agentScope:"all"}` | `daily[].totalTokens` 求和 |
| `metrics.cost` | `usage.cost {agentScope:"all"}` | `daily[].totalCost` 求和 |
| `metrics.cronJobs` | `cron.list` | 任务总数 |
| `agents[]` | `agents.list` + `status.sessions.byAgent` | 名称、模型、状态、session 数 |
| `channels[]` | `channels.status` | 渠道名、在线状态、账号、错误 |
| `sessions[]` | `sessions.list` | 最近 24 条，含 key、agent、标题、更新时间、`stage`、`progress`、`source` |
| `workItems[]` | session 投影；后续由外部连接器提供 | 统一工作项：`id`、`title`、`source`、`stage`、`progress`、`owner`、`sessionKey` |
| `events[]` | `session.message` + cron/session 变化 | 最近 12 条，含 `ts`、`agentId`、`sessionKey`、`kind`、摘要 |
| `models` | `models.list` | 模型数量 |
| `errors[]` | 各 RPC 失败信息 | 浮层底部显示非致命错误 |

完整的分层设计、连接器契约和演进路线见 [SYSTEM-DESIGN.md](./SYSTEM-DESIGN.md)。

### 主题数据绑定

`scripts/theme-data.js` 在主题脚本之前加载，提供 `__DQ_SET_SNAPSHOT__`、`__DQ_GET_SNAPSHOT__` 和前 8 套主题的 merge helper。`scripts/embed-dashboard.mjs` 通过括号匹配定位主题内的数据声明，将其包装为 `__DQ_MERGE_*(原始数据, 主题名)`，不改动原始 `index.html`。

PARK 与 HQ 不再套用 `__DQ_MERGE_*`，而是在主题内部保留两个运行时钩子（`host.__dqApply` / `host.__dqPaint`），由 `theme-data.js` 的 `projectPark()` / `projectHQ()` 产出领域模型。这样 3D 模拟循环不受影响，真实数据只覆盖业务层。构建时会校验 `THEMES` 中的每款主题都有构建区间，并确认所有被引用的 `__DQ_MERGE_*` 函数都在 `theme-data.js` 中定义，缺失则构建失败。

刷新时机不同，且是刻意的：

- **01–08**：`__DQ_MERGE_*` 只在主题挂载时执行，`__DQ_APPLY__` 对它们只更新快照变量和右下角浮层；切换主题或刷新 iframe 才重新取数。若每次快照都重挂载，会每 3 秒重置一次动画。
- **09–10**：每次快照都通过 `__dqApply` / `__dqPaint` 覆盖，约 5Hz。

真实度分层（哪些是真实、哪些是模拟）见 [SYSTEM-DESIGN.md §5.6](./SYSTEM-DESIGN.md#56-真实度矩阵与刷新时机)。

| 主题 | 绑定的真实数据 |
| --- | --- |
| `ops` | `CONFIG.agents`、`taskNames`、`workflows` |
| `spider` / `neural` | `AG`、`WF`、`CH` |
| `factory` | `AG`、`WF`、`CH`、`PROJECTS` |
| `nebula` | `AG`、`WF` |
| `forge` / `works` | `AGENTS`、`JOBS`（兼容 `parts` 与 `secs`） |
| `ion` | `CASES`、`UC_SHORT` |
| `park` | 车间负责人、任务池、渠道、事件流、终端日志、全部 KPI |
| `hq` | 部门成员、部门统计、项目流水、事件流、顶部/底部全部 KPI |

合并规则：

- 真实 agents 优先填入主题槽位；多余槽位标记为 `IDLE/待命`。
- spider、nebula、factory 的 `CRAWLER` / `PATROL` 哨兵保留。
- 合并后的 agent `id` 使用真实中文名；原 id 与 `sourceId` 写入 `legacy` / `sourceId`，并注入 `AGI` 别名，兼容 Forge/Works 的硬编码索引访问。
- `CH` 保持 6 个槽位以维持 neural 布局；真实渠道不足时填“其他”。
- 模型名去掉 provider 前缀，例如 `opencode/deepseek-v4-flash-free` 显示为 `deepseek-v4-flash-free`。
- 主题内的“今日交付”“丝线长度”等纯视觉演示指标仍由本地动效生成；agent、session、channel、job、case 等核心实体来自快照。

### 参数

```ts
health()
status()
channels.status({ probe: false })
usage.cost({ agentScope: "all" })
sessions.list({
  limit: 200,
  archived: false,
  includeLastMessage: true,
  includeDerivedTitles: true,
  source: "dashboard",
})
sessions.list({ activeOnly: true, limit: 1 })
agents.list()
cron.list({ includeDisabled: true })
models.list()
```

### 实时事件

- `host.onEvent("session.message", handler)`：把消息事件转为 `{ time, tag: "MSG", text }`，最多保留 12 条。
- `host.subscribe(...)`：订阅 Gateway 事件流，收到事件后安排一次合并刷新（250ms 防抖）。
- 轮询：3 秒一次；`host.subscribe` 和 `session.message` 提供更快响应。
- 快照中的 `events` 会同时包含近期真实消息事件和状态变化事件。

## 5. 安全模型

- **路由鉴权**：`auth: "plugin"` + 进程内 HMAC 签名 token。token 只由已认证的 `info` RPC 签发，随 Gateway 进程重启轮换；它只允许加载静态大屏 HTML，不能调用 Gateway RPC。
- **嵌入限制**：插件路由返回 `X-Frame-Options: SAMEORIGIN` 和 `frame-ancestors 'self'`，只允许同源页面嵌入。
- **Referrer 保护**：路由返回 `Referrer-Policy: no-referrer`，避免 iframe URL 中的 token 泄露给 Google Fonts / jsDelivr。
- **独立 CSP**：大屏路由允许内联脚本、Three.js CDN 和 Google Fonts；不把这份宽松 CSP 扩散到 Control UI 其他页面。

  ```text
  default-src 'none';
  script-src 'unsafe-inline' https://cdn.jsdelivr.net;
  style-src 'unsafe-inline' https://fonts.googleapis.com;
  font-src data: https://fonts.gstatic.com;
  img-src data: blob:;
  media-src data: blob:;
  connect-src 'self' https:;
  worker-src 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'none';
  frame-ancestors 'self'
  ```

- **数据最小化**：浮层只展示聚合指标、Agent 名称、session 元数据和消息事件摘要；不展示 API Key、token、完整对话正文或文件内容。
- **信任边界**：Native UI 运行受信任 JavaScript，拥有当前操作员的 Gateway 权限；插件安装即信任，生产环境只安装可信插件。
- **原文件隔离**：构建只读取 `../index.html`，不手改主题视觉；实时接入通过主题内的 `host.__dqApply` / `host.__dqPaint` 钩子完成，生成物在 `src/generated/dashboard-html.ts`，由构建脚本覆盖。

### 实测结果与回退

已实测：

- 带 token 的 `GET /plugins/agent-display/dashboard?token=...` 返回 `200`，内容包含 `dq-live` / `agent-display:snapshot`。
- 无 token 或错误 token 返回 `403`。
- 响应头包含 `X-Frame-Options: SAMEORIGIN`、独立 CSP、`Referrer-Policy: no-referrer`；Gateway 没有覆盖。
- Control UI 原生页面成功加载 iframe，桥接浮层显示真实数据（7 agents、19 sessions、2/2 channels、90.9k tokens、2 cron jobs）。
- 浮层首条数据到达时自动展开，5 秒后收起为右下角胶囊。
- 浮层可拖动到任意位置，刷新后保持；展开时自动选择向上/向下并限制高度，不会超出视口；`↺` 可复位到右下角。
- Playwright 实测：拖动后位置写入 `localStorage`，iframe 重新加载后恢复；拖动不会误触发展开/折叠；`Shift + 方向键` 微调生效。
- Playwright 依次切换 10 套主题：均无 pageerror/console error；`ops`、`spider`、`neural`、`factory`、`nebula`、`forge`、`works` 显示 7 个真实中文 agent 名；`ion` 显示真实 case/session 数据；`park`、`hq` 布局、场景和动效与原主题一致，同时显示真实 KPI（21 会话、7 Agent、100% 渠道在线率、50.31M token）；3D 主题的 `glFail` 保持隐藏，WebGL 渲染正常。
- 主题 9 曾在旧装机版本中因缺少 `__DQ_MERGE_PARK_*` 定义而挂载失败；当前构建会拦截此类缺失，重新安装后 PARK 正常渲染。

如果未来 Gateway 版本改为强制 `DENY`，按以下顺序回退：

1. 检查插件路由响应头，确认不是插件代码遗漏 `SAMEORIGIN`。
2. 改为独立的 loopback HTTP 服务（仅监听 `127.0.0.1`），由 Control UI 的 `frame-src http:` 加载；该服务需自己的 CSP，并只绑定 loopback。
3. 最后才考虑把大屏拆成原生 DOM/Canvas 组件，放弃 iframe。

## 6. 文件说明

| 文件 | 作用 |
| --- | --- |
| `../index.html` | 原始大屏；视觉不动，仅新增 PARK / HQ 实时数据钩子 |
| `scripts/embed-dashboard.mjs` | 读取原大屏，包装主题数据声明，注入 theme-data/bridge，生成 TS 字符串 |
| `scripts/theme-data.js` | 主题真实数据合并层：agents/workflows/channels/projects/jobs/cases/ops config |
| `scripts/dashboard-bridge.css` | `OPENCLAW LIVE` 浮层样式 |
| `scripts/dashboard-bridge.js` | 浮层渲染、折叠、`postMessage` 接收 |
| `src/index.ts` | 注册 Gateway HTTP 路由、CSP、响应头 |
| `src/control-ui.ts` | 注册导航/页面、iframe、数据采集、轮询 |
| `src/contract.ts` | Feature contract：`info` |
| `src/shared.ts` | 常量与快照类型 |
| `src/control-ui.css` | 原生页面容器样式 |
| `src/generated/dashboard-html.ts` | 构建生成，不手改 |
| `openclaw.plugin.json` | 插件清单 |
| `docs/INTEGRATION.md` | 接入方案与数据映射 |
| `docs/SYSTEM-DESIGN.md` | 系统设计：分层、连接器契约、实时链路、演进 |

## 7. 构建、安装、验证

```sh
cd openclaw-plugin-agent-display
npm install
npm run build
npm run validate
openclaw plugins install . --force
```

本地路径安装会触发信任提示；确认代码来源后使用 `--force`。

开启原生插件 UI：

```json5
{
  gateway: {
    controlUi: {
      experimental: { customPlugins: true },
    },
  },
}
```

或 Control UI：**Settings → Labs → Custom plugin UI**。

也可以直接写入配置（实测无需重启 Gateway）：

```sh
openclaw config set gateway.controlUi.experimental.customPlugins true
```

验证：

```sh
# 1. 通过已认证 RPC 获取签名 URL
openclaw gateway call plugins.sessionAction \
  --params '{"pluginId":"agent-display","actionId":"info","payload":{}}'

# 2. 用返回的 dashboardUrl 验证路由与响应头
curl -sS -D - 'http://127.0.0.1:18789/plugins/agent-display/dashboard?token=<token>' -o /tmp/dashboard.html
rg -n "dq-live|agent-display:snapshot|OPENCLAW LIVE" /tmp/dashboard.html

# 3. 插件状态
openclaw plugins list
openclaw plugins inspect agent-display

# 3. 浏览器
# 打开 Control UI，侧边栏应出现“agent作战大屏”；
# 页面右下角应出现 OPENCLAW LIVE 胶囊，首条数据到达后自动展开。
```

如果页面空白或浮层不出现：

- 确认 `customPlugins` 已开启并刷新页面。
- 检查浏览器 Console 是否有 CSP 或 iframe 拒绝错误。
- 检查 `/plugins/agent-display/dashboard` 的 `X-Frame-Options` 是否为 `SAMEORIGIN`。
- 直接访问路由会返回 `403` 是预期行为；必须使用 `info` RPC 返回的 `dashboardUrl`。
- 确认 Gateway 已加载新版插件（安装后通常需要重启或热重载）。
- 确认当前操作员有 `operator.read` 权限。

## 8. 当前阶段与后续

### Phase 1（已完成）

- 原生页面、侧边栏入口。
- 大屏 iframe 与独立 CSP。
- 真实 agents、sessions、channels、usage、cron、models 数据。
- 右下角实时浮层、事件流、3 秒轮询。
- 构建脚本、文档、安装验证。

### Phase 2（已完成）

- 8 套主题绑定真实数据：`ops`、`spider`、`neural`、`factory`、`nebula`、`forge`、`works`、`ion`。
- 主题内 agent 名称、模型、session 标题、渠道、任务/用例来自网关快照。
- 修复 Works 的 `job.secs` 与 Forge 的 `job.parts` 字段差异。
- 修复 Forge/Works 的 `AGI` 索引访问，保留原 id/source id 别名。
- 合并后的真实实体在切换主题或刷新 iframe 后取最新快照；右下角浮层始终实时。01–08 不做运行时增量重绘，避免打断动画。
- Playwright 实测 10 套主题：前 8 套显示真实 agent 名/任务数据；WebGL 3D 正常，无 pageerror/console error。

### Phase 3（已完成，插件 0.2.0）

- 快照扩展 `stage` / `progress` / `source` / `workItems`，为外部连接器预留契约。
- `theme-data.js` 新增 `projectPark()` / `projectHQ()` 投影层，以及 `metricsOf()` 指标归一化。
- PARK 接入真实数据：6 个车间映射前 6 个 Agent，session 标题进入车间任务池，真实渠道替换渠道名，事件写入事件流与车间终端，KPI 全部替换。
- HQ 接入真实数据：Agent 按部门关键词落位到 8 个部门，最近 8 个 session 成为项目，部门统计行与顶部/底部 KPI 全部替换。
- 3D 模拟循环保持运行，实时数据以约 5Hz 覆盖业务层，视觉与 `index.html` 一致。
- `live: true` 项目不自动重启、不自动回收，避免真实会话被模拟逻辑演没。
- 首次接入实时数据时清空主题本地日志，之后只记录真实事件。
- 实时值写入前清除 `setTxt`/`setHTML` 缓存，修复"值被缓存判等跳过"的问题。
- 右下角 `OPENCLAW LIVE` 浮层支持拖动、位置记忆（`localStorage`）、自动避让、键盘微调与复位，避免遮挡大屏内容。

### Phase 4（后续）

- 接入 Jira / GitHub / CRM 连接器，产出标准 `workItems`。
- 增加 WebSocket/SSE 推送，替代 3 秒轮询。
- 增加数据源开关和主题级筛选（按 agent、渠道、时间范围）。
- 增加权限分级：只读视图与管理员视图。
- 增加 Playwright E2E 和 CSP 回归测试到 CI。
- 优化 session 标题：当前部分主会话/群聊仍显示 session key 或群聊 id。
- Three.js 和字体本地化，消除 CDN 依赖。

## 9. 已知限制

- 除 PARK / HQ 外的主题（01–08）仍是"合并实体 + 本地动效"：Agent / 任务 / 渠道是真实的，但"今日交付""丝线长度"等纯视觉指标不由真实数据驱动。
- 01–08 的实体合并只发生在主题挂载时：`__DQ_APPLY__` 对它们不重绘主题本体，Agent 上下线或 session 数变化需要切换主题或刷新 iframe 才能看到；右下角浮层不受影响，始终实时。
- PARK / HQ 的 3D 动作、工单在车间之间的流动仍由仿真驱动，只有业务层数字/名称/事件来自真实数据。
- Agent 级 token / cost 当前无数据，只展示总量；`agents[].tokens` / `cost` 字段已预留。
- 真实会话时间可能很旧，因此"最近会话"取最小值而非平均值。
- 部分 session 的 `derivedTitle` 为空，主题会显示 session key 或群聊 id；这是 OpenClaw 会话元数据当前的实际内容。
- Three.js 仍从 jsDelivr 加载；离线环境需要本地化。
- 无 WebGL 时主题会显示回退提示并保留面板数据；Playwright 环境已验证 WebGL2/Three.js 主题正常渲染。
- 浮层只展示摘要，不提供完整会话内容查看。
- iframe 嵌入依赖同源和 `SAMEORIGIN` 响应头；若 Gateway 强制 `DENY`，需要按第 5 节回退。
- 原生页面拥有当前操作员权限，插件必须来自可信来源。
