# dsh-agent-status

DeepSeek Harness 的只读 agent 工作状态 HUD **与独立「作战大屏」**。订阅宿主真实事件流，折叠成一份快照：右下角 HUD 显示 **空闲 / 思考 / 调工具 / 等待确认 / 等待输入 / 完成 / 失败**，HUD 上的「大屏」入口可打开插件路由 `/dsh-agent-status/screen` 的完整可视化。大屏支持 `neon`（默认）/ `mono` / `galaxy`（NEBULA 星核蜘蛛）三种主题。

- 只读：不写会话、不改 Harness 源码或 asar、不拦截工具调用。
- 零额外进程：作为普通 Cordis 插件跑在宿主进程里，HTTP + SSE 复用宿主 `webServer`。
- 注入式前端：`webserver/index-inject` 插入一段 Shadow DOM 脚本，无需改 React 客户端。
- 安全：状态接口与 `/screen` 都强制 token（Bearer / `X-Agent-Status-Token` / `?token=`）；只接受 loopback；页面只拿到每进程 ticket，不含安装 token；大屏不展示对话正文与完整工具参数。

## 安装 / 卸载

```bash
cd dsh-agent-status

node scripts/install.mjs       # 安装到 ~/.dsh/profiles/desktop，自动备份、幂等
node scripts/uninstall.mjs     # 从安装前备份完整还原

# 指定 profile / 隔离测试
node scripts/install.mjs --home /tmp/dsh-home --profile-dir /tmp/dsh-home/profiles/verify
node scripts/uninstall.mjs --home /tmp/dsh-home --profile-dir /tmp/dsh-home/profiles/verify
```

安装后**完全退出并重启 Harness**（`Cmd+Q` 再打开）。桌面壳在启动时快照注入表，修改 `runtime/hud.js|css` 后同样需要重启；`/screen` 页面每次请求现拼，修改 `runtime/screen.*` 不需要重启。

备份位置：`$DSH_HOME/backups/dsh-agent-status/<时间戳>/`（`manifest.json` + profile 快照）。
更新安装会复用首次安装前的备份，不会用“已安装快照”覆盖；卸载按备份逐文件还原并校验 SHA-256；若只有含受管块的旧备份，会跳过并退化为外科式移除。

常用安装参数：`--token`、`--port`、`--theme neon|mono`、`--screen-theme neon|mono|galaxy`、`--position bottom-right|top-right|bottom-left|top-left`、`--hidden`、`--screen-button true|false`、`--no-screen-button`、`--screen-landing hud|screen`、`--screen-window tab|window`、`--waiting-after-ms`、`--done-hold-ms`、`--poll-ms`。

开启 NEBULA 星核蜘蛛主题：

```bash
node scripts/install.mjs --screen-theme galaxy
# 只想临时预览、不改 profile：
open "http://127.0.0.1:<端口>/dsh-agent-status/screen?token=<token>&theme=galaxy"
```

## 使用

- `×` 隐藏 HUD（保留圆形气泡，点击恢复）；`Alt+Shift+H` 切换显隐。
- `⇅` 在四角之间切换；拖拽标题栏可自由摆放。
- `–/+` 折叠。
- 标题栏的青色「大屏」按钮：在**新标签 / 新窗口**打开作战大屏；HUD 保留。
- 偏好写入 `localStorage`：`dsh-agent-status.visible|collapsed|anchor|pos`，刷新与重启后自动恢复。

## 作战大屏

- 入口：HUD 标题栏「大屏」按钮（受 `screenButton` 控制），或直接访问
  `http://127.0.0.1:<宿主端口>/dsh-agent-status/screen?token=<安装 token>`。
- 地址规则：HUD 用当前页面的真实 HTTP origin 动态拼。桌面壳的页面 origin 是 `dsh-app://app`，但宿主在 `__DSH_TRANSPORT__.streamBaseUrl` 暴露了随机端口，HUD 优先取它；mock / 浏览器环境回退 `location.origin`。**不写死端口**。
- 数据：与 HUD 同一份快照，来自真实事件（`agent/status`、`agent/assistant-stream`、`agent/error`、`session/event` 等）；不使用 `index.html` 的模拟引擎。
- 布局：顶部总览（阶段 / agent / 连接 / 轮次 / 本轮耗时 / tokens / 工具数）→ 左侧工具调用与结果时间线 → 右侧多 agent 阵列（点击过滤）→ 底部最近事件流。
- 连接：SSE 优先；断线自动回退 `pollMs` 轮询，并每 5s 重试 SSE，恢复后自动切回实时。右上角显示 `实时 SSE / 轮询回退 / 连接中断 / 鉴权失败`。
- 交互：`暂停刷新` 冻结画面（保留最后快照），`继续刷新` 应用待处理快照；阶段切换有闪光反馈；超过 `waitingAfterMs` 无事件显示「等待中 · 无新事件」。
- 安全：`/screen` 与 API 同样先鉴权，匿名直连返回 `401` JSON；页面只显示工具名、截断参数摘要（≤90 字）和结果摘要（≤80 字），不显示对话正文与完整工具参数。

