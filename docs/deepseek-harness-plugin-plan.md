# DeepSeek Harness Agent 工作状态 HUD + 作战大屏 · 落地版

> 目标：在 **DeepSeek Harness 0.2.1-rc.5** 的现有页面里，以只读方式实时展示当前 agent 的工作状态，并提供可点击进入的完整「作战大屏」。
> 交付物：`dsh-agent-status` 插件（Cordis bundle）、一键安装 / 卸载脚本、单元测试与本文件。
> 不修改 Harness 源码与 `app.asar`，不写远程仓库。

---

## 1. 结论

已交付一个可正式安装、可长期使用的插件：

- **安装**：`node scripts/install.mjs`，默认写入 `~/.dsh/profiles/desktop`，首次安装前自动备份，幂等。
- **HUD**：重启 Harness 后，页面右下角出现 `AGENT STATUS`，实时显示 `IDLE / THINK / TOOL / HOLD / AWAIT / DONE / FAIL`。
- **大屏入口**：HUD 标题栏的青色「大屏」按钮，点击在新标签 / 系统浏览器打开 `http://127.0.0.1:<随机端口>/dsh-agent-status/screen?token=<ticket>`；HUD 保留。地址由当前页面的真实 HTTP origin 动态拼，不写死端口。
- **大屏内容**：顶部总览（阶段 / agent / 在线状态 / 轮次 / 本轮耗时 / tokens / 工具数）、左侧工具调用与结果时间线、右侧多 agent 阵列、底部最近事件流；SSE 优先，断线回退轮询并自动重连；支持暂停 / 继续、等待提示、阶段切换闪光、窄屏单列布局。
- **隐藏**：点 HUD 右上角 `×`（只留圆形小气泡，点气泡恢复）；或按 `Alt+Shift+H`；或在 profile 配置里设 `visible: false` 后重启。
- **移动**：点 `⇅` 在四角之间切换；也可以拖拽标题栏，位置会记住。
- **卸载**：`node scripts/uninstall.mjs`，从安装前备份完整还原；更新安装不会覆盖首次备份。
- **安全**：状态接口与 `/screen` 都必须带 token，匿名访问一律 `401`；只接受 loopback；前端页面只拿到**当前进程的一次性 ticket**；大屏不暴露对话正文与完整工具参数。
- **验证**：`node --test` 50 项通过；隔离 / mock 宿主完成 HUD 入口 → 大屏 URL 带 token → SSE 更新 → 工具时间线 → 暂停 → 断线自动重连 → 匿名 401；NEBULA 主题在 mock 下验证 3 agent 阶段 / 真实调用脉冲 / 暂停 / 断线 / 空态，并与原 `index.html` 同尺寸并排截图对照；真实 desktop profile（1.3.0）重启后进入大屏截图确认 NEBULA 渲染与空调用状态。

---

## 2. 快速开始

### 2.1 安装

```bash
cd /Users/liuzuodong/Documents/workspace/agent-display/dsh-agent-status
node scripts/install.mjs
# 或 npm run install:desktop
# 或 bash scripts/install.sh
```

指定 profile / 隔离环境：

```bash
node scripts/install.mjs \
  --home /tmp/dsh-home \
  --profile-dir /tmp/dsh-home/profiles/verify
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--profile-dir` | 目标 profile，默认 `~/.dsh/profiles/desktop` |
| `--home` | DSH_HOME，默认 `~/.dsh`（备份放在 `$DSH_HOME/backups/dsh-agent-status`） |
| `--token` | 指定安装 token（不传则生成 32 字符 URL-safe 随机串） |
| `--port` | 额外的独立只读监听端口；`0` 表示只复用宿主 webServer |
| `--theme` | `neon`（默认）或 `mono` |
| `--position` | `bottom-right` / `top-right` / `bottom-left` / `top-left` |
| `--hidden` | 安装后默认隐藏 HUD |
| `--screen-button true\|false` / `--no-screen-button` | 是否在 HUD 显示「大屏」按钮，默认显示 |
| `--screen-landing hud\|screen` | 默认落地页；`screen` = HUD 加载后自动打开一次大屏 |
| `--screen-window tab\|window` | 大屏打开方式，默认 `tab` |
| `--waiting-after-ms` | 多久无事件显示「等待中」，默认 15000 |
| `--done-hold-ms` | `DONE` 保持时长，默认 6000 |
| `--poll-ms` | 轮询间隔，默认 800 |

脚本做四件事（全部幂等）：

1. 备份到 `$DSH_HOME/backups/dsh-agent-status/<时间戳>/`：
   `profile/package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，以及 profile 下若存在 `index.html` / `web/index.html` / `dist/index.html` 也一并备份；
   `manifest.json` 记录文件哈希与 `node_modules/dsh-agent-status` 原有软链状态。
   **只在首次安装（受管块不存在）时新建备份**；更新安装复用最早且不含受管块的备份，避免把“已安装快照”当成还原点。
2. 在 profile `package.json` 增加 `"dsh-agent-status": "link:<相对路径>"`，并把 `dsh-agent-status` 加入 `dsh.profile.bundles`。
3. 在 `node_modules/dsh-agent-status` 创建指向本包的软链。
4. 在 profile `cordis.patch.yml` 追加受管配置块（`# >>> dsh-agent-status:managed` 标记）：
   `token / port / theme / position / visible / screenButton / screenLanding / screenWindow / waitingAfterMs / doneHoldMs / pollMs`。

