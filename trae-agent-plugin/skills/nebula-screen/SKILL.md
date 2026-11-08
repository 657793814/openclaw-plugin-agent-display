---
name: nebula-screen
version: 0.1.0
description: "打开 / 关闭 / 查询本机的「星核蜘蛛 NEBULA」智能体作战大屏。用户说「打开大屏」「看看星核蜘蛛」「NEBULA 在跑吗」「大屏状态」时使用。零 MCP 工具，不产生额外 token。"
metadata:
  requires:
    bins: ["node"]
  cliHelp: "node ~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0/bin/status.mjs --json"
---

# NEBULA 作战大屏（本地服务版）

本技能不注册任何 MCP 工具。它只做三件事：起一个本地 HTTP 服务、把可访问 URL 交给用户、必要时关掉。

插件根目录（下称 `$PLUGIN`）：

```
$PLUGIN = ~/.trae-cn/plugins/nebula-lab/nebula-screen/0.1.0
```

## 用户说「打开大屏」时

1. 先查状态（很快，不启动任何东西）：

```bash
node "$PLUGIN/bin/status.mjs" --json
```

2. 如果 `running` 为 `false`，启动并自动打开浏览器：

```bash
node "$PLUGIN/bin/start.mjs" --json --open
```

3. 如果已经 `running`，直接复用，只打开浏览器：

```bash
node "$PLUGIN/bin/start.mjs" --json --open
```

`start.mjs` 的行为保证幂等：已在跑就打印现有 URL，不会重复起进程。

4. 把命令输出里的 `url` 原样交给用户，并说明：
   - `source.kind = "live_local"`：读本机 `command-execution` + 最新 `renderer.log`（默认；hub cache 在本机不落盘）
   - `source.kind = "hub_cache"`：读 `hub_event_cache`（仅当最近 15 分钟内有写入；运行中超时自动降级到 `live_local`）
   - `source.state = "live"`：有实时事件 / 有正在运行的命令
   - `source.state = "silent"`：数据源存在但近期无活动，大屏会显示 `SILENT`，**不要**说成「正常运行」
   - `source.state = "offline"`：数据源目录不存在

页面左上角有 `SESSION · N 并行` 筛选条：多会话（多项目）并跑时，点某一组即可只看该会话。`live_local` 的 workspace 组只显示真实 `cwd` 目录名（`W·…`），hub cache 事件里没有项目归属字段，所以只能做到会话级标识，不要声称按项目筛选。芯片文字被截断，悬停可看完整名称；「累计完成」跟随当前选中会话。

## 用户说「关掉大屏」时

```bash
node "$PLUGIN/bin/stop.mjs"
```

## 重要约束

- 不要读取 `~/.trae-cn/database.db`，不要调用 Trae 私有 IPC。
- 服务只绑定 `127.0.0.1`，URL 里带 token；token 随该服务进程有效（重启会换新 token），只写在本机 `.runtime/state.json`（权限 `0600`）。不要把带 token 的完整 URL 或日志贴到公开渠道；旧链接失效时重新执行 `start.mjs --open`。
- 端口冲突时脚本会自动退让到下一个可用端口，最终端口写在 `$PLUGIN/.runtime/state.json`，不要自己猜端口。
- 渲染层复用现有 `nebula` 资源，不要改视觉。