## NEBULA「星核蜘蛛」主题（`screenTheme: galaxy`）

可选主题，默认仍是 `neon`。视觉取自 `agent-display/index.html` 的主题 **05 · NEBULA 星核蜘蛛**（源文件里没有名为「星河蜘蛛」的主题；匹配依据是模板 `#tpl-nebula`、渲染函数 `mountNebula` 与注释「星核蜘蛛」）。**原样还原，不是重画**：

- `runtime/nebula/template.html` ← 源文件 1118–1397 行（HTML + CSS），只改了 HUD 文案；
- `runtime/nebula/theme.js` ← 源文件 8780–9943 行（约 1290 行），只替换了第 3 节模拟引擎与少量 HUD 数值来源；渲染层、three.js 管线（EffectComposer + UnrealBloomPass + PT/RB/LEG/ST 着色器）、12 团星云的粒子算法、丝带星核、星云蛛、触须/丝线、相机与动效参数、配色与字体全部沿用原值；
- `runtime/nebula/vendor/` ← three 0.147 与官方 postprocessing 插件本地化，离线可用，不走 CDN；
- 模板挂在 Shadow DOM（`.nebula-host`），1920×1080 board 按 `--s` 等比缩放，与原版相同的 `ResizeObserver` / 画布尺寸换算。

**数据槽位映射（真实事件 → 原主题结构，不造数据）**

| 原主题结构 | 真实数据 | 说明 |
| --- | --- | --- |
| `AG[0]` CHIEF 丝带星核 | 宿主进程 | 星核状态字 = `LISTENING / WAITING / NO AGENT / PAUSED / OFFLINE / AUTH 401 / SILENT` |
| `AG[1..12]` 十二团星云 | `snapshot.agents[]` | 按 `agent.id` 粘滞分配槽位（≤12）；空槽保持 IDLE 中性，不虚构 agent |
| `AG[13]` CRAWLER 星云蛛 | 只读巡检蛛 | 只沿真实调用移动，不参与任何调度 |
| `task.sections[]` | 每个真实 agent 的调用分组 | 只有存在 agent 的槽位才生成 section |
| `section.words[]` | `agent.timeline` 末 14 条（转时间正序） | 词 = 一次真实工具调用，固定词位、缺位留空 |
| `word.state` | `entry.status` + 阶段 | `read` 已读/进行中、`flag` 错误、`ask` 等确认、`fix` 完成 |
| `word.w / fix` | `entry.name` / `durationMs`、`result` | 云上文字标签叠工具名与真实耗时/结果 |
| `load[] / flash[]` | `agent.phase` + 调用事件 | idle .14 / thinking .58 / tool .94 / done .70 / failed .66；阶段切换闪一下 |
| `logs[]`、`CRAWLER.PY` | `snapshot.events[]` | 每行都是真实会话事件文本，不是模拟脚本 |
| `crawl.phase` | 数据状态机 | brief → walk → read → ship → rest，只由真实调用/结果推动 |

