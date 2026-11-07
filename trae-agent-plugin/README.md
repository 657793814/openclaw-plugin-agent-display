# NEBULA 作战大屏 · Agent 插件版

装进 `~/.trae-cn/plugins/` 的 **Trae agent 插件**（不是 IDE 扩展）。零 MCP 工具声明，不占每轮 token。

## 它是什么

- 一个 `bin/` 脚本包：`start.mjs` / `stop.mjs` / `status.mjs` / `server.mjs`
- 一个 skill：`skills/nebula-screen/SKILL.md`，让 agent 在用户说「打开大屏」时执行脚本
- 一套静态渲染资源：`assets/`（复用现有 `nebula` 那套，three.js + bloom，不重写视觉）
- 一个本地 HTTP 服务：只绑 `127.0.0.1`，带进程级随机 token

## 安装

```bash
cd ~/Documents/workspace/agent-display/trae-agent-plugin
bash install.sh
```

安装目标：`~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0/`
（结构与官方插件一致：`.trae-plugin/plugin.json` + `skills/` + `assets/` + `bin/`）

## 用户侧用法

### 在 Trae agent 里

```
打开 NEBULA 星核蜘蛛作战大屏
```

或：

```
看看大屏 / NEBULA 在跑吗 / 关掉大屏
```

agent 会执行：

```bash
node ~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0/bin/start.mjs --json --open
```

并把输出里的 `url` 交给你（浏览器会自动打开）。

### 手动命令（不依赖 agent）

```bash
P=~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0

node "$P/bin/start.mjs" --open      # 启动（已在跑则复用）并打开浏览器
node "$P/bin/status.mjs"            # 看是否在跑、端口、数据源状态
node "$P/bin/stop.mjs"              # 停止并清理运行时文件
```

## 进程模型

| 项 | 行为 |
|---|---|
| 启动 | `detached` 拉起 `server.mjs`，父进程退出后服务仍在 |
| 幂等 | 已有 `pid` 且 `/healthz` 通过 → 直接复用，打印现有 URL，不重复起进程 |
| 僵尸 pid | `pid` 不存活或端口不通 → 清掉残留 `state.json` 后重新启动 |
| 端口 | 默认 `41730`；`EADDRINUSE` 自动 +1 重试（最多 40 次），最终端口写入 `state.json` |
| 退出 | `SIGTERM` / `SIGINT` 时清理 `state.json` 并关服务器；`stop.mjs` 3 秒不退则 `SIGKILL` |
| 运行时文件 | `.runtime/state.json`（pid/port/token/url）、`.runtime/server.log` |

## 鉴权

1. 只监听 `127.0.0.1`（IPv4 回环），不绑 `0.0.0.0`。
2. 每次启动生成 24 字节随机 token（`crypto.randomBytes`），只写在本机 `state.json` 与 URL 查询参数里。
3. 服务端校验：`remoteAddress` 必须是回环地址，且 `Host` 必须是 `127.0.0.1` / `localhost`（防 DNS rebinding）。
4. 除 `/healthz` 外，所有路由都要 token（query `?token=` 或 `X-Agent-Status-Token` 头），比较用 `timingSafeEqual`。
5. 实测：无 token 访问 `/nebula-screen/api/state` → **401**；伪造 `Host` → **403**。
6. 路径前缀为 `/nebula-screen`；旧的 DeepSeek-Harness 前缀 `/dsh-agent-status/...` 仅保留 **302 跳转**（保留 token 查询串），不再在该前缀下提供服务。

## 数据源（不伪造）

两种只读数据源，启动时自动选择（`NEBULA_SOURCE=auto|hub|live` 可强制）：

1. **`hub_cache`**：`~/.trae-cn/hub_event_cache/TraeCode/<hubId>/*.jsonl`。写入方是 Trae 原生 Hub 桥，只有云端/Hub 链路激活时才有文件；纯本地安装会建目录但不落盘。
2. **`live_local`**（本机默认）：`ModularData/ai-agent/command-execution/<id>/execution.json`（真实命令执行：状态 / cwd / pid / 退出码 / 时间戳）+ `logs/<launch>/window<N>/renderer.log` 的 `plan_item`（会话 / task / 工具名 / agent 名）。前者没有命令文本，屏幕上只显示 `Shell · pid <n>` 与工作区目录名；后者用于会话归属。