> `index.html` 说明：桌面版的页面模板在 `app.asar` 内，注入表是宿主**内存中的快照**，安装不会写任何 `index.html`。脚本仍会检查 profile 下的 `index.html` / `web/index.html` / `dist/index.html` 并在存在时备份，保证自定义 profile 也能完全还原。

> **安装完成后必须重启 Harness**：桌面壳在启动时快照 `webserver/index-inject` 注入表，首次安装以及每次更新 `runtime/hud.js|css` 后都要 `Cmd+Q` 退出再打开。安装脚本每次都会再打印一遍该提示。`runtime/screen.*` 在每次请求时读取，改大屏样式 / 脚本不需要重启。

### 2.2 卸载

```bash
node scripts/uninstall.mjs
# 或 npm run uninstall:desktop
# 或 bash scripts/uninstall.sh
```

- 默认找该 profile 最早且**不含受管块**的安装前备份，逐文件复制回去，并校验 SHA-256。
- 旧版本安装器可能在更新时把“已安装快照”也备份下来；卸载会识别并跳过这类备份，避免还原后插件仍然存在。
- `node_modules/dsh-agent-status` 按备份时状态还原（原本不存在则删除软链）。
- 备份目录保留，写入 `restored.json`；再次运行直接提示“已还原”，不会重复覆盖。
- 找不到备份时退化为“外科式移除”：删依赖、删 bundle、删受管配置块、删软链。

指定备份或 profile：

```bash
node scripts/uninstall.mjs --profile-dir ~/.dsh/profiles/desktop \
  --backup-dir ~/.dsh/backups/dsh-agent-status/2026-11-06T08-17-47-136Z
```

> 卸载会**完整还原安装前的 profile 快照**。如果你在安装后又手改了 `package.json` / `cordis.patch.yml`，这些改动会被覆盖（见“已知限制”）。

### 2.3 升级

```bash
# 1) 更新本包代码（git pull / 手工替换），无需清缓存
# 2) 重新执行安装（更新 profile 软链与配置，token 默认保持不变）
node scripts/install.mjs
# 3) 完全退出并重启 Harness（注入表在启动时快照）
```

需要轮换 token 时：

```bash
node scripts/install.mjs --token "$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
```

轮换后同样需要重启；旧 token 立即失效。

### 2.4 接口自检

宿主 web 端口不固定（桌面版随机，CLI 可用 `--port` 固定）。用安装输出里的 token：

```bash
PORT=59385   # 用 lsof 找 DeepSeek 监听端口
TOKEN=<安装输出里的 token>

curl -i "http://127.0.0.1:$PORT/dsh-agent-status/api/state"                    # 401
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/dsh-agent-status/api/state"                          # 200
curl -N "http://127.0.0.1:$PORT/dsh-agent-status/stream?token=$TOKEN"          # SSE
```

---

## 3. HUD 使用说明

| 操作 | 方式 | 持久化 |
| --- | --- | --- |
| 显示 / 隐藏 | `×` 隐藏，圆形气泡 `◍` 恢复；快捷键 `Alt+Shift+H` | `localStorage["dsh-agent-status.visible"]` |
| 折叠 / 展开 | 标题栏 `–` / `+` | `localStorage["dsh-agent-status.collapsed"]` |
| 四角切换 | 标题栏 `⇅`：右下 → 右上 → 左上 → 左下 | `localStorage["dsh-agent-status.anchor"]` |
| 自由拖拽 | 拖标题栏（避开按钮） | `localStorage["dsh-agent-status.pos"]`（像素坐标） |
| 默认值 | profile 配置 `position` / `visible` | localStorage 优先于配置 |

- 刷新页面、重启 Harness 后自动恢复偏好（已验证）。
- 如果曾经拖拽过，会优先恢复像素坐标；点 `⇅` 可回到四角预设。
- 颜色 token 取自 `agent-display/index.html`：底色 `#07080d`、青 `#45e6f5`、品红 `#ff3f8e`、JetBrains Mono。
- HUD 全部包在 Shadow DOM（`#dsh-agent-status`）内，不污染宿主样式。

### 3.1 作战大屏

**入口**

1. HUD 标题栏的青色「大屏」按钮（`data-act="screen"`）；`screenButton: false` 时隐藏。
2. 直接访问 `http://127.0.0.1:<宿主端口>/dsh-agent-status/screen?token=<安装 token>`。
   宿主端口随机：用 `lsof -nP -iTCP -sTCP:LISTEN | grep DeepSeek` 查，或从 HUD 按钮打开的地址复制。

**地址规则**

- 桌面 Harness 的页面 origin 是 `dsh-app://app`，无法交给浏览器；宿主在 `__DSH_TRANSPORT__.streamBaseUrl` 暴露真实 HTTP origin（例如 `http://127.0.0.1:63080`），HUD 优先取它。
- mock / 普通浏览器环境没有该字段时，回退 `location.origin`。
- 端口永远来自运行时，不写死；重启后端口会变，旧链接失效（安装 token 链接仍然可用）。