- **拓扑语义**：12 团星云各是一个真实 agent，星云蛛在它们之间跳跃读调用；宿主事件里**没有 agent→agent 委派/父子关系**，所以画面不画任何 agent 间连线。「ship / 回星核」只是读完回汇总的视觉动作，不代表派单关系；连线只出现在「当前 agent 云 → 工具词」与星核归属。
- **脉冲只跟真实调用**：`tool/call` 新增 → 连线读词脉冲；`running → ok/error` → 结果流光；`waiting/awaiting` → 金色等确认。首帧只建基线不回放；暂停恢复的 resync 不补播；队列里超过 8s 的旧动画丢弃。
- **主题切换**：安装参数 `--screen-theme galaxy`，或 URL `?theme=galaxy`；页面顶部「主题」按钮在 `galaxy ↔ neon` 间切换（改 `?theme=` 后重载），`P` 暂停/继续数据刷新。关闭：`--screen-theme neon` 重装或 `?theme=neon`。
- **性能（沿用原主题原值，不为性能削减画面）**：DPR 上限 1.75；1 秒窗口 FPS < 30 连续 3 次时，DPR → 1 → 0.75 → 关闭 bloom composer；页面/宿主隐藏时 rAF 停止推进；粒子规模与原版一致（每团星云 3400 / 纤维团 1900 + 纤维、星核 24 条丝带 ×220 段、轨道 900×3、星尘 1600、星空 2600、星云蛛 4700）；信息 chip 上限 44。
- **显式状态**：连接中 `WAITING`、正常静默 `SILENT`、空列表 `NO AGENT · 等待 Harness 会话`、断线 `OFFLINE`、401 `AUTH 401`、暂停 `PAUSED`，面板同步显示，不空转像死机。
- **已知限制**：相机取景由真实 agent 占用的槽位决定（内圈云离星核更近，星核看起来更大），与原模拟数据的取景不总是同角度；空槽/中性槽显示 IDLE，不编名字；没有后端历史回放，页面打开前的调用只落终态、不补脉冲；agent 完全没有调用时星云蛛留在该云表面游走（按云半径），不会空转或消失；窄屏/竖屏（宽 <760px 或宽高比 <1.05）沿用原版精简条，不显示 1920 board。

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /dsh-agent-status/api/state` | 当前快照 JSON（需 token） |
| `GET /dsh-agent-status/stream` | SSE（`event: state`，需 token），断线回退 800ms 轮询 |
| `GET /dsh-agent-status/screen` | 作战大屏 HTML（需 token；匿名 401） |
| `GET /demo/:phase` | 仅 mock host：`idle` `thinking` `tool` `waiting` `done` `failed` `auto`，以及 `multi`（3 个真实 agent + 工具/等确认）、`pulse`（触发一次真实工具调用）、`blackout` / `blackout-off`（断线与恢复） |

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/dsh-agent-status/api/state
curl -N "http://127.0.0.1:$PORT/dsh-agent-status/stream?token=$TOKEN"
open "http://127.0.0.1:$PORT/dsh-agent-status/screen?token=$TOKEN"
```

## 本地演示（不启动 Harness）

```bash
node dev/mock-host.mjs          # http://127.0.0.1:17817
```

预览页右下角是 HUD，左下角 DEMO 按钮强制切换阶段；mock host 复用真实插件的 `apply(ctx)`。点 HUD「大屏」按钮可验证入口、SSE 时间线与断线重连。验证 galaxy 主题可直接访问 `/dsh-agent-status/screen?token=<ticket>&theme=galaxy`，先请求 `/demo/multi` 造出 3 个真实 agent，再用 `/demo/pulse` 观察工具脉冲。

## 测试

```bash
node --test tests/*.test.mjs    # 50 项：状态机 / timeline / token / 配置 / 安装纯函数 / 大屏渲染 / NEBULA 数据映射纯函数
```

## 已知限制

- `awaiting`（等待输入）是基于 `turn/end` 的启发式判定，宿主没有专用事件。
- 注入脚本在宿主启动时快照，HUD 前端更新必须重启；`screen.*` 按请求现拼，不需要。
- 桌面 Harness 禁止渲染进程 `window.open` 自建窗口，http(s) 目标会交给**系统默认浏览器**打开大屏；浏览器弹窗策略可能拦截「默认落地页」的自动打开。
- 大屏 URL 含每进程 ticket（重启 Harness 后旧 URL 失效），请从 HUD 入口重新打开。
- galaxy 主题不画 agent→agent 连线：宿主没有委派/父子事件，只有「宿主→agent→工具」的真实关系；脉冲只对页面打开后发生、且队列未超时（≤8s）的调用可见，断线期间发生的调用恢复后不会补播动画。
- galaxy 主题沿用原版的窄屏行为：宽 <760px 或宽高比 <1.05 时隐藏 1920 board，改为顶部标题 + 底部三格统计的精简条。
- 卸载是全量还原，会覆盖安装后对 profile 配置的其它手工修改（若只有含受管块的旧备份则退化为外科式移除）。
- 事件名与 payload 属于 Harness 0.2.1-rc.5 的内部契约，升级后需复核。

完整落地文档见 [docs/deepseek-harness-plugin-plan.md](../docs/deepseek-harness-plugin-plan.md)。
