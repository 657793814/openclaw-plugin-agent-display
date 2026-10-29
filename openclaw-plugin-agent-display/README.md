# agent作战大屏 · OpenClaw Plugin

把仓库根目录的 `index.html`（10 套主题的 Agent 战术大屏）接入 OpenClaw Control UI，并把主题核心数据绑定到真实 agents、sessions、channels、jobs、cases。原始大屏的视觉与动效不做改动；构建时读取并生成插件内的副本。

10 套主题全部接入真实数据。PARK 与 HQ 采用**双轨制**：3D 模拟循环继续运行保证观感，真实数据以约 5Hz 覆盖 KPI、Agent 名牌、任务池、部门统计、事件流和终端日志。

## 快速开始

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

或 Control UI：**Settings → Labs → Custom plugin UI**。然后刷新浏览器，在侧边栏打开 **agent作战大屏**。

## 实现方式

- **Feature Plugin**：注册原生 Control UI 页面与侧边栏入口。
- **Gateway HTTP Route**：`/plugins/agent-display/dashboard` 直接返回内嵌的大屏 HTML，避免 Control UI 的严格 CSP 拦截内联脚本。路由使用 `auth: "plugin"` + 进程内签名 URL，URL 只由已登录的 `info` RPC 签发。
- **同源 iframe**：页面用 iframe 承载大屏，通过 `postMessage` 接收真实数据。
- **实时数据适配层**：`host.request` + `host.onEvent` + `host.subscribe` 聚合 agents、sessions、channels、usage、cron、models 和实时消息，统一为 `DashboardSnapshot`（含 `stage` / `progress` / `source` / `workItems`）。
- **主题真实数据绑定**：`scripts/theme-data.js` 在前 8 套主题挂载前合并真实快照；真实 agent 优先占位，多余槽位显示待命，保留 Forge/Works 的 AGI 索引兼容。这 8 套主题的实体真实、KPI 与动画仍为模拟，且在主题挂载时取数。
- **PARK / HQ 运行时投影**：`projectPark()` / `projectHQ()` 把快照投影成车间、部门、项目、事件等领域模型；主题内用 `host.__dqApply` / `host.__dqPaint` 覆盖业务层，实体与 KPI 实时更新，3D 循环不动。
- **`live` 项目标记**：真实会话对应的项目不会被模拟逻辑自动重启或回收。
- **构建校验**：`embed-dashboard.mjs` 会检查 `THEMES` 中的每款主题都有对应的构建区间，并确认主题代码引用的每个 `__DQ_MERGE_*` 合并函数都在 `theme-data.js` 中定义；缺失时直接构建失败，避免装出一个空白主题。
- **大屏内实时浮层**：右下角 `OPENCLAW LIVE` 胶囊，显示真实指标、Agent 状态和事件流；首条数据到达时自动展开 5 秒。浮层可拖动、记住位置、自动避让、`Shift + 方向键` 微调，`↺` 复位。

完整方案、数据映射、限制和后续计划见 [docs/INTEGRATION.md](./docs/INTEGRATION.md)；分层架构、连接器契约与演进路线见 [docs/SYSTEM-DESIGN.md](./docs/SYSTEM-DESIGN.md)。

## 目录

```text
openclaw-plugin-agent-display/
├── scripts/
│   ├── embed-dashboard.mjs      # 读取 ../index.html，注入 theme-data/浮层，生成 TS 字符串
│   ├── theme-data.js            # 数据合并层 + PARK/HQ 投影（projectPark / projectHQ）
│   ├── dashboard-bridge.css     # 大屏内浮层样式
│   └── dashboard-bridge.js      # 大屏内浮层逻辑与 postMessage 接收器
├── src/
│   ├── index.ts                 # 后端：注册 Gateway HTTP 路由
│   ├── control-ui.ts            # 前端：页面、iframe、数据采集（stage/progress/workItems）
│   ├── contract.ts              # Feature contract（info 查询）
│   ├── shared.ts                # 共享常量与快照类型
│   ├── control-ui.css           # 页面容器样式
│   └── generated/               # 构建生成，不手改
├── docs/
│   ├── INTEGRATION.md           # 接入方案
│   └── SYSTEM-DESIGN.md         # 系统设计
└── openclaw.plugin.json
```

## 注意

- Native UI 运行受信任 JavaScript，拥有当前操作员的 Gateway 权限；只安装可信插件。
- 大屏路由使用 `auth: "plugin"` + 签名 token；token 由已登录 Control UI 的 `info` RPC 获取，只用于加载静态 HTML，不授予 Gateway RPC 权限。
- 浮层显示聚合数据，不展示密钥、token 或完整对话内容。
- 原 `index.html` 保持不变；`src/generated/dashboard-html.ts` 由 `npm run embed` 生成。