**打开方式**

- 桌面 Harness 的 Electron 渲染进程禁止 `window.open` 新建应用内窗口，http(s) 目标由宿主转交**系统默认浏览器**；`screenWindow: window` 使用 `popup,width=1440,height=900`。
- `screenLanding: screen` 会在 HUD 首次加载后自动打开一次（`sessionStorage` 去重）；系统浏览器的弹窗拦截可能阻止非用户手势的自动打开，此时点按钮即可。

**页面结构**

| 区域 | 内容 |
| --- | --- |
| 顶部总览 | 当前阶段（含闪光切换反馈）、当前 agent、连接状态、轮次/步骤、本轮耗时、tokens in/out、工具调用数；超过 `waitingAfterMs` 无事件显示「等待中 · 无新事件」 |
| 主区时间线 | 每个工具调用的时间、名称、T+step、参数摘要（≤90 字）、状态（running / ok / error）、耗时、结果摘要（≤80 字）；最多 20 条 |
| 右侧 agent 阵列 | 全部 agent 的阶段、轮次、工具数、本轮耗时、错误摘要；点击卡片过滤时间线，再点取消 |
| 底部事件流 | 最近 12 条聚合事件（含 agent 短 id） |
| 状态层 | `实时 SSE / 轮询回退 / 连接中断 / 鉴权失败`；断线覆盖层；暂停徽标 |

**传输与交互**

- SSE `/stream?token=` 优先；`error` 后立即切到 `pollMs` 轮询，并每 5s 重试 SSE；`open` / `state` 后停轮询并切回实时。
- `暂停刷新` 冻结画面，仍继续接收最新快照到 `pending`；`继续刷新` 立即应用。
- 页面每 500ms 更新时钟、运行中工具耗时、本轮耗时与「等待中」判定；数据超过 10s 未更新时底部提示「数据 Ns 未更新」。
- 宽度 ≤1100px 单列堆叠（总览 → 时间线 → agent → 事件）；≤720px 顶部控件换行、工具行两行布局；≤460px 隐藏小字与时钟。
- 所有数据用 `textContent` 写入，不拼 HTML；配置 JSON 中的 `<` 转义为 `\u003c`。

**NEBULA「星核蜘蛛」可选主题（`screenTheme: galaxy`）**

来源确认：`agent-display/index.html` 中没有名为「星河蜘蛛」的主题；按名称/注释/关键词检索后，实际匹配到的是 **05 · NEBULA 星核蜘蛛**（模板 `#tpl-nebula`，渲染函数 `mountNebula`）。第一版曾按「参考风格另做一套 Canvas 2D」实现，视觉与原版差距明显；本轮改为**原样抽取**：

- `runtime/nebula/template.html` = 源文件 1118–1397 行（board/HUD/面板 CSS 与结构），仅替换 HUD 文案；
- `runtime/nebula/theme.js` = 源文件 8780–9943 行（约 1290 行），仅替换第 3 节模拟引擎为真实快照适配，渲染与动效参数未改；
- 渲染层仍是 three.js 0.147 + EffectComposer + UnrealBloomPass + 原生 GLSL（PT/RB/LEG/ST 四段着色器），与原版一致；`runtime/nebula/vendor/` 本地化依赖，离线可用；
- 视觉参数沿用原值：深空 `#03050c`、冰蓝 `#9fd4ff`、青 `#62e3ff`、桃 `#ffb48f`、粉 `#ff6fae`、金 `#ffd27a`、good `#6ff0c0`、bad `#ff6b8b`；每团星云 3400 / 纤维团 1900 + 纤维粒子、丝带星核 24 条 ×220 段、轨道 900×3 + 1600 星尘、星空 2600、星云蛛 3200+1500；12 团星云按原公式分布在三条椭圆轨道；HUD 字号与 1920×1080 缩放换算照旧。

数据槽位映射（只换数据源，不制造数据）：

| 原主题结构 | 真实来源 | 语义 |
| --- | --- | --- |
| `AG[0]` CHIEF 丝带星核 | 宿主进程 | 星核状态字 = LISTENING / WAITING / NO AGENT / PAUSED / OFFLINE / AUTH 401 / SILENT |
| `AG[1..12]` 十二团星云 | `snapshot.agents[i]` | 一个真实 agent 一个槽位（按 id 粘滞，≤12）；空槽保持 IDLE 中性 |
| `AG[13]` CRAWLER 星云蛛 | 只读巡检蛛 | 只沿真实调用移动，不参与调度 |
| `task.sections[]` | 每个 agent 的调用分组 | 只有存在 agent 的槽位才生成 |
| `section.words[]` | `agent.timeline` 末 14 条（时间正序） | 词 = 一次真实工具调用，固定词位、缺位留空 |
| `word.state / fix` | `status` + `durationMs` / `result` | read / flag / ask / fix；标签叠工具名与耗时 |
| `load[] / flash[]` | `agent.phase` + 调用事件 | idle .14 / thinking .58 / tool .94 / done .70 / failed .66 |
| `logs[] / CODE_SRC` | `snapshot.events[]` | 每行都是真实事件文本 |
| `crawl.phase` | 数据状态机 | brief → walk → read → ship → rest，由真实调用/结果驱动 |