`auto` 只有在 hub cache **今天确实有写入** 时才选 `hub_cache`，否则选 `live_local`。两种方式都不读 `database.db`，不接私有 IPC。

状态语义（`source.state`，`source.kind` 标明来源）：

- `live`：30s 内有新活动，或有正在运行的命令/对话事件
- `silent`：数据源存在但近期无活动 → 大屏显示等待态，**不会编造 agent / 事件**
- `offline`：数据源目录不存在

## 多会话 / 多项目

- **读取范围**：`hub_cache` 读 `~/.trae-cn/hub_event_cache/TraeCode/<hubId>/*.jsonl` 整个目录；`live_local` 读全部近 15 分钟的 `execution.json` 与最新一次启动的 renderer 日志。
- **分组键 `groupId`**：
  - `hub_cache`：聊天 `session_id` → hub 目录名 `hubId` → `task_id`；
  - `live_local`：一个工作区目录 = 一个 agent（`groupId = ws:<cwd>`，标签为目录名），renderer 事件按聊天 `session_id` 分组。
- **项目归属**：hub 事件没有 project / workspace 字段；`live_local` 只用真实 `cwd` 目录名，**不臆造项目名**。界面因此只做会话级筛选。
- **界面**：宽屏筛选条嵌在主题 `board` 的左侧空白区（TASK/HOST 块下方、底部面板上方），随版式等比缩放，**不覆盖任何面板**；窄屏（`.mini` 布局）改用一条可横向滚动的紧凑会话条，作为 mini 列里的独立行插在标题与底部统计之间，同样不遮挡内容。会话数为 **0 或 1** 时不显示切换控件。点「全部」或某个会话，只看该组的 agent / 工具 / 事件；**「累计完成」跟随选中会话**，切回「全部」恢复全局值。芯片文字截断显示，悬停可看完整会话名 / 工作区目录。
- **API**：`GET /nebula-screen/api/state?token=…&group=<groupId>` 只返回该组 agents/events；`sessions[]` 始终完整，便于做切换器。
- **不串线**：不同会话的 `task_id` 各自成 agent 记录，timeline 不会互相合并；同一会话内多个 task 会各占一个槽。

## token 成本

- **本方案：0**。插件 manifest 没有 `mcpServers`，每个请求的工具列表不增加任何 schema。
- skill 的 `description` 只有一行常驻；正文 `SKILL.md` 仅在用户触发该技能时载入。
- 反例：如果以后加 MCP server，即使只有 2 个工具，每轮请求也要多付约 **200–400 token** 的 schema。

### 可选（当前未实现）：精简 MCP server

如果要让 agent 直接查状态而不执行脚本，可加一个只暴露 `nebula_status` / `nebula_open` 的 MCP server。
代价：每轮请求 +200–400 token schema；收益：agent 不用跑 shell。按需再开。

## 开机自启（可选，launchd）

创建 `~/Library/LaunchAgents/com.nebula-lab.nebula-screen.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nebula-lab.nebula-screen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>/Users/liuzuodong/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0/bin/start.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

加载 / 卸载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nebula-lab.nebula-screen.plist
launchctl bootout gui/$(id -u)/com.nebula-lab.nebula-screen
rm ~/Library/LaunchAgents/com.nebula-lab.nebula-screen.plist
```

注意：launchd 拉起的是 `start.mjs`，它会立刻退出（服务是 detached 的），所以 launchd 不会托管常驻进程；要真正的守护需把 `ProgramArguments` 直接指向 `server.mjs`。

## 卸载

```bash
bash uninstall.sh
```

或手动：

```bash
node ~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0/bin/stop.mjs
rm -rf ~/.trae-cn/plugins/nebula-lab
```

不会动 `~/.trae-cn/extensions/` 下已装的 IDE 扩展。

## 已知限制

- 手工放进 `~/.trae-cn/plugins/` 的目录是否被 agent 立即识别，取决于 Trae 的插件扫描时机；本次未重启 Trae 验证，通常需要重载窗口 / 重开面板或重启 Trae。
- hub cache 今日无写入（0 个 `.jsonl`），所以大屏目前是 `SILENT` 空态；这是事实，不是故障。
- 无 slash command：manifest 里没有 `commands` 字段，skill 是唯一确定入口。