- **拓扑语义**：宿主没有 agent→agent 委派/父子事件，画面因此只有「宿主星核 + agent 星云 + 工具词」；星云蛛的跳跃/回核是视觉叙事，不画不存在的 agent 间连线。
- **脉冲**：只在 `tool/call` 新增、`running → ok/error`、`waiting/awaiting` 时触发；首帧不回放历史；暂停恢复 resync 不补播；>8s 队列丢弃。
- **主题切换**：`--screen-theme galaxy` 或 `?theme=galaxy`；顶部「主题」按钮在 galaxy↔neon 间改写 `?theme=` 重载；`P` 暂停数据刷新。
- **性能与降级（原值，不削画面密度）**：DPR ≤1.75；连续 3 秒 FPS<30 → DPR 1 → 0.75 → 关 bloom；页面/宿主隐藏停 rAF；粒子与几何数量按原版；chip 上限 44。
- **状态**：WAITING / SILENT / NO AGENT / OFFLINE / AUTH 401 / PAUSED 均落在星核状态字与面板文案上。
- **已知限制**：相机取景由真实 agent 槽位决定（内圈云离星核近，星核更大）；空槽显示 IDLE；无历史回放；窄屏走原版精简条。

---

## 4. 配置项

配置位于 profile 的 `cordis.patch.yml` 受管块（安装脚本生成），修改后**重启 Harness** 生效：

```yaml
# >>> dsh-agent-status:managed
- id: dsh-agent-status
  name: dsh-agent-status
  config:
    token: "MxOF..."
    port: 0
    theme: "neon"
    screenTheme: "neon"
    position: "bottom-right"
    visible: true
    screenButton: true
    screenLanding: "hud"
    screenWindow: "tab"
    waitingAfterMs: 15000
    doneHoldMs: 6000
    pollMs: 800
# <<< dsh-agent-status:managed
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `token` | 安装时生成 | 状态接口的长期 token；前端页面**不会**收到它 |
| `port` | `0` | `0` = 复用宿主 webServer；`>0` = 额外在 `127.0.0.1:<port>` 起一个同鉴权的只读监听（已验证） |
| `theme` | `neon` | HUD 主题：`neon` 或 `mono`（后者去彩色强调） |
| `screenTheme` | `neon` | 大屏主题：`neon` / `mono` / `galaxy`（NEBULA 星核蜘蛛）；也可用 `?theme=galaxy` 临时预览 |
| `position` | `bottom-right` | 四角预设，首次无 localStorage 时生效 |
| `visible` | `true` | 默认显隐；用户点 `×` 后以 localStorage 为准 |
| `screenButton` | `true` | 是否在 HUD 显示「大屏」按钮 |
| `screenLanding` | `hud` | `hud` = 仅 HUD；`screen` = HUD 加载后自动打开一次大屏（`sessionStorage` 去重） |
| `screenWindow` | `tab` | `tab` = 新标签；`window` = 弹窗（`popup,width=1440,height=900`） |
| `waitingAfterMs` | `15000` | 多久无事件后大屏显示「等待中 · 无新事件」 |
| `doneHoldMs` | `6000` | `DONE / FAIL` 展示保持时间，之后转 `AWAIT / IDLE` |
| `pollMs` | `800` | 前端轮询兜底间隔（SSE 正常时暂停轮询） |

> 配置非法时回退默认值，不会导致插件加载失败（`lib/config.js`）。

---

## 5. 数据通道与安全模型

### 5.1 通道

```
Harness 事件总线
  agent/created | agent/disposed | agent/status | agent/error | agent/assistant-stream
  session/event → turn/start|end, step/start|end, tool/call, tool/result,
                  approval/asked|decided, user/message, assistant/message, ...
        │
        ▼
lib/state.js（纯状态机，不保存正文）
        │
        ├── GET /dsh-agent-status/api/state   JSON 快照
        ├── GET /dsh-agent-status/stream      SSE（120ms 节流 + 15s 心跳）
        ├── GET /dsh-agent-status/screen      作战大屏 HTML（请求时组装 screen.html/css/js）
        └── webserver/index-inject           注入 runtime/hud.js + hud.css
```

`/screen` 与 API 走同一个 `handle()`：先路由白名单，再 `authorize()`，所以大屏页面本身也受 token 保护，匿名得到 `401` JSON 而不是白屏。响应附带 `CSP default-src 'none' / connect-src 'self'`、`nosniff`、`no-referrer`、`Cache-Control: no-store`。

### 5.2 鉴权

- 接受的 secret：**安装 token**（profile 配置）与**每进程启动时生成的 ticket**（只注入到页面）。
- 传递方式：`Authorization: Bearer <token>`、`X-Agent-Status-Token: <token>`、`?token=<token>`（EventSource 用查询参数）。
- 校验采用 `crypto.timingSafeEqual`；空值、长度不一致直接拒绝。
- 无 token / 错 token / 非 loopback 对端 → `401`（附 `WWW-Authenticate`），`/screen` 同样先鉴权。
- 路由只挂在宿主 webServer（其绑定 `127.0.0.1`）；`port > 0` 的独立监听显式 `listen(port, "127.0.0.1")`。
- 注入脚本只含 ticket、主题、位置、轮询间隔与大屏配置，**不含**安装 token、模型密钥、prompt 或对话内容。
- 大屏 URL 含 ticket（URL 查询参数是 EventSource 的唯一传递方式）；ticket 随进程重启失效，不落入 profile。
- 文件权限：安装脚本只写 profile 配置；备份目录继承 `$DSH_HOME` 权限。token 不落日志（安装输出需用户自行保管）。

### 5.3 只读保证

- 只调用 `ctx.on(...)` 订阅事件，不 emit、不调用 agent/session 方法。
- 状态快照仅包含：阶段、轮次/步骤计数、工具名与截断后的参数摘要（≤90 字）、工具时间线（结果摘要 ≤80 字）、token 用量、错误摘要（≤80 字）。
- 不保存 assistant 文本；`assistant-stream` 只计帧数。
- 单元测试断言快照 JSON 不包含对话正文，也不包含完整工具参数 / 完整工具输出。

---

## 6. 状态语义与判据

| phase | 文案 | 判据 |
| --- | --- | --- |
| `idle` | 空闲 | 无活跃轮次；新建 agent 尚未开始 |
| `thinking` | 思考中 | `agent/status=running`、`turn/start`、`step/start`、`user/message`(user)、`assistant-stream` start |
| `tool` | 调用工具 | `tool/call` 到达；`tool/result` 后回到 `thinking` |
| `waiting` | 等待确认 | `approval/asked` 挂起；`approval/decided` 后回到 `thinking` |
| `awaiting` | **等待输入** | `turn/end` 后没有新 turn / 新用户消息；`DONE` 保持 `doneHoldMs` 后转入 |
| `done` | 完成 | `turn/end.reason.kind = completed` 或 `max-tokens`，保持 `doneHoldMs` |
| `failed` | 失败 | `agent/error` 或 `turn/end.reason.kind = error`，保持 `doneHoldMs` |

`awaiting` 的补充说明：

- 真实事件里**没有**专门的“等待用户输入”事件。判据是 `turn/end`（completed / aborted / interrupted / blocked / max-tokens）之后，`awaitingInput=true` 且没有新的 `turn/start` 或 `user/message`；`forked` 不算。
- 新 turn、用户消息、`agent/status=running`、agent dispose 都会清除该标记。
- `approval/asked` 仍然优先显示 `waiting`，不会误判成 `awaiting`。
- 这是启发式：如果宿主未来新增事件，可在 `lib/state.js` 的 `sessionEvent` 中直接接上。

---

## 7. 故障排查

| 现象 | 排查 |
| --- | --- |
| **插件没加载** | 1) 确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-agent-status`；2) 确认 `node_modules/dsh-agent-status` 软链指向本包；3) 看 Harness 日志里有无 `[agent-status]` 相关 warn；4) 重跑 `node scripts/install.mjs`（幂等）。 |
| **HUD 不出现** | 1) 是否**完全退出** Harness（`Cmd+Q`）再打开？注入表在启动时快照；2) 页面是否被其他插件全屏遮挡；3) 打开 DevTools 查 `document.getElementById('dsh-agent-status')`；4) 检查是否曾按 `×` 隐藏——点角落气泡或 `Alt+Shift+H`；5) 配置 `visible: false` 时也会隐藏。 |
| **接口 401** | 1) token 是否来自当前 profile 的受管块（重装/轮换后旧 token 失效）；2) 用 `Authorization: Bearer` 或 `?token=`；3) 独立端口模式确认 `port` 配置且重启；4) 非 loopback 访问会被拒绝（改用 `127.0.0.1`）。 |
| **大屏 401** | 1) URL 是否带 `?token=`；2) Harness 重启后旧 ticket 失效，从 HUD「大屏」按钮重新打开；3) 也可用安装 token：`/dsh-agent-status/screen?token=<受管块 token>`；4) 匿名直连返回 401 JSON 是预期行为。 |
| **大屏白屏 / 打不开** | 1) 先确认 API 带 token 返回 200；2) 桌面 Harness 会把 http(s) 交给**系统浏览器**，若浏览器被拦截请手动复制地址；3) 检查端口是否随重启变化（用 HUD 重新打开）；4) 直接 `curl -i` 看 `/screen` 状态码与 CSP 头；5) 页面若只有报错文字，查看浏览器控制台。 |
| **大屏事件不动 / 一直 IDLE** | 1) 顶部连接徽标是 `实时 SSE` 还是 `轮询回退`；2) 底部是否显示「数据 Ns 未更新」；3) `curl` 状态接口看 `agents` 与 `lastEventAt`；4) 触发一次真实对话；5) 超过 15s 无事件显示「等待中 · 无新事件」是预期行为，不是卡死。 |
| **大屏入口点了没反应** | 1) HUD 配置 `screenButton` 是否为 `true`；2) 浏览器弹窗拦截（尤其 `screenLanding: screen` 的自动打开）；3) 旧版 HUD 在 `dsh-app://app` 下无法拿到 HTTP origin，需更新到 1.3.0 并重启。 |
| **大屏窄屏布局破** | 设计上 ≤1100px 单列、≤720px 两行工具行、≤460px 隐藏次要信息；若仍破，提供截图并检查是否有自定义浏览器缩放。 |
| **事件不动 / 一直 IDLE** | 1) `curl` 状态接口看 `agents` 是否为空——空说明没订阅到 agent；2) 确认 Harness 版本仍是 0.2.1-rc.5，事件名未变；3) 触发一次真实对话观察 `turn/start`；4) 若只有 `agent/status`，可能该版本不发 `session/event`，此时至少 `running/idle` 可用；5) 查看日志里的 `handler failed`。 |
| **HUD 位置怪 / 太小** | 右键“重置”方式：DevTools 执行 `localStorage.removeItem('dsh-agent-status.pos'); localStorage.removeItem('dsh-agent-status.anchor'); location.reload()`，或点 `⇅` 回到预设。 |
| **更新前端后仍是旧界面** | 注入脚本是内联的，不走 HTTP 缓存；但宿主在启动时快照注入表 → 必须重启 Harness。 |
| **安装时报 “is a real directory”** | `node_modules/dsh-agent-status` 是真实目录而非软链，先移走再安装。 |
| **卸载后仍看到 HUD** | 重启 Harness（旧进程仍持有注入脚本）。 |

临时关闭 HUD 的三种方式（从轻到重）：

1. 点 `×`（或 `Alt+Shift+H`），随时用角落气泡恢复；
2. profile 配置 `visible: false` 后重启（HUD 不出现，接口仍在）；
3. `node scripts/uninstall.mjs` 后重启（彻底移除）。

---

## 8. 已知限制

- **必须重启才能更新注入**：桌面壳启动时快照注入表，无法热替换前端脚本。
- **`awaiting` 是启发式**：依赖 `turn/end`；宿主没有“等待输入”专用事件。若某轮结束但 agent 仍在后台跑（例如子 agent），可能短暂显示 `awaiting`。
- **只读**：不能控制 agent；HUD / 大屏不提供暂停/取消 agent 的按钮（大屏的「暂停刷新」只冻结渲染）。
- **聚合视图**：`primary` 取最近活跃 agent，其余 agent 以右侧阵列呈现；子 agent 的细节有限。
- **桌面新窗口受限**：Electron 渲染进程禁止 `window.open` 自建窗口，入口会交给系统默认浏览器；若浏览器弹窗策略拦截，自动落地不会触发。
- **大屏 URL 含 ticket**：ticket 是每进程 secret，重启 Harness 后旧链接失效；分享链接前确认当前会话仍在。
- **卸载是全量还原**：会覆盖安装后对 `package.json` / `cordis.patch.yml` / 锁文件的其它修改；如需保留，先手工合并或指定 `--backup-dir` 做对照。
- **备份目录不自动清理**：每次首次安装会新增一个时间戳目录；更新安装复用最早的有效备份，不再新增。
- **手动软链**：安装脚本不跑 pnpm，直接建软链；若之后执行 `pnpm install`，`link:` 依赖会由 pnpm 重建，通常无影响。
- **端口**：默认复用宿主 web 端口（桌面版随机）。文档里的 `17818` / `63080` 只是当次示例；请以 `lsof -nP -iTCP -sTCP:LISTEN | grep DeepSeek` 或 HUD 生成的地址为准。
- **安全边界**：token 能保护接口，但本机同用户进程仍可读 profile 配置拿到 token；这属于本机信任边界内。
- **未做代码签名 / 公证**：以本地 `link:` 方式安装，不发布到 npm。

---

## 9. 验证证据

### 9.1 单元测试

```bash
cd dsh-agent-status && node --test tests/*.test.mjs
```

结果：`tests 50 / pass 50 / fail 0`，覆盖：

- 状态机：idle→thinking、tool/call→tool→thinking、turn/end→done→awaiting、aborted→awaiting、新用户消息清除 awaiting、approval→waiting→thinking、error→failed、快照不含正文；
- 工具时间线：running→ok / error、按 `callId` 匹配并发调用、结果摘要截断、最多 20 条、`lastEventAt`、本轮耗时在 `turn/end` 冻结；
- token：Bearer/自定义头/query 提取、空值与长度不等拒绝、timing-safe 比较、loopback 判定、安装 token 与 ticket 均可、匿名拒绝、非 loopback 拒绝；
- 安装纯函数：受管块插入/替换/幂等/移除、`[]` 空文档处理、profile `package.json` 依赖与 bundle 合并/还原、大屏配置往返；
- 配置：默认值、非法值回退、`screenButton/screenLanding/screenWindow/waitingAfterMs` 白名单、客户端配置不含 token；
- 大屏渲染：`screenUrl` 动态 origin + token 编码、占位符替换、配置 `<` 转义、真实页面无残留占位符；
- NEBULA 数据映射纯函数：阶段调色板/亮度、槽位粘滞与 12 上限、timeline 时间序与末 14 条、state 映射、计数器/成功率、焦点选择、事件动词、空计划/单 agent/无调用 agent、雷达边界、历史状态保留、身份标签可区分（main-agent → MAIN）。

### 9.2 隔离 profile 安装链路与 mock 宿主接口

```bash
# 临时 DSH_HOME
mkdir -p /tmp/dsh-home-verify/profiles/verify
# package.json 仅保留 @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app
node scripts/install.mjs --home /tmp/dsh-home-verify --profile-dir /tmp/dsh-home-verify/profiles/verify
# CLI 启动该 profile（--no-open --port 17819）
```

实测：

| 检查 | 结果 |
| --- | --- |
| `GET /dsh-agent-status/api/state` 无 token | **401** |
| `?token=wrong` | **401** |
| `Authorization: Bearer <token>` | **200**，返回 `{version:"1.2.0", ...}` |
| `X-Agent-Status-Token` | **200** |
| SSE 无 token / 有 token | **401 / 200** |
| `GET /dsh-agent-status/screen` 无 token | **401**，`{"error":"unauthorized"}` |
| `GET /dsh-agent-status/screen?token=<安装 token>` | **200**，`text/html`，含 CSP、无残留占位符 |
| 注入的 `index.html` | 含 `__DSH_AGENT_STATUS__`、`"ticket":"..."`、`"screenButton":true`、`AGENT STATUS` |
| ticket 调接口 / 大屏 | **200**；安装 token 仍 **200** |
| HUD 渲染（Playwright 实测） | 右下角 356×~287 卡片，3 个控件均可见；`×` 后隐藏并出现 30×30 气泡；气泡恢复；`⇅` 移到右上角；reload 后仍是右上角 |
| 大屏入口（mock，Playwright） | 点「大屏」→ 新页面 URL `http://127.0.0.1:17817/dsh-agent-status/screen?token=...`；页面 `conn=live`；HUD 仍可见 |
| 大屏时间线 | `/demo/tool` 后 `.tl-row` 从 1 → 2，首行 `data-status=running`，参数摘要为 `src/runtime/agent-loop.ts`（非完整参数） |
| 暂停 / 继续 | 暂停后徽标可见，再触发工具时间线不增；继续后应用 pending 快照 |
| 断线重连 | kill mock host → 断线覆盖层出现；重启同 token host → 覆盖层消失，`conn=live` |
| `awaiting` | API 快照 `phase: "awaiting"`、`awaitingInput: true`、文案“等待输入” |
| 卸载 | `package.json` / `cordis.patch.yml` / `cordis.yml` 三文件 SHA-256 与备份一致，`node_modules` 软链移除 |
| 再运行卸载 | 输出“已还原”，退出码 0 |

### 9.3 真实 desktop profile

```bash
node scripts/install.mjs      # → ~/.dsh/profiles/desktop
open -a "DeepSeek Harness"
```

实测（2026-11-06，更新到 1.2.0）：

- 备份目录：`~/.dsh/backups/dsh-agent-status/2026-11-06T08-17-47-136Z/`（首次安装前快照；本次 1.2.0 更新复用，没有新增）。
- 宿主端口 `64036`（随机）：`/screen` 无 token **401**，带安装 token **200**（`text/html`）；`/api/state` 返回真实 session，`phase: "idle"`。
- 通过 CDP 连接真实渲染进程（`--remote-debugging-port=9334`）确认：
  - `#dsh-agent-status` 存在，`data-version=1.2.0`，HUD `online=true`；
  - HUD 标题栏出现青色「大屏」按钮；
  - 点击后捕获到动态 URL `http://127.0.0.1:64036/dsh-agent-status/screen?token=<ticket>`（origin 来自 `__DSH_TRANSPORT__.streamBaseUrl`，非硬编码）；
  - 该 URL 用 ticket 请求返回 **200**；HUD 点击后仍保持显示；
  - 系统默认浏览器收到打开请求（Electron 将 http 外链交给浏览器，`window.open` 返回值恒为 `null`）。
- 大屏页在普通浏览器中加载同一 URL：`conn=live`，真实 agent 卡片 > 0，超过 15s 无事件时显示「等待中 · 无新事件」；截图见 `verify-desktop-screen.png`、`verify-desktop-screen-narrow.png`。
- 重启 Harness 后 HUD 自动恢复，说明 localStorage 偏好与注入均正常。

### 9.4 作战大屏专项（mock / Playwright）

脚本自动启动 `PORT=17817 DSH_AGENT_STATUS_TOKEN=verify-token node dev/mock-host.mjs`，再以 Chromium 打开大屏：

| 检查 | 结果 |
| --- | --- |
| HUD「大屏」入口 | 按钮可见，点击产生新页面，URL origin=`http://127.0.0.1:17817`，token 长度 32 |
| 大屏鉴权 | 匿名 `/screen` **401**，body 含 `unauthorized` |
| 实时状态 | `conn=live`，阶段、agent、轮次、本轮耗时、tokens 均来自真实快照 |
| 工具时间线 | 触发 `/demo/tool` 后行数增加，running 行高亮，参数摘要截断 |
| 暂停 / 继续 | 暂停徽标出现；暂停期间新事件不重绘；继续后重绘 |
| 断线恢复 | kill host → 断线覆盖层；重启 → 自动重连并恢复 `conn=live` |
| 窄屏 | 720px 下 `.grid` 单列，面板顺序为总览 → 时间线 → agent → 事件 |

截图：`verify-screen-wide.png`、`verify-screen-narrow.png`、`verify-hud-entry.png`、`verify-desktop-screen.png`（均在 `/Users/liuzuodong/Documents/Trae-CN/temp_20261106_01/`）。

### 9.5 独立端口模式

`port: 17820`、`token: standalone-secret` 下：`127.0.0.1:17820` 无 token **401**、带 token **200**；`/screen` 走同一 `handle()`，同样受保护。

---

## 10. 改动位置

```
/Users/liuzuodong/Documents/workspace/agent-display/dsh-agent-status/
├── index.js                 # 宿主插件：订阅、状态接口、SSE、注入、可选独立监听
├── package.json             # 1.3.0，dsh.bundle.patch，install/uninstall scripts
├── cordis.patch.yml         # bundle 默认插入行
├── lib/
│   ├── state.js             # 纯状态机（含 awaiting 判定、工具时间线、本轮耗时）
│   ├── auth.js              # token 提取、timing-safe 校验、loopback 判定
│   ├── config.js            # 配置归一化 + 大屏配置 + 客户端配置（剔除 token）
│   ├── screen.js            # 大屏 URL / HTML 组装（纯函数）
│   └── install.js           # 受管块 upsert/remove、package.json 合并/还原
├── runtime/
│   ├── hud.js               # Shadow DOM HUD、「大屏」入口、SSE+轮询、显隐/四角/拖拽
│   ├── hud.css              # HUD 主题与四角锚点
│   ├── screen.html          # 大屏骨架（__SCREEN_CSS__ / __SCREEN_JS__ / __SCREEN_CONFIG__）
│   ├── screen.css           # 大屏主题、总览/时间线/agent/事件流、空态、窄屏、galaxy 覆盖
│   ├── screen.js            # 大屏客户端：SSE→轮询→重连、暂停、等待、阶段闪光、主题开关
│   ├── nebula-core.js       # NEBULA 数据映射纯函数：槽位/阶段色/词序/计数器/雷达
│   └── nebula/
│       ├── template.html    # 源主题 05 的 board/HUD/面板（原样）
│       ├── theme.js         # 源主题 mountNebula（原样，仅换数据源）
│       └── vendor/          # three 0.147 + EffectComposer/RenderPass/ShaderPass/UnrealBloomPass
├── scripts/
│   ├── install.mjs          # 一键安装 + 首次备份 + 大屏参数（幂等）
│   ├── uninstall.mjs        # 跳过“已安装快照”备份 + 哈希校验还原（幂等）
│   ├── install.sh / uninstall.sh
├── tests/
│   ├── state.test.mjs
│   ├── auth.test.mjs
│   ├── install.test.mjs
│   ├── config.test.mjs
│   ├── screen.test.mjs
│   └── nebula.test.mjs
├── dev/mock-host.mjs        # 不启 Harness 的本地演示宿主
└── docs/deepseek-harness-plugin-plan.md  # 本文件
```

未改动：

- `/Applications/DeepSeek Harness.app` 及其 `app.asar`；
- `agent-display` 原有的 openclaw 实现；
- Harness 源码、profile 之外的任何系统文件。

---

## 11. 附录：关键宿主事实

- 版本：DeepSeek Harness **0.2.1-rc.5**；代码在 `Contents/Resources/app.asar` 内 `dsh/node_modules/@deepseek-ai/*`。
- 插件规范：`package.json` 带 `keywords: ["dsh-plugin"]` 可选，关键是 `dsh.bundle.patch` 指向 patch 层；插件导出 `apply(ctx, config)`。
- 注入：`ctx.on('webserver/index-inject', table => table.push({kind:'script', placement:'body', text}))`。
- 路由：`ctx.inject(['webServer'], child => child.effect(() => child.webServer.register({kind:'exact', path, handler})))`。
- 事件（订阅需 `{global:true}`）：`agent/status`、`agent/assistant-stream`、`agent/error`、`agent/created|disposed`、`session/event`（`turn/start|end`、`step/start|end`、`tool/call|result`、`approval/asked|decided`、`user/message`、`assistant/message` 等）。
- 桌面 profile 只能由 Electron 应用启动（CLI 会报 `profile "desktop" is managed exclusively by the Electron application`）。
- 桌面渲染页 origin 是 `dsh-app://app`，不是 http；真实随机端口由预加载脚本暴露在 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（例如 `http://127.0.0.1:63080`）。
- Electron 渲染进程的 `window.open` 被宿主接管：自建窗口被拒（返回 `null`），http(s) 目标交给系统默认浏览器；因此大屏入口必须用 GET 打开的 http(s) URL。
- 自定义协议页上的相对 `fetch` / `EventSource` 仍可访问插件路由（HUD 就是这样工作的）；但新窗口需要 http(s) origin。
- `webserver/index-inject` 注入表在宿主启动时快照，运行时修改 `runtime/hud.*` 不会热更新；`runtime/screen.*` 由 `/screen` 每次请求读取，可即时更新。
- 宿主页面已有 `dshDesktop` / `dshPlatform` bridge；`dshPlatform.open(page, bounds)` 只用于宿主内建页面（如账户页），不是通用 URL 打开器。
